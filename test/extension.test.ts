import "./isolate.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StopReason } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import jevGate, { createGateControl, createIntentTracker, handleToolCall, type GateContext } from "../src/extension.ts";
import { PROVIDERS } from "../src/config.ts";
import { approvingResult, registry, said } from "./fixtures.ts";

function context(intent = ""): GateContext {
  return {
    cwd: "/Users/dev/project",
    intent: said(intent),
    modelRegistry: registry(),
    signal: undefined,
  };
}

describe("Pi tool-call integration", () => {
  it("keeps ordinary work entirely local", async () => {
    const ctx = context();
    ctx.modelRegistry.findOfType = () => { assert.fail("unexpected classifier discovery"); };
    assert.equal(await handleToolCall({ toolName: "bash", input: { command: "git status" } }, ctx), undefined);
    assert.equal(await handleToolCall({ toolName: "bash", input: { command: "pnpm test" } }, ctx), undefined);
    assert.equal(await handleToolCall({ toolName: "write", input: { path: "src/a.ts", content: "x" } }, ctx), undefined);
    assert.equal(await handleToolCall({ toolName: "read", input: { path: "/var/folders/x/T/image.png" } }, ctx), undefined);
  });

  it("blocks hard denials before classifier discovery or authentication", async () => {
    let discovered = false;
    const ctx = context();
    ctx.modelRegistry.findOfType = () => { discovered = true; return undefined; };
    const result = await handleToolCall({ toolName: "bash", input: { command: "rm -rf /" } }, ctx);
    assert.equal(result?.block, true);
    assert.equal(discovered, false);
  });

  it("invokes Pi classification from the interception path for every selected provider", async () => {
    for (const provider of PROVIDERS) {
      const calls: string[] = [];
      const ctx = context("push my feature branch");
      ctx.modelRegistry.classify = async (model, state) => { calls.push(model.provider); return approvingResult(model, state); };
      assert.equal(await handleToolCall({ toolName: "bash", input: { command: "git push origin feature" } }, ctx, { provider }), undefined);
      assert.deepEqual(calls, [provider]);
    }
  });

  it("fails closed on missing classifiers and authentication failures, without fallback", async () => {
    for (const provider of PROVIDERS) {
      const requested: string[] = [];
      const ctx = context();
      ctx.modelRegistry.findOfType = (_type, selected) => { requested.push(selected); return undefined; };
      assert.equal((await handleToolCall({ toolName: "bash", input: { command: "git push origin feature" } }, ctx, { provider }))?.block, true);
      assert.deepEqual(requested, [provider]);
      const classified: string[] = [];
      ctx.modelRegistry = registry({ classify: async (model, state) => {
        classified.push(model.provider);
        return { ...approvingResult(model, state), stopReason: "error", answers: {}, errorMessage: "No API key configured" };
      } });
      const result = await handleToolCall({ toolName: "bash", input: { command: "git push origin feature" } }, ctx, { provider });
      assert.equal(result?.block, true);
      assert.deepEqual(classified, [provider]);
      assert.match(result?.reason ?? "", /could not make a decision/);
    }
  });

  it("turns classifier rejection into a final blocked tool call", async () => {
    const ctx = context();
    ctx.modelRegistry.classify = async (model, state) => approvingResult(model, state, { no_secret_egress: 0.01 });
    const result = await handleToolCall({ toolName: "bash", input: { command: "git push origin feature" } }, ctx, { provider: "typesafe" });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /Jev denied this call.*no_secret_egress/);
  });

  it("fails closed on invalid provider configuration", async () => {
    const result = await handleToolCall(
      { toolName: "bash", input: { command: "git push origin feature" } }, context(),
      { configFile: "/dev/null" },
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /Invalid Jev gate configuration/);
  });
});

