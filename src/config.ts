import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROVIDERS = ["typesafe", "openrouter", "vercel"] as const;
export type JevProvider = (typeof PROVIDERS)[number];

export function isJevProvider(value: unknown): value is JevProvider {
  return typeof value === "string" && PROVIDERS.includes(value as JevProvider);
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-jev-gate.json");
}

export async function readProvider(path = configPath()): Promise<JevProvider> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "typesafe";
    throw new Error(`Could not read Jev gate configuration: ${(error as Error).message}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid Jev gate configuration: expected JSON.");
  }
  const provider = (value as { provider?: unknown } | null)?.provider;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !isJevProvider(provider)) {
    throw new Error('Invalid Jev gate configuration: expected { "provider": "typesafe" | "openrouter" | "vercel" }.');
  }
  return provider;
}

export async function writeProvider(provider: JevProvider, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ provider }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
