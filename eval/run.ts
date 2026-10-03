import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { approvingResult, registry } from "../test/fixtures.ts";
import { evaluate, frozenSuite, isolatedProvider, loadGate, pairedOrder, sha256, summarize, type FrozenSuite, type Result } from "./runner.ts";

// No agent session, shell, tool executor, or subprocess exists in this runner.
async function main() {
const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  offline: { type: "boolean" }, live: { type: "boolean" }, suite: { type: "string", default: "all" },
  source: { type: "string", default: join(here, "..") }, cwd: { type: "string", default: process.cwd() },
  baseline: { type: "string" }, "legacy-baseline": { type: "string" }, rounds: { type: "string", default: "1" },
} });
if (values.live && values.offline) throw new Error("Choose offline or explicit --live, not both");
if (values.baseline && values["legacy-baseline"]) throw new Error("Choose one explicit baseline interface");
if (!["historical", "focused", "all"].includes(values.suite!)) throw new Error("Unknown suite");
const rounds = Number(values.rounds);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 30) throw new Error("Use 1–30 rounds");
const suites: FrozenSuite[] = [];
for (const [name, file] of [["historical", "historical-28.json"], ["focused", "focused.json"]]) {
  if (values.suite === "all" || values.suite === name) suites.push(frozenSuite(name!, await readFile(join(here, file!), "utf8")));
}
const gates = [await loadGate(values.source!, "native")];
if (values.baseline) gates.push(await loadGate(values.baseline, "native"));
if (values["legacy-baseline"]) gates.push(await loadGate(values["legacy-baseline"], "legacy"));
const hashes: Record<string, string> = {};
for (const name of ["run.ts", "runner.ts"]) hashes[name] = sha256(await readFile(join(here, name)));
const sdkPackage = JSON.parse(await readFile(join(here, "../node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
const cwd = resolve(values.cwd!);
console.log(JSON.stringify({ type: "metadata", mode: values.live ? "live" : "offline-mocked-not-release-evidence", cwd, rounds,
  comparison: gates.some((gate) => gate.kind === "legacy") ? "policy-plus-transport" : "native-policy-and-versioned-runtime",
  provider: "typesafe", requestedModel: "jev-latest", sdkVersion: sdkPackage.version, nodeVersion: process.version,
  runnerHashes: hashes, fixtureHashes: Object.fromEntries(suites.map((suite) => [suite.name, suite.hash])),
  sources: gates.map((gate) => ({ root: gate.root, kind: gate.kind, hashes: gate.hashes })), startedAt: new Date().toISOString(),
}));

// Real runtime/authentication are not even initialized without explicit opt-in.
const modelRegistry = values.live ? await (async () => {
  const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false }));
})() : registry({ classify: async (model, context, options) => {
  await options!.onPayload!({ model: model.id, state: context.state, questions: context.questions }, model);
  return approvingResult(model, context); // Uniform synthetic answers; not an authorization oracle.
} });
const legacy = values.live ? {
  getApiKey: async () => process.env.TYPESAFE_API_KEY, fetch: globalThis.fetch,
} : {
  getApiKey: async () => "offline-test-only-key",
  fetch: (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return Response.json({ answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.99 }])) });
  }) as typeof fetch,
};
const rows: Result[][] = gates.map(() => []);
await isolatedProvider(async () => {
  for (let round = 1; round <= rounds; round++) {
    const order = gates.length === 2 ? pairedOrder(round) : [0];
    for (const index of order) for (const suite of suites) for (const item of suite.cases) {
      const row = await evaluate(gates[index]!, suite, item, cwd, modelRegistry, legacy);
      rows[index]!.push(row);
      console.log(JSON.stringify({ type: "case", round, source: index, ...row }));
    }
  }
});
for (let index = 0; index < gates.length; index++) {
  const all = summarize(rows[index]!);
  const bySuite = Object.fromEntries(suites.map((suite) => [suite.name, summarize(rows[index]!.filter((row) => row.suite === suite.name))]));
  console.log(JSON.stringify({ type: "summary", source: index, ...all, bySuite, evidence: values.live ? "live" : "offline mechanics only" }));
  if (values.live && !all.releaseCriterionMet) process.exitCode = 1;
  if (!values.live && all.unavailable) process.exitCode = 1;
}
}
main().catch(() => {
  console.error("Evaluation setup failed; no exception or credential details are printed.");
  process.exitCode = 2;
});
