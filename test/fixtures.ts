import type { JevRegistry } from "../src/jev.ts";

type Model = Parameters<JevRegistry["classify"]>[0];
type Context = Parameters<JevRegistry["classify"]>[1];

export function approvingResult(model: Model, context: Context, overrides: Record<string, number> = {}) {
  return {
    api: model.api, provider: model.provider, model: model.id, stopReason: "stop" as const, timestamp: 0,
    answers: Object.fromEntries(Object.keys(context.questions).map((id) => [id, { type: "bool" as const, probability: overrides[id] ?? 0.99 }])),
  };
}

export function registry(overrides: Partial<JevRegistry> = {}): JevRegistry {
  return {
    findOfType: (_type, provider, id) => ({
      type: "classifier", provider, id, api: "typesafe-system-one", name: "Jev",
      baseUrl: "https://example.test", input: ["text"], contextWindow: 64_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    classify: async (model, context) => approvingResult(model, context),
    ...overrides,
  };
}
