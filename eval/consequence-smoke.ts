import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { JevRegistry } from "../src/jev.ts";
import { approvingResult, registry } from "../test/fixtures.ts";
import { evaluate, frozenSuite, isolatedProvider, loadGate, sha256, summarize, type Result } from "./runner.ts";

const MAX_REQUESTS = 20;
const MAX_INPUT_TOKENS = 64_000;
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
const BUDGET_USD = 0.10;

async function main() {
  const { values } = parseArgs({ options: { live: { type: "boolean", default: false } } });
  const here = dirname(fileURLToPath(import.meta.url));
  const gate = await loadGate(join(here, ".."), "native");
  const suite = frozenSuite("consequence-first-20", await readFile(join(here, "consequence-first-20.json"), "utf8"));
  if (suite.cases.length !== 20 || MAX_REQUESTS * MAX_INPUT_TOKENS * USD_PER_INPUT_TOKEN > BUDGET_USD) throw new Error("Invalid batch limits");
  const log = (value: unknown) => console.log(JSON.stringify(value));
  const rows: Result[] = [];
  let requests = 0;
  let inputTokens = 0;
  let currentCase = "";
  let missingUsage = 0;
  let reportedUsageRequests = 0;
  const nativeRegistry = values.live ? await (async () => {
    const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    return new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false }));
  })() : registry();
  const model = nativeRegistry.findOfType("classifier", "typesafe", "jev-latest");
  if (!model || (values.live && (model.baseUrl !== "https://api.typesafe.ai/v1/" || model.contextWindow !== MAX_INPUT_TOKENS))) throw new Error("Unexpected model endpoint or context limit");
  const modelRegistry: JevRegistry = {
    findOfType: (...args) => nativeRegistry.findOfType(...args),
    classify: async (model, context, options) => {
      if (!values.live) {
        await options!.onPayload!({ model: model.id, state: context.state, questions: context.questions }, model);
        return approvingResult(model, context);
      }
      return nativeRegistry.classify(model, context, {
        ...options,
        fetch: async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          const headers = new Headers(input instanceof Request ? input.headers : undefined);
          new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
          if (url !== "https://api.typesafe.ai/v1/systemone" || init?.method?.toUpperCase() !== "POST" ||
              headers.has("TypeSafe-Danger-Zone-Long-Context") || requests >= MAX_REQUESTS) throw new Error("Request outside approved limits");
          const payload = JSON.parse(String(init.body));
          if (payload.model !== "jev-latest" || payload.assets || Object.keys(payload).some((key) => !["model", "state", "questions"].includes(key))) throw new Error("Unexpected request payload");
          requests++;
          log({ type: "request", name: currentCase, request: requests, payload });
          const response = await fetch(input, { ...init, redirect: "error" });
          const observed = await response.clone().json() as { model?: unknown; usage?: { input_tokens?: unknown } };
          const tokens = observed.usage?.input_tokens;
          if (typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 0 && tokens <= MAX_INPUT_TOKENS) {
            inputTokens += tokens;
            reportedUsageRequests++;
          } else missingUsage++;
          log({ type: "response_metadata", name: currentCase, status: response.status,
            servedModel: typeof observed.model === "string" ? observed.model : null,
            inputTokens: typeof tokens === "number" ? tokens : null });
          return response;
        },
      });
    },
  };
  log({ type: "metadata", mode: values.live ? "live" : "offline-mocked-not-release-evidence", startedAt: new Date().toISOString(),
    provider: "typesafe", requestedModel: "jev-latest", cwd: "/workspace/project", fixtureHash: suite.hash,
    sourceHashes: gate.hashes, runnerHash: sha256(await readFile(fileURLToPath(import.meta.url))),
    coreRunnerHash: sha256(await readFile(join(here, "runner.ts"))),
    nodeVersion: process.version, sdkVersion: JSON.parse(await readFile(join(here, "../node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version,
    budgetUsd: BUDGET_USD, maxRequests: MAX_REQUESTS, maxInputTokensPerRequest: MAX_INPUT_TOKENS,
    priceUsdPerMillionInputTokens: USD_PER_INPUT_TOKEN * 1_000_000,
    conservativeCostCeilingUsd: MAX_REQUESTS * MAX_INPUT_TOKENS * USD_PER_INPUT_TOKEN });
  await isolatedProvider(async () => {
    for (const item of suite.cases) {
      currentCase = item.name;
      const row = await evaluate(gate, suite, item, "/workspace/project", modelRegistry);
      rows.push(row);
      log({ type: "case", ...row });
      if (row.actual === "unavailable") break;
    }
  });
  const summary = summarize(rows);
  log({ type: "summary", ...summary, completedCases: rows.length, expectedCases: suite.cases.length,
    requests, inputTokens, reportedUsageRequests, missingUsage,
    observedUsageCostUsd: inputTokens * USD_PER_INPUT_TOKEN,
    conservativeAttemptCostCeilingUsd: requests * MAX_INPUT_TOKENS * USD_PER_INPUT_TOKEN,
    evidence: values.live ? "live single frozen batch" : "offline mechanics only" });
  if (rows.length !== suite.cases.length || summary.unavailable || (values.live && !summary.releaseCriterionMet)) process.exitCode = 1;
}

main().catch(() => {
  console.error("Consequence smoke setup failed; provider and credential details are not printed.");
  process.exitCode = 2;
});
