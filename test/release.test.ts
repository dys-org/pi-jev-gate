import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIntentTracker, handleToolCall } from "../src/extension.ts";
import { judgeWithJev } from "../src/jev.ts";
import { classifyToolCall, type GatedCall } from "../src/policy.ts";
import { approvingResult, registry } from "./fixtures.ts";

const cwd = "/project";
const bash = (command: string) => ({ toolName: "bash", input: { command } });
const flagged: GatedCall = { tool: "bash", command: "git push origin feature", summary: "push", outsideCwd: false, reasons: ["Git remote mutation"] };
const context = { cwd, intent: "Push my feature branch", isGitRepository: true };

describe("release regressions (metadata only)", () => {
  it("asks intent only for recognized risks and preserves override/veto boundaries", async () => {
    for (const [command, asked] of [["echo unrelated", false], ["git push origin feature", true], ["npm publish", true]] as const) {
      const local = classifyToolCall(bash(command), cwd);
      assert.equal(local.action, "judge");
      if (local.action !== "judge") throw new Error("expected judge");
      const modelRegistry = registry({ classify: async (model, request) => {
        assert.equal("intent_coverage" in request.questions, asked);
        return approvingResult(model, request, { intent_coverage: 0.4 });
      } });
      assert.equal((await judgeWithJev(local.call, context, { provider: "typesafe", modelRegistry })).kind, asked ? "deny" : "allow");
    }
    for (const rule of ["local_scope", "no_irreversible_damage", "no_outward_effect"]) {
      for (const p of [0.4, 0.49, 0.5, 0.51]) {
        const modelRegistry = registry({ classify: async (model, request) => approvingResult(model, request, { intent_coverage: p, [rule]: 0.01 }) });
        assert.equal((await judgeWithJev(flagged, context, { provider: "typesafe", modelRegistry })).kind, p >= 0.5 ? "allow" : "deny");
      }
    }
    for (const rule of ["no_secret_egress", "prompt_injection_absent", "path_not_protected", "no_fetched_code_execution"]) {
      const call = { ...flagged, tool: "write" as const, reasons: ["downloaded script execution"] };
      const modelRegistry = registry({ classify: async (model, request) => approvingResult(model, request, { intent_coverage: 0.99, [rule]: rule === "no_fetched_code_execution" ? 0.5 : 0.01 }) });
      assert.equal((await judgeWithJev(call, context, { provider: "typesafe", modelRegistry })).kind, "deny", rule);
    }
    const modelRegistry = registry({ classify: async (model, request) => approvingResult(model, request, { no_outward_effect: 0.01 }) });
    assert.equal((await judgeWithJev({ ...flagged, reasons: ["not a trusted development command"] }, context, { provider: "typesafe", modelRegistry })).kind, "deny");
  });

  it("does not let a soft override clear required fetched-code uncertainty", async () => {
    const call = { ...flagged, reasons: ["downloaded script execution"] };
    const modelRegistry = registry({ classify: async (model, request) => approvingResult(model, request, {
      intent_coverage: 0.99, no_outward_effect: 0.01, no_fetched_code_execution: 0.5,
    }) });
    const verdict = await judgeWithJev(call, context, { provider: "typesafe", modelRegistry });
    assert.equal(verdict.kind, "deny");
    assert.match(verdict.reason, /no_fetched_code_execution.*uncertain/);
  });

  it("grounds only the selected item and retains user qualifications/cancellation", async () => {
    const tracker = createIntentTracker();
    tracker.recordAssistant("1. npm publish --access public\n2. git push origin feature");
    tracker.record("do #2? No, do not run anything; just explain", "interactive");
    assert.equal(tracker.referencedProposal(), "2. git push origin feature");
    const modelRegistry = registry({ classify: async (model, request) => {
      const value = request.state.value as Record<string, unknown>;
      assert.equal(value.referenced_assistant_proposal, "2. git push origin feature");
      assert.equal(value.user_intent, "do #2? No, do not run anything; just explain");
      assert.equal(JSON.stringify(request).includes("npm publish"), false);
      return approvingResult(model, request, { intent_coverage: 0.4 });
    } });
    assert.equal((await handleToolCall(bash(flagged.command!), { cwd, intent: tracker.value(), referencedProposal: tracker.referencedProposal(), modelRegistry }, { provider: "typesafe" }))?.block, true);
    tracker.recordAssistant("1. Inspect\n2. git reset --hard HEAD");
    tracker.record("do 2; I have backed up my work", "rpc");
    assert.equal(tracker.value().endsWith("do 2; I have backed up my work"), true);
    assert.equal(tracker.referencedProposal(), "2. git reset --hard HEAD");
  });

  it("rejects preamble, trailing restrictions, indentation, and incomplete/ambiguous references", async () => {
    for (const [assistant, user] of [
      ["Only inspect; do not push.\n1. Inspect\n2. Push", "do 2"],
      ["Options:\n1. Inspect\n2. Push", "do 2"],
      ["1. Inspect\n  2. Push", "do 2"],
      ["  1. Inspect\n  2. Push", "do 2"],
      ["1. Inspect\n\t2. Push", "do 2"],
      ["1. Inspect\n2. Push\nOnly after approval", "do 2"],
      ["1. Inspect\n2. Push\n  only after approval", "do 2"],
      ["2. Inspect\n2. Push", "do 2"],
      ["1. Inspect\n2.", "do 2"],
      ["1. Inspect\n2. Push", "do 9"],
      ["1. Inspect\n2. Push", "run it"],
      ["1. Inspect\n2. Push", "go with that"],
      ["", "try #2"],
      ["", "use 2"],
      ["1. Inspect\n2. Push", "do 2 and 1"],
      ["1. Inspect\n2. Push", "do 2, #1"],
      [`1. ${"x".repeat(1300)}\n2. Push`, "do 2"],
    ]) {
      const tracker = createIntentTracker();
      tracker.recordAssistant(assistant!);
      tracker.record(user!, "interactive");
      assert.equal(tracker.referencedProposal(), "", assistant);
      assert.equal(tracker.intentIncomplete(), true, user);
      assert.equal(tracker.value(), user);
      const modelRegistry = registry({
        findOfType: () => { assert.fail("unresolved intent must not discover classifiers"); },
        classify: async (model, request) => approvingResult(model, request),
      });
      const ctx = { cwd, intent: tracker.value(), intentIncomplete: tracker.intentIncomplete(), modelRegistry };
      assert.equal((await handleToolCall(bash("git push origin feature"), ctx, { provider: "typesafe" }))?.block, true);
      ctx.modelRegistry = registry({ classify: async (model, request) => {
        assert.equal(request.questions.intent_coverage, undefined);
        return approvingResult(model, request);
      } });
      assert.equal(await handleToolCall(bash("echo harmless"), ctx, { provider: "typesafe" }), undefined);
    }
  });

  it("does not treat ordinary explicit requests as unresolved shorthand", () => {
    const tracker = createIntentTracker();
    for (const text of ["run tests", "use npm publish", "try git push origin feature", "do the inspection", "go with public access"]) {
      tracker.record(text, "interactive");
      assert.equal(tracker.intentIncomplete(), false, text);
    }
  });

  it("keeps the latest bounded context and invalidates consumed or stale assistant candidates", () => {
    const tracker = createIntentTracker();
    tracker.record("a".repeat(1000), "interactive");
    tracker.record("b".repeat(1000), "interactive");
    tracker.record("Do not publish. " + "c".repeat(984), "rpc");
    assert.ok(tracker.value().endsWith("Do not publish. " + "c".repeat(984)));
    assert.ok(tracker.value().length <= 2400);
    tracker.recordAssistant("1. Inspect\n2. Push");
    tracker.recordAssistant("");
    tracker.record("do 2", "interactive");
    assert.equal(tracker.referencedProposal(), "");
    tracker.recordAssistant("1. Inspect\n2. Push");
    tracker.record("generated", "extension");
    tracker.record("do 2", "interactive");
    assert.equal(tracker.referencedProposal(), "");
    tracker.recordAssistant("1. Inspect\n2. Push");
    tracker.record("do 2", "interactive");
    tracker.record("do 2", "interactive");
    assert.equal(tracker.referencedProposal(), "");
    tracker.clear();
    assert.equal(tracker.value(), "");
    assert.equal(tracker.referencedProposal(), "");
  });

  it("never authorizes flagged calls using a clipped latest user prefix", async () => {
    const tracker = createIntentTracker();
    tracker.record("Push my branch", "interactive");
    tracker.recordAssistant("1. Inspect\n2. Push");
    tracker.record(`do 2 ${"x".repeat(1000)} No, do not push`, "rpc");
    assert.equal(tracker.intentIncomplete(), true);
    assert.equal(tracker.referencedProposal(), "");
    assert.equal(tracker.value().includes("do 2"), false);
    let dispatched = false;
    const modelRegistry = registry({ findOfType: () => { dispatched = true; assert.fail("unexpected discovery"); } });
    const ctx = { cwd, intent: tracker.value(), intentIncomplete: tracker.intentIncomplete(), modelRegistry };
    assert.equal((await handleToolCall(bash(flagged.command!), ctx, { provider: "typesafe" }))?.block, true);
    assert.equal(dispatched, false);
    ctx.modelRegistry = registry({ classify: async (model, request) => {
      assert.equal(request.questions.intent_coverage, undefined);
      return approvingResult(model, request);
    } });
    assert.equal(await handleToolCall(bash("echo harmless"), ctx, { provider: "typesafe" }), undefined);
    assert.equal((await judgeWithJev(flagged, { ...context, intent: "x".repeat(3001) }, { provider: "typesafe", modelRegistry })).kind, "deny");
    tracker.record("Inspect status only", "interactive");
    assert.equal(tracker.intentIncomplete(), false);
    tracker.clear();
    assert.equal(tracker.intentIncomplete(), false);
  });

  it("tests requested, unrequested, wrong-option, and compound pushes together", async () => {
    for (const [user, command, p, kind] of [
      ["git push origin feature", "git push origin feature", 0.5, "allow"],
      ["Inspect only", "git push origin feature", 0.4, "deny"],
      ["do 2", "git push origin feature", 0.1, "deny"],
      ["do 2", "echo probe && git push origin feature", 0.1, "deny"],
    ] as const) {
      const local = classifyToolCall(bash(command), cwd);
      assert.equal(local.action, "judge");
      if (local.action !== "judge") throw new Error("expected judge");
      assert.ok(local.call.reasons.includes("Git remote mutation"));
      const modelRegistry = registry({ classify: async (model, request) => {
        assert.ok(request.questions.intent_coverage);
        assert.equal((request.state.value as Record<string, unknown>).command, command);
        return approvingResult(model, request, { intent_coverage: p, no_outward_effect: 0.01 });
      } });
      assert.equal((await judgeWithJev(local.call, { ...context, intent: user, referencedProposal: "2. Run echo probe" }, { provider: "typesafe", modelRegistry })).kind, kind);
    }
  });

  it("evaluates registry mutations and mutating inspection flags without weakening local inspection", () => {
    for (const command of ["npm unpublish pkg", "npm dist-tag add pkg@1 latest", "npm owner add user pkg", "npm access set status=public pkg", "npm deprecate pkg old", "pnpm unpublish pkg", "yarn npm publish", "find . -exec touch out +", "find . -fprint out", "sort input -o out", "sort --output=out input", "xxd -r input out", "git diff --output=out", "git remote add origin https://example.test/repo", "rg --pre touch pattern", "uniq input out", "date --set=tomorrow", "hostname replacement"]) {
      const local = classifyToolCall(bash(command), cwd);
      assert.equal(local.action, "judge", command);
      if (local.action === "judge") assert.equal(local.call.reasons.includes("not a trusted development command"), false, command);
    }
    for (const command of ["find . -type f", "sort input", "git remote -v", "git diff", "rg pattern src", "pnpm test"]) assert.equal(classifyToolCall(bash(command), cwd).action, "allow", command);
  });

  it("hard-denies protected force refspecs while retaining extension-tampering denials", () => {
    for (const branch of ["main", "master", "production", "prod"]) {
      for (const ref of [`+${branch}`, `+refs/heads/${branch}`, `+HEAD:${branch}`, `+feature:refs/heads/${branch}`]) assert.equal(classifyToolCall(bash(`git push origin ${ref}`), cwd).action, "deny", ref);
    }
    assert.equal(classifyToolCall(bash("git push origin +HEAD:feature"), cwd).action, "judge");
    assert.equal(classifyToolCall(bash("mv ~/.pi/agent/extensions/other.ts /tmp/other.ts"), cwd).action, "deny");
    assert.equal(classifyToolCall({ toolName: "edit", input: { path: "/home/user/.pi/agent/extensions/other.ts" } }, cwd).action, "deny");
  });

  it("refuses truncated evaluated commands before classifier discovery", async () => {
    const command = `echo ${"x".repeat(4000)} && git push origin feature`;
    const modelRegistry = registry({ findOfType: () => { assert.fail("unexpected discovery"); } });
    assert.equal((await handleToolCall(bash(command), { cwd, modelRegistry }, { provider: "typesafe" }))?.block, true);
    assert.equal((await judgeWithJev({ ...flagged, command }, context, { provider: "typesafe", modelRegistry })).kind, "deny");
    assert.equal(classifyToolCall(bash(`echo ${"x".repeat(3995)}`), cwd).action, "judge");
    assert.equal(classifyToolCall(bash(`pnpm test ${"x".repeat(4100)}`), cwd).action, "allow");
  });
});
