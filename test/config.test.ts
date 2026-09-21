import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configPath, readProvider, writeProvider } from "../src/config.ts";

describe("provider configuration", () => {
  it("defaults to direct TypeSafe when the global file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-config-"));
    assert.equal(await readProvider(join(dir, "missing.json")), "typesafe");
    assert.equal(configPath({ PI_CODING_AGENT_DIR: dir }), join(dir, "pi-jev-gate.json"));
  });

  it("persists only the explicit provider and stores no key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-config-"));
    const path = join(dir, "pi-jev-gate.json");
    await writeProvider("vercel", path);
    assert.equal(await readProvider(path), "vercel");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { provider: "vercel" });
  });

  it("rejects malformed, unknown, and extra configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-config-"));
    const path = join(dir, "config.json");
    for (const value of ["{", '{"provider":"other"}', '{"provider":"typesafe","key":"secret"}']) {
      await writeFile(path, value);
      await assert.rejects(readProvider(path), /Invalid Jev gate configuration/);
    }
  });
});
