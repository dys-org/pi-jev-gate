import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGateControl, createIntentTracker, handleToolCall, type GateContext } from "../src/extension.ts";

function context(intent = ""): GateContext {
  return {
    cwd: "/Users/dev/project",
    intent,
    modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "pi-openrouter-key" } }) },
    signal: undefined,
  };
}

function approvingFetch(expectedKey = "pi-openrouter-key") {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${expectedKey}`);
    const body = JSON.parse(String(init?.body));
    return Response.json({
      answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.99 }])),
    });
  };
}

describe("Pi tool-call integration", () => {
  it("keeps ordinary work entirely local", async () => {
    const noNetwork = async () => { throw new Error("unexpected network request"); };
    assert.equal(await handleToolCall({ toolName: "bash", input: { command: "git status" } }, context(), { fetch: noNetwork }), undefined);
    assert.equal(await handleToolCall({ toolName: "bash", input: { command: "pnpm test" } }, context(), { fetch: noNetwork }), undefined);
    assert.equal(await handleToolCall({ toolName: "write", input: { path: "src/a.ts", content: "x" } }, context(), { fetch: noNetwork }), undefined);
    assert.equal(await handleToolCall({ toolName: "read", input: { path: "/var/folders/x/T/image.png" } }, context(), { fetch: noNetwork }), undefined);
  });

  it("blocks hard denials before credential or network access", async () => {
    let resolvedAuth = false;
    const ctx = context();
    ctx.modelRegistry.getProviderAuth = async () => {
      resolvedAuth = true;
      return { auth: { apiKey: "k" } };
    };
    const result = await handleToolCall({ toolName: "bash", input: { command: "rm -rf /" } }, ctx);
    assert.equal(result?.block, true);
    assert.equal(resolvedAuth, false);
  });

  it("uses Pi's OpenRouter credential for evaluated calls", async () => {
    const result = await handleToolCall(
      { toolName: "bash", input: { command: "git push origin feature" } },
      context("push my feature branch"),
      { provider: "openrouter", fetch: approvingFetch() },
    );
    assert.equal(result, undefined);
  });

  it("uses TYPESAFE_API_KEY for direct TypeSafe without querying Pi auth", async () => {
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "direct-key";
    try {
      const ctx = context("push my feature branch");
      ctx.modelRegistry.getProviderAuth = async () => { throw new Error("must not fall back"); };
      const result = await handleToolCall(
        { toolName: "bash", input: { command: "git push origin feature" } }, ctx,
        { provider: "typesafe", fetch: approvingFetch("direct-key") },
      );
      assert.equal(result, undefined);
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
    }
  });

  it("resolves only the explicitly selected Pi provider and never falls back", async () => {
    const requested: string[] = [];
    const ctx = context();
    ctx.modelRegistry.getProviderAuth = async (provider) => {
      requested.push(provider);
      return undefined;
    };
    const result = await handleToolCall(
      { toolName: "bash", input: { command: "git push origin feature" } }, ctx,
      { provider: "vercel" },
    );
    assert.equal(result?.block, true);
    assert.deepEqual(requested, ["vercel-ai-gateway"]);
    assert.match(result?.reason ?? "", /could not make a decision/);
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
  it("tracks only bounded interactive/RPC input and excludes extension-generated user messages", () => {
    const intent = createIntentTracker();
    intent.record("old", "interactive");
    intent.record("first", "rpc");
    intent.record("extension-generated instruction", "extension");
    intent.record("second", "interactive");
    intent.record(`third${"x".repeat(2_000)}`, "rpc");
    assert.equal(intent.value(), `first\n\nsecond\n\nthird${"x".repeat(995)}`);
    assert.equal(intent.value().includes("extension-generated"), false);
  });

  it("redacts before truncation and clears intent after branch navigation", () => {
    const intent = createIntentTracker();
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(1_500)}\n-----END PRIVATE KEY-----`;
    intent.record(privateKey, "interactive");
    assert.equal(intent.value(), "<redacted-private-key>");
    intent.clear();
    assert.equal(intent.value(), "");
  });
});
