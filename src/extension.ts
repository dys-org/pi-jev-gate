import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, InputSource } from "@earendil-works/pi-coding-agent";
import { PROVIDERS, configPath, isJevProvider, readProvider, writeProvider, type JevProvider } from "./config.ts";
import { judgeWithJev, NO_INTENT, type Intent, type JevRegistry } from "./jev.ts";
import { classifyToolCall, redactSecrets, type ToolCall } from "./policy.ts";

export type GateContext = {
  cwd: string;
  intent?: Intent;
  modelRegistry: JevRegistry;
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

// Reject preamble, trailing prose, and continuations rather than dropping restrictions.
function selectedAssistantItem(user: string, assistant: string): string {
  const selection = /^(?:do|run|try|use|go with)\s+#?([1-9]\d*)(?=$|[\s;,.?!])/i.exec(user);
  if (!selection || /^\s*(?:and|or|&|,|\/|-)\s*#?\d/i.test(user.slice(selection[0].length))) return "";
  const items = new Map<string, string>();
  for (const line of assistant.split("\n")) {
    if (!line.trim()) continue;
    const item = /^([1-9]\d*)[.)]\s+\S.*$/.exec(line);
    if (!item || items.has(item[1]!)) return "";
    items.set(item[1]!, line);
  }
  return items.get(selection[1]!) ?? "";
}

const AFFIRMATION = "(?:(?:yes|yeah|yep|sure|ok|okay)[,.!]?\\s+)?";
const CONFIRMATION = new RegExp(`^${AFFIRMATION}(?:yes|yeah|yep|sure|ok|okay|do it|do that|go for it|go ahead|sounds good|please do|proceed)(?:\\s+please)?[.!]*$`, "i");
const SHORTHAND = new RegExp(`^${AFFIRMATION}(?:do|run|try|use|go with)\\s+(?:#?[1-9]\\d*|it|that)(?=$|[\\s;,.?!])`, "i");

function closingQuestion(user: string, assistant: string): string {
  const answer = assistant.trim();
  if (!CONFIRMATION.test(user) || !answer.endsWith("?")) return "";
  return answer.split(/\n\s*\n/).at(-1)!.trim();
}

const OVERSIZED_EARLIER = "(earlier user message omitted: too long)";

export function createIntentTracker() {
  const messages: (string | null)[] = [];
  let lastAssistant = "";
  let referencedProposal = "";
  let intentIncomplete = false;
  return {
    record(text: string, source: InputSource) {
      if (source !== "interactive" && source !== "rpc") { lastAssistant = ""; return; }
      const redacted = redactSecrets(text).trim();
      if (!redacted) { lastAssistant = ""; referencedProposal = ""; return; }
      const oversized = redacted.length > 1_000;
      const shorthand = SHORTHAND.test(redacted);
      referencedProposal = oversized ? "" : selectedAssistantItem(redacted, lastAssistant) || closingQuestion(redacted, lastAssistant);
      intentIncomplete = oversized || (shorthand && !referencedProposal);
      lastAssistant = "";
      // Never store a clipped prefix: the omitted suffix may cancel it.
      messages.push(oversized ? null : redacted);
      if (messages.length > 3) messages.shift();
    },
    recordAssistant(text: string) {
      const redacted = redactSecrets(text);
      lastAssistant = redacted.length <= 1_200 ? redacted : "";
    },
    snapshot(): Intent {
      const latest = messages.at(-1);
      if (intentIncomplete || latest === null) return { complete: false };
      if (latest === undefined) return NO_INTENT;
      const earlier = messages.slice(0, -1).map((message) => message ?? OVERSIZED_EARLIER);
      while (earlier.length && [...earlier, latest].join("\n\n").length > 2_400) earlier.shift();
      return { complete: true, latest, earlier, ...(referencedProposal ? { referencedProposal } : {}) };
    },
    clear() { messages.length = 0; lastAssistant = ""; referencedProposal = ""; intentIncomplete = false; },
  };
}

export async function handleToolCall(
  event: ToolCall,
  ctx: GateContext,
  overrides: { provider?: JevProvider; configFile?: string } = {},
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
    cwd: ctx.cwd, isGitRepository: existsSync(join(ctx.cwd, ".git")), intent: ctx.intent ?? NO_INTENT,
  }, {
    provider, modelRegistry: ctx.modelRegistry,
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
        try { await writeProvider(parts[1]); }
        catch (error) { ctx.ui.notify((error as Error).message, "error"); return; }
        ctx.ui.notify(`Jev gate provider set to ${parts[1]}.`, "info");
        return;
      }
      ctx.ui.notify(`Usage: /jev-gate off|on|provider [${PROVIDERS.join("|")}]`, "error");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    try { await readProvider(); }
    catch (error) { ctx.ui.notify(`${(error as Error).message} (${configPath()})`, "error"); }
  });
  pi.on("input", (event) => { intent.record(event.text, event.source); });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    // Partial or interim tool-calling answers may omit a later qualification.
    const text = event.message.stopReason === "stop"
      ? event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
    intent.recordAssistant(text);
  });
  pi.on("session_tree", () => { intent.clear(); });
  pi.on("tool_call", (event, ctx) => {
    if (!gate.isEnabled()) return;
    return handleToolCall(event as ToolCall, {
      ...ctx, intent: intent.snapshot(),
    });
  });
}
