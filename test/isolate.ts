import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "jev-agent-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