describe("session gate control", () => {
  it("registers interception and user-only commands, bypasses only while explicitly disabled", async () => {
    type Handler = (event: unknown, ctx: GateContext) => unknown;
    const handlers = new Map<string, Handler>();
    let command!: (args: string, ctx: { ui: { notify: () => void } }) => Promise<void>;
    const api = {
      on: (name: string, handler: Handler) => { handlers.set(name, handler); },
      registerCommand: (name: string, definition: { handler: typeof command }) => { assert.equal(name, "jev-gate"); command = definition.handler; },
      registerTool: () => { assert.fail("permission decisions must not be model-callable tools"); },
    };
    jevGate(api as unknown as ExtensionAPI);
    const event = { toolName: "bash", input: { command: "rm -rf /" } };
    const toolCall = handlers.get("tool_call")!;
    const ui = { ui: { notify: () => {} } };
    assert.equal(((await toolCall(event, context())) as { block: boolean }).block, true);
    await command("off", ui);
    assert.equal(await toolCall(event, context()), undefined);
    await command("on", ui);
    assert.equal(((await toolCall(event, context())) as { block: boolean }).block, true);
    await command("off", ui);
    jevGate(api as unknown as ExtensionAPI);
    assert.equal(((await handlers.get("tool_call")!(event, context())) as { block: boolean }).block, true);
  });

  it("starts enabled and changes only in memory", () => {
    const gate = createGateControl();
    assert.equal(gate.isEnabled(), true);
    gate.disable();
    assert.equal(gate.isEnabled(), false);
    gate.enable();
    assert.equal(gate.isEnabled(), true);
    assert.equal(createGateControl().isEnabled(), true);
  });
});

