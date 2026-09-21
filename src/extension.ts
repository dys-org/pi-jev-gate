import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, InputSource } from "@earendil-works/pi-coding-agent";
import { configPath, isJevProvider, readProvider, writeProvider, type JevProvider } from "./config.ts";
import { judgeWithJev, type JevDependencies } from "./jev.ts";
import { classifyToolCall, redactSecrets, type ToolCall } from "./policy.ts";

export type GateContext = {
  cwd: string;
  intent?: string;
  modelRegistry: { getProviderAuth(provider: string): Promise<{ auth: { apiKey?: string } } | undefined> };
  signal?: AbortSignal;
};

export function createGateControl() {
  let enabled = true;
  return {
    isEnabled: () => enabled,
    enable: () => { enabled = true; },
    disable: () => { enabled = false; },
  };
}

export function createIntentTracker() {
  const messages: string[] = [];
  return {
    record(text: string, source: InputSource) {
      if (source !== "interactive" && source !== "rpc") return;
      const bounded = redactSecrets(text).trim().slice(0, 1_000);
      if (bounded) messages.push(bounded);
      if (messages.length > 3) messages.shift();
    },
    value() { return messages.join("\n\n").slice(0, 2_400); },
    clear() { messages.length = 0; },
  };
}

async function apiKeyFor(provider: JevProvider, ctx: GateContext): Promise<string | undefined> {
  if (provider === "typesafe") return process.env.TYPESAFE_API_KEY;
  const providerId = provider === "openrouter" ? "openrouter" : "vercel-ai-gateway";
  return (await ctx.modelRegistry.getProviderAuth(providerId))?.auth.apiKey;
}

export async function handleToolCall(
  event: ToolCall,
  ctx: GateContext,
  overrides: Partial<JevDependencies> & { configFile?: string } = {},
): Promise<{ block: true; reason: string } | undefined> {
  const local = classifyToolCall(event, ctx.cwd);
  if (local.action === "allow") return undefined;
  if (local.action === "deny") return { block: true, reason: local.reason };

  let provider: JevProvider;
  try { provider = overrides.provider ?? await readProvider(overrides.configFile); }
  catch (error) {
    return { block: true, reason: `Jev could not make a decision: ${(error as Error).message} Do not repeat the same call unchanged; change the approach or ask the user.` };
  }

  const verdict = await judgeWithJev(local.call, {
    cwd: ctx.cwd, isGitRepository: existsSync(join(ctx.cwd, ".git")), intent: ctx.intent ?? "",
  }, {
    provider,
    getApiKey: overrides.getApiKey ?? (() => apiKeyFor(provider, ctx)),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
  }, ctx.signal);

  if (verdict.kind === "allow") return undefined;
  const prefix = verdict.kind === "unavailable" ? "Jev could not make a decision" : "Jev denied this call";
  return { block: true, reason: `${prefix}: ${verdict.reason} Do not repeat the same call unchanged; change the approach or ask the user.` };
}

export default function jevGate(pi: ExtensionAPI): void {
  const intent = createIntentTracker();
  const gate = createGateControl();
  pi.registerCommand("jev-gate", {
    description: "Show or set the Jev gate provider",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 1 && parts[0] === "off") {
        gate.disable();
        ctx.ui.notify("Jev gate disabled for this session.", "warning");
        return;
      }
      if (parts.length === 1 && parts[0] === "on") {
        gate.enable();
        ctx.ui.notify("Jev gate enabled.", "info");
        return;
      }
      if (parts.length === 1 && parts[0] === "provider") {
        try { ctx.ui.notify(`Jev gate provider: ${await readProvider()}`, "info"); }
        catch (error) { ctx.ui.notify((error as Error).message, "error"); }
        return;
      }
      if (parts.length === 2 && parts[0] === "provider" && isJevProvider(parts[1])) {
        await writeProvider(parts[1]);
        ctx.ui.notify(`Jev gate provider set to ${parts[1]}.`, "info");
        return;
      }
      ctx.ui.notify("Usage: /jev-gate off|on|provider [typesafe|openrouter|vercel]", "error");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    try { await readProvider(); }
    catch (error) { ctx.ui.notify(`${(error as Error).message} (${configPath()})`, "error"); }
  });
  pi.on("input", (event) => { intent.record(event.text, event.source); });
  pi.on("session_tree", () => { intent.clear(); });
  pi.on("tool_call", (event, ctx) => {
    if (!gate.isEnabled()) return;
    return handleToolCall(event as ToolCall, { ...ctx, intent: intent.value() });
  });
}
