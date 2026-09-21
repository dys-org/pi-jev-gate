import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JevProvider } from "../src/config.ts";
import { judgeWithJev } from "../src/jev.ts";
import type { GatedCall } from "../src/policy.ts";

const CALL: GatedCall = { tool: "bash", summary: "git push origin feature", command: "git push origin feature", outsideCwd: false, reasons: ["not a trusted development command"] };
const CONTEXT = { cwd: "/project", intent: "push my feature branch", isGitRepository: true };

function responseFor(provider: JevProvider, overrides: Record<string, number> = {}) {
  return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    const answers = Object.fromEntries(Object.keys(body.questions).map((key) => [key,
      provider === "vercel" ? { type: "boolean", probability: overrides[key] ?? 0.99 } : { type: "noul", noul: overrides[key] ?? 0.99 },
    ]));
    return Response.json({ answers });
  };
}
const deps = (provider: JevProvider, overrides: Record<string, number> = {}) => ({ provider, getApiKey: async () => "k", fetch: responseFor(provider, overrides) });

describe("Jev provider transports", () => {
  it("uses each fixed endpoint, model, auth header, and request adaptation", async () => {
    const cases = [
      ["typesafe", "https://api.typesafe.ai/v1/systemone", "jev-latest", "noul"],
      ["openrouter", "https://openrouter.ai/api/alpha/decisions", "typesafe/jev-1.13", "noul"],
      ["vercel", "https://ai-gateway.vercel.sh/v1/evaluate", "typesafe-ai/jev", "boolean"],
    ] as const;
    for (const [provider, endpoint, model, questionType] of cases) {
      let request: { input?: string | URL | Request; init?: RequestInit } = {};
      const result = await judgeWithJev(CALL, CONTEXT, { provider, getApiKey: async () => `${provider}-key`, fetch: async (input, init) => {
        request = { input, init }; return responseFor(provider)(input, init);
      } });
      assert.equal(result.kind, "allow");
      assert.equal(request.input, endpoint);
      assert.equal((request.init?.headers as Record<string, string>).authorization, `Bearer ${provider}-key`);
      const body = JSON.parse(String(request.init?.body));
      assert.equal(body.model, model);
      assert.ok(Object.values(body.questions).every((q) => (q as { type: string }).type === questionType));
      if (provider === "typesafe") assert.equal(body.provider, undefined);
      if (provider === "openrouter") assert.deepEqual(body.provider, { zdr: true });
      if (provider === "vercel") assert.deepEqual(body.providerOptions, { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } });
    }
  });

  it("keeps outbound metadata bounded and excludes file bodies", async () => {
    let sent = "";
    const write: GatedCall = { tool: "write", summary: `write token=ghp_abcdefghijklmnopqrstuvwxyz01 ${"x".repeat(500)}`, path: `/outside/token=ghp_abcdefghijklmnopqrstuvwxyz01/${"x".repeat(1_100)}`, outsideCwd: true, reasons: ["write outside the working directory"], contentLength: 10_000 };
    await judgeWithJev(write, { ...CONTEXT, intent: "use token=ghp_abcdefghijklmnopqrstuvwxyz01" }, { ...deps("typesafe"), fetch: async (input, init) => { sent = String(init?.body); return responseFor("typesafe")(input, init); } });
    const body = JSON.parse(sent);
    assert.equal(body.state.value.content_length, 10_000);
    assert.equal(sent.includes("ghp_abcdefghijklmnopqrstuvwxyz01"), false);
    assert.ok(body.state.value.operation.length <= 300);
    assert.ok(body.state.value.path.length <= 1_000);
  });

  it("adapts Vercel Boolean probabilities to shared reduction", async () => {
    const result = await judgeWithJev(CALL, CONTEXT, deps("vercel", { no_secret_egress: 0.01 }));
    assert.equal(result.kind, "deny");
    assert.match(result.reason, /no_secret_egress/);
  });

  it("allows soft consequences only with intent and never clears hard hazards", async () => {
    assert.equal((await judgeWithJev({ ...CALL, reasons: ["destructive Git operation"] }, CONTEXT, deps("typesafe", { intent_coverage: 0.99, no_outward_effect: 0.01 }))).kind, "allow");
    assert.equal((await judgeWithJev({ ...CALL, reasons: ["destructive Git operation"] }, CONTEXT, deps("typesafe", { intent_coverage: 0.01, no_outward_effect: 0.01 }))).kind, "deny");
    assert.equal((await judgeWithJev(CALL, CONTEXT, deps("openrouter", { no_secret_egress: 0.01 }))).kind, "deny");
  });

  it("blocks uncertainty on downloaded-code execution", async () => {
    const result = await judgeWithJev({ ...CALL, reasons: ["downloaded script execution"] }, CONTEXT, deps("typesafe", { no_fetched_code_execution: 0.5 }));
    assert.equal(result.kind, "deny"); assert.match(result.reason, /uncertain/);
  });

  it("fails closed without auth and on HTTP, malformed response, and timeout failures", async () => {
    assert.equal((await judgeWithJev(CALL, CONTEXT, { provider: "typesafe", getApiKey: async () => undefined })).kind, "unavailable");
    assert.equal((await judgeWithJev(CALL, CONTEXT, { provider: "vercel", getApiKey: async () => "k", fetch: async () => Response.json({}, { status: 503 }) })).kind, "unavailable");
    assert.equal((await judgeWithJev(CALL, CONTEXT, { provider: "openrouter", getApiKey: async () => "k", fetch: async () => Response.json({ answers: {} }) })).kind, "unavailable");
    assert.equal((await judgeWithJev(CALL, CONTEXT, { provider: "typesafe", getApiKey: async () => "k", timeoutMs: 5, fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true })) })).kind, "unavailable");
  });

  it("rejects provider-mismatched and out-of-range answers", async () => {
    for (const answer of [{ type: "boolean", probability: 0.9 }, { type: "noul", noul: 2 }]) {
      const result = await judgeWithJev(CALL, CONTEXT, { provider: "typesafe", getApiKey: async () => "k", fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)); return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, answer])) });
      } });
      assert.equal(result.kind, "unavailable");
    }
  });
});