describe("recent user intent", () => {
  it("uses only completed assistant proposals through registered message/input/tool handlers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-handler-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      type Handler = (event: unknown, ctx: GateContext) => unknown;
      const handlers = new Map<string, Handler>();
      jevGate({
        on: (name: string, handler: Handler) => { handlers.set(name, handler); },
        registerCommand: () => {},
      } as unknown as ExtensionAPI);
      const states: Record<string, unknown>[] = [];
      let discoveries = 0;
      const ctx = context();
      ctx.modelRegistry = registry({ classify: async (model, request) => {
        states.push(request.state.value as Record<string, unknown>);
        return approvingResult(model, request);
      } });
      const find = ctx.modelRegistry.findOfType.bind(ctx.modelRegistry);
      ctx.modelRegistry.findOfType = (...args) => { discoveries++; return find(...args); };
      const answer = (stopReason: StopReason, text: string) => handlers.get("message_end")!({
        message: { role: "assistant", stopReason, content: text ? [{ type: "text", text }] : [] },
      }, ctx);
      const push = () => handlers.get("tool_call")!({ toolName: "bash", input: { command: "git push origin feature" } }, ctx);
      const selectAndCall = async () => {
        handlers.get("input")!({ text: "do 2", source: "interactive" }, ctx);
        assert.equal(await push(), undefined);
      };
      const completed = "1. Inspect status\n2. git push origin feature";
      answer("stop", completed);
      await selectAndCall();
      assert.deepEqual(states.map((state) => state.referenced_assistant_proposal), ["2. git push origin feature"]);
      for (const reason of ["stop", "pending", "length", "toolUse", "error", "aborted", "deferred"] as const) {
        answer("stop", completed);
        answer(reason, reason === "stop" ? "" : "1. Inspect\n2. npm publish");
        const count = states.length;
        const discoveryCount = discoveries;
        await selectAndCall();
        assert.equal(states.length, count + 1, reason);
        assert.equal(discoveries, discoveryCount + 1, reason);
        assert.equal(states.at(-1)!.referenced_assistant_proposal, undefined);
        assert.equal(states.at(-1)!.latest_user_message, "(incomplete user intent; not authorization)");
      }
      answer("stop", completed);
      handlers.get("input")!({ text: "do 2", source: "interactive" }, ctx);
      answer("toolUse", "");
      assert.equal(await push(), undefined);
      assert.equal(states.at(-1)!.referenced_assistant_proposal, "2. git push origin feature");
      const assertClearedCall = async () => {
        const count = states.length;
        assert.equal(await push(), undefined);
        assert.equal(states.length, count + 1);
        assert.equal(states.at(-1)!.latest_user_message, "(no recent user message available)");
        assert.equal("referenced_assistant_proposal" in states.at(-1)!, false);
      };
      handlers.get("session_tree")!({}, ctx);
      await assertClearedCall();
      await selectAndCall();
      answer("toolUse", "");
      assert.equal(await push(), undefined);
      handlers.get("session_tree")!({}, ctx);
      await assertClearedCall();
      const count = states.length;
      assert.equal(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "git status" } }, ctx), undefined);
      assert.equal(states.length, count);
      handlers.get("input")!({ text: "Push my feature branch", source: "rpc" }, ctx);
      assert.equal(await push(), undefined);
      assert.equal(states.length, count + 1);
      assert.equal(states.at(-1)!.referenced_assistant_proposal, undefined);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("tracks only bounded interactive/RPC input and excludes extension-generated user messages", () => {
    const intent = createIntentTracker();
    intent.record("old", "interactive");
    intent.record("first", "rpc");
    intent.record("extension-generated instruction", "extension");
    intent.record("second", "interactive");
    intent.record(`third${"x".repeat(2_000)}`, "rpc");
    assert.deepEqual(intent.snapshot(), { complete: false });
    intent.record("push", "interactive");
    assert.deepEqual(intent.snapshot(), { complete: true, latest: "push", earlier: ["second", "(earlier user message omitted: too long)"] });
    intent.record(`again${"x".repeat(2_000)}`, "interactive");
    intent.record("push now", "interactive");
    assert.deepEqual(intent.snapshot(), { complete: true, latest: "push now", earlier: ["push", "(earlier user message omitted: too long)"] });
  });

  it("redacts before truncation and clears intent after branch navigation", () => {
    const intent = createIntentTracker();
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(1_500)}\n-----END PRIVATE KEY-----`;
    intent.record(privateKey, "interactive");
    intent.record("second", "interactive");
    assert.deepEqual(intent.snapshot(), { complete: true, latest: "second", earlier: ["<redacted-private-key>"] });
    intent.clear();
    assert.deepEqual(intent.snapshot(), { complete: true, latest: "", earlier: [] });
  });

  it("grounds short confirmations only in a completed answer's closing question", () => {
    const grounded = (assistant: string, user: string) => {
      const intent = createIntentTracker();
      intent.recordAssistant(assistant);
      intent.record(user, "interactive");
      return intent.snapshot();
    };
    const question = "Committed as abc123.\n\nThe branch is ahead of origin/main. Should I push?";
    for (const user of ["do it", "yes", "Yes, do it.", "go ahead", "sounds good", "ok please", "proceed!"]) {
      assert.deepEqual(grounded(question, user), { complete: true, latest: user, earlier: [], referencedProposal: "The branch is ahead of origin/main. Should I push?" }, user);
    }
    for (const user of ["push", "don't push yet", "do it after tests", "yes but only to staging"]) {
      assert.equal("referencedProposal" in grounded(question, user), false, user);
    }
    assert.deepEqual(grounded("Committed. The branch is ahead.", "do it"), { complete: false });
    assert.deepEqual(grounded("Committed. The branch is ahead.", "yes, do that"), { complete: false });
    assert.deepEqual(grounded("1. Inspect\n2. git push origin feature", "do 2"), { complete: true, latest: "do 2", earlier: [], referencedProposal: "2. git push origin feature" });
    const redacted = grounded("Ready.\n\nShould I push with token=ghp_abcdefghijklmnopqrstuvwxyz01?", "yes");
    assert.equal(JSON.stringify(redacted).includes("ghp_"), false);
  });
});

