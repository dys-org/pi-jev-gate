import "./isolate.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { classifyToolCall } from "../src/policy.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "jev-tamper-")));
const agent = join(root, "agent");
const pkg = join(root, "work", "gate");
const other = join(root, "work", "other");
const settings = (value: unknown) => writeFileSync(join(agent, "settings.json"), typeof value === "string" ? value : JSON.stringify(value));
const bash = (command: string, cwd: string) => classifyToolCall({ toolName: "bash", input: { command } }, cwd);
const tampers = (command: string, cwd: string) => {
  const decision = bash(command, cwd);
  return decision.action === "deny" && decision.reason.includes("permission-system tampering");
};

describe("permission-gate tampering", () => {
  let previous: string | undefined;
  before(() => {
    previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    for (const dir of [join(agent, "extensions"), join(pkg, "src"), other]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(pkg, "src", "policy.ts"), "");
  });
  after(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  it("protects what Pi loads, including local packages listed in settings", () => {
    settings({ packages: ["npm:remote", `../work/gate`, { source: "git:github.com/x/y" }], extensions: ["!excluded", "+./extra.ts", "glob/*.ts"] });
    for (const path of [join(pkg, "src", "policy.ts"), join(agent, "settings.json"), join(agent, "pi-jev-gate.json"), join(agent, "extensions", "x.ts"), join(agent, "extra.ts"), join(other, ".pi", "settings.json")]) {
      assert.equal(classifyToolCall({ toolName: "write", input: { path, content: "x" } }, other).action, "deny", path);
    }
    for (const path of [join(other, "a.ts"), join(root, "work", "gate-notes.txt"), join(agent, "excluded")]) {
      assert.equal(classifyToolCall({ toolName: "write", input: { path, content: "x" } }, other).action, "allow", path);
    }
  });

  it("follows symlinks into protected directories", () => {
    settings({ packages: ["../work/gate"] });
    symlinkSync(pkg, join(other, "link"));
    assert.equal(classifyToolCall({ toolName: "write", input: { path: join(other, "link", "new", "deep.ts"), content: "x" } }, other).action, "deny");
    assert.equal(tampers("rm link/src/policy.ts", other), true);
  });

  it("hard-denies mutations of protected targets, their parents, and work inside them", () => {
    settings({ packages: ["../work/gate"] });
    const rel = relative(other, pkg);
    for (const [command, cwd] of [
      [`rm ${pkg}/src/policy.ts`, other], [`cd ${pkg} && rm src/policy.ts`, other], ["rm src/policy.ts", pkg], [`rm ${rel}/src/policy.ts`, other],
      [`mv ${pkg}/src/policy.ts /tmp/x`, other], [`mv ${agent} ${agent}.bak`, other], [`rm -r ${join(root, "work")}`, other],
      [`cp --backup=none /tmp/evil ${agent}/settings.json`, other], [`install --mode=0644 /tmp/evil ${agent}/settings.json`, other],
      [`cp /tmp/evil ${agent}/settings.json -S .bak`, other], [`cp -t${agent}/extensions /tmp/evil`, other],
      [`sed -i.bak -es/a/b/ ${pkg}/src/policy.ts`, other], [`sed 'w ${agent}/settings.json' /tmp/x`, other], ["sed --in-place s/a/b/ src/policy.ts", pkg],
      [`echo {} > ${agent}/settings.json`, other], [`echo {} >| ${agent}/settings.json`, other], [`echo {} > ${agent}/"settings.json"`, other],
      [`echo x | tee ${agent}/settings.json`, other], [`cat <<EOF > ${agent}/settings.json\n{}\nEOF`, other],
      [`node -e "require('fs').writeFileSync('${pkg}/src/policy.ts', '')"`, other], [`python -c "open('${agent}/settings.json','w')"`, other],
      [`sh -c 'echo {} > ${agent}/settings.json'`, other], [`echo $(mv ${agent}/settings.json /tmp/x)`, other], [`\\mv ${agent}/settings.json /tmp/x`, other],
      [`/usr/bin/env mv ${agent}/settings.json /tmp/x`, other], [`sudo -u root mv ${agent}/settings.json /tmp/x`, other],
      [`F=${agent}/settings.json; rm $F`, other], [`find -L ${agent}/extensions -delete`, other], [`find ${pkg} -exec echo {} \\; -exec mv {} /tmp/x \\;`, other],
      [`curl -sLo ${agent}/settings.json https://example.test`, other], [`tar -xf a.tar -C ${agent}/extensions`, other], [`dd if=/tmp/x of=${agent}/settings.json`, other],
      ["git checkout -- src/policy.ts", pkg], [`git -C ${pkg} apply x.patch`, other], ["pnpm install", pkg], ["node -e 'x'", pkg],
      ["(cd /tmp); mv src/policy.ts /tmp/x", pkg], ["false && cd /tmp; echo {} > src/policy.ts", pkg], ["pushd /tmp && popd && mv src/policy.ts /tmp/x", pkg],
      ["cd - && rm x", other], ["echo '{}' > .pi/settings.json", other],
    ]) assert.equal(tampers(command!, cwd!), true, command);
  });

  it("allows reads, copies out, tests, and unrelated work", () => {
    settings({ packages: ["../work/gate"] });
    for (const [command, cwd] of [
      [`cd ${pkg} && cat src/policy.ts | head -50; rg -n intent src; sed -n 120,230p src/policy.ts`, other],
      ["cat src/policy.ts | head -50; rg 'rm|mv' src; sed -n 1,20p src/policy.ts; sed 's/a/b/g' src/policy.ts", pkg],
      ["git status && git diff HEAD && git log --oneline -5", pkg], ["pnpm test", pkg], ["pnpm check", pkg],
      ["node --test --experimental-strip-types test/policy.test.ts", pkg], ["cp src/policy.ts /tmp/p.ts", pkg],
      [`find ${agent} -name '*.json'`, other], [`cat ${agent}/settings.json | jq .packages`, other],
      [`echo "see -> ${agent}/settings.json"`, other], [`(cd ${agent}/extensions && ls); rm local.txt`, other],
      ["cd /tmp && rm -f x", other], [`cd ${other} && npm install`, pkg], ["pnpm install && rm -rf dist", other],
    ]) assert.equal(tampers(command!, cwd!), false, command);
  });

  it("treats every path as protected when the agent settings cannot be parsed", () => {
    settings("{ not json");
    assert.equal(classifyToolCall({ toolName: "write", input: { path: join(other, "a.ts"), content: "x" } }, other).action, "deny");
    assert.equal(tampers("pnpm install", other), true);
    assert.equal(tampers("git status && cat README.md", other), false);
    settings({ packages: "../work/gate" });
    assert.equal(tampers("pnpm install", other), true);
  });

  it("protects local packages listed in project settings", () => {
    settings({});
    mkdirSync(join(other, ".pi"), { recursive: true });
    writeFileSync(join(other, ".pi", "settings.json"), JSON.stringify({ packages: ["../../gate"] }));
    assert.equal(tampers(`rm ${pkg}/src/policy.ts`, other), true);
    rmSync(join(other, ".pi"), { recursive: true });
  });
});
