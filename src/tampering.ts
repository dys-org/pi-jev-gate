import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { agentDir } from "./config.ts";

const LOADED_PATTERN = /\/\.pi\/agent\/(?:auth\.json|settings\.json|git|npm)(?:\/|$)|\/\.pi\/(?:agent\/)?extensions(?:\/|$)|\/\.pi\/settings\.json$|\/pi-jev-gate(?:\.json|-policy\.md)$/;
const REMOTE_SOURCE = /^(?:npm:|git:|git\+|https?:|ssh:|git@|builtin:)/i;
const AGENT_FILES = ["extensions", "git", "npm", "settings.json", "auth.json", "pi-jev-gate.json", "pi-jev-gate-policy.md"];

export type ProtectedSet = {
  contains(path: string): boolean;
  isAncestor(path: string): boolean;
};

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() || "/";
}

export function expandHome(path: string): string {
  const home = /^(?:~|\$HOME|\$\{HOME\})(?=[\\/]|$)/.exec(path);
  return home ? join(homedir(), path.slice(home[0].length)) : path;
}

function realForms(path: string): string[] | undefined {
  const forms = [normalize(path)];
  let existing = path;
  const rest: string[] = [];
  for (;;) {
    try {
      forms.push(normalize(join(realpathSync(existing), ...rest)));
      return forms;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = dirname(existing);
      if (parent === existing) return forms;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

type Settings = { packages?: unknown; extensions?: unknown };

function readSettings(file: string): Settings | null | "invalid" {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "invalid"; }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return "invalid"; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const settings = value as Settings;
  if ((settings.packages !== undefined && !Array.isArray(settings.packages)) || (settings.extensions !== undefined && !Array.isArray(settings.extensions))) return "invalid";
  return settings;
}

function localSources(settings: Settings, base: string): string[] {
  const roots: string[] = [];
  for (const entry of [...(settings.packages as unknown[] ?? []), ...(settings.extensions as unknown[] ?? [])]) {
    const source = typeof entry === "string" ? entry
      : entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as { source?: unknown }).source === "string" ? (entry as { source: string }).source : undefined;
    if (source === undefined) continue;
    const path = source.replace(/^\+/, "");
    if (!path || /^[-!]/.test(path) || REMOTE_SOURCE.test(path) || /[*?[{]/.test(path)) continue;
    roots.push(resolve(base, expandHome(path)));
  }
  return roots;
}

export function protectedSet(cwd: string): ProtectedSet {
  let roots: string[] | "all" | undefined;
  const load = () => {
    if (roots) return roots;
    const dir = resolve(agentDir());
    const agent = readSettings(join(dir, "settings.json"));
    if (agent === "invalid") return roots = "all";
    const project = readSettings(join(cwd, ".pi", "settings.json"));
    const lexical = [
      ...AGENT_FILES.map((name) => join(dir, name)),
      ...(agent ? localSources(agent, dir) : []),
      ...(project && project !== "invalid" ? localSources(project, join(cwd, ".pi")) : []),
    ];
    return roots = lexical.flatMap((root) => realForms(root) ?? [normalize(root)]);
  };
  return {
    contains(path) {
      const all = load();
      if (all === "all") return true;
      const forms = realForms(path);
      if (!forms) return true;
      return forms.some((form) => LOADED_PATTERN.test(form) || all.some((root) => form === root || form.startsWith(`${root}/`)));
    },
    isAncestor(path) {
      const all = load();
      if (all === "all") return true;
      const forms = realForms(path);
      if (!forms) return true;
      return forms.some((form) => all.some((root) => root.startsWith(form === "/" ? "/" : `${form}/`)));
    },
  };
}

type Word = { text: string; raw: string; substitutions: string[] };
type Token =
  | { kind: "word"; word: Word }
  | { kind: "op"; op: string }
  | { kind: "redirect"; output: boolean; target?: Word };

const OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "(", ")"];
const REDIRECT = /^(?:\d*(?:>>|>\||>&|<>|<<<|<<-|<<|<&|>|<)|&>>|&>)/;

function captureParens(text: string, start: number): number {
  let depth = 1;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === "\\" && quote === '"') i++;
      else if (char === quote) quote = "";
    } else if (char === "\\") i++;
    else if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i;
  }
  return text.length;
}

function lex(command: string): Token[] {
  const tokens: Token[] = [];
  const heredocs: string[] = [];
  let i = 0;
  const readWord = (): Word | undefined => {
    let text = "";
    const start = i;
    const substitutions: string[] = [];
    while (i < command.length) {
      const char = command[i]!;
      if (/[\s;&|()<>]/.test(char)) break;
      if (char === "\\") { if (command[i + 1] !== "\n") text += command[i + 1] ?? ""; i += 2; continue; }
      if (char === "'" || (char === "$" && command[i + 1] === "'")) {
        if (char === "$") i++;
        const end = command.indexOf("'", i + 1);
        text += command.slice(i + 1, end < 0 ? undefined : end);
        i = end < 0 ? command.length : end + 1;
        continue;
      }
      if (char === "$" && command[i + 1] === "(") {
        const end = captureParens(command, i + 2);
        substitutions.push(command.slice(i + 2, end));
        text += "\0";
        i = end + 1;
        continue;
      }
      if (char === "`") {
        const end = command.indexOf("`", i + 1);
        substitutions.push(command.slice(i + 1, end < 0 ? undefined : end));
        text += "\0";
        i = end < 0 ? command.length : end + 1;
        continue;
      }
      if (char === '"') {
        i++;
        while (i < command.length && command[i] !== '"') {
          if (command[i] === "\\" && /["\\$`]/.test(command[i + 1] ?? "")) { text += command[i + 1]; i += 2; continue; }
          if (command[i] === "$" && command[i + 1] === "(") {
            const end = captureParens(command, i + 2);
            substitutions.push(command.slice(i + 2, end));
            text += "\0";
            i = end + 1;
            continue;
          }
          if (command[i] === "`") {
            const end = command.indexOf("`", i + 1);
            substitutions.push(command.slice(i + 1, end < 0 ? undefined : end));
            text += "\0";
            i = end < 0 ? command.length : end + 1;
            continue;
          }
          text += command[i];
          i++;
        }
        i++;
        continue;
      }
      text += char;
      i++;
    }
    return i > start ? { text, raw: command.slice(start, i), substitutions } : undefined;
  };
  while (i < command.length) {
    const char = command[i]!;
    if (char === "\n") {
      tokens.push({ kind: "op", op: ";" });
      i++;
      for (const delimiter of heredocs.splice(0)) {
        while (i < command.length) {
          const end = command.indexOf("\n", i);
          const line = command.slice(i, end < 0 ? undefined : end);
          i = end < 0 ? command.length : end + 1;
          if (line.replace(/^\t+/, "") === delimiter) break;
        }
      }
      continue;
    }
    if (/\s/.test(char)) { i++; continue; }
    if (char === "#") { const end = command.indexOf("\n", i); i = end < 0 ? command.length : end; continue; }
    const redirect = REDIRECT.exec(command.slice(i));
    if (redirect) {
      const op = redirect[0];
      i += op.length;
      while (command[i] === " " || command[i] === "\t") i++;
      if (/&$/.test(op) && /^(?:\d+|-)(?=[\s;&|()<>]|$)/.test(command.slice(i))) { readWord(); continue; }
      const target = readWord();
      if (/(?:^|[^<])<<-?$/.test(op)) { if (target) heredocs.push(target.text); continue; }
      tokens.push({ kind: "redirect", output: /[>]/.test(op), target });
      continue;
    }
    const op = OPERATORS.find((candidate) => command.startsWith(candidate, i));
    if (op) { tokens.push({ kind: "op", op }); i += op.length; continue; }
    const word = readWord();
    if (word) tokens.push({ kind: "word", word });
    else i++;
  }
  return tokens;
}

const READ_ONLY = new Set([
  "cat", "head", "tail", "less", "more", "wc", "ls", "stat", "du", "df", "diff", "cmp", "grep", "egrep", "fgrep",
  "echo", "printf", "pwd", "true", "false", "test", "[", "realpath", "readlink", "basename", "dirname", "which", "type",
  "nl", "cut", "tr", "shasum", "sha1sum", "sha256sum", "md5", "md5sum", "od", "hexdump", "strings", "jq",
]);
const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "describe", "shortlog", "cat-file"]);
const DESTRUCTIVE = new Set(["rm", "rmdir", "unlink", "mv", "chmod", "chown", "chgrp", "chflags", "find", "rsync", "shred", "srm", "trash"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);
const FIND_ACTION = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/;
const SAFE_SED_SCRIPT = /^(?:(?:\d+|\$|\/[^/]*\/)(?:,(?:\d+|\$|\/[^/]*\/))?)?(?:[pd=q]|s([^\s\\])(?:(?!\1).)*\1(?:(?!\1).)*\1[gpiI\d]*)?$/;
const EMBEDDED_PATH = /(?:~|\$HOME\b|\$\{HOME\})(?:\/[^\s'"`;|&()<>,]*)?|\/[^\s'"`;|&()<>,]+/g;

function readOnlySed(args: readonly string[]): boolean {
  const scripts: string[] = [];
  let operandScript = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--expression" || /^-[nEr]*e$/.test(arg)) { scripts.push(args[++index] ?? ""); operandScript = false; }
    else if (arg.startsWith("--expression=")) { scripts.push(arg.slice(13)); operandScript = false; }
    else if (/^-[nEr]*e./.test(arg)) { scripts.push(arg.slice(arg.indexOf("e") + 1)); operandScript = false; }
    else if (/^-[nEr]+$/.test(arg) || arg === "--quiet" || arg === "--silent" || arg === "--regexp-extended") continue;
    else if (arg.startsWith("-")) return false;
    else if (operandScript) { scripts.push(arg); operandScript = false; }
  }
  return scripts.length > 0 && scripts.every((script) => SAFE_SED_SCRIPT.test(script.trim()));
}

function readOnlyGit(args: readonly string[]): boolean {
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    if (args[index] === "-C" || args[index] === "-c") index++;
    else if (!/^(?:--no-pager|-P|--no-optional-locks)$/.test(args[index]!)) return false;
    index++;
  }
  const sub = args[index];
  const rest = args.slice(index + 1);
  if (sub === "branch") return rest.every((arg) => /^(?:-a|-r|-v|-vv|--all|--remotes|--list|--show-current)$/.test(arg));
  if (sub === "remote") return rest.every((arg) => arg === "-v");
  return sub !== undefined && GIT_READ_ONLY.has(sub) && !rest.some((arg) => /^--output(?:=|$)|^--ext-diff$/.test(arg));
}

function readOnlyTest(name: string, args: readonly string[]): boolean {
  if (name === "pnpm" || name === "npm") {
    let index = 0;
    while (args[index] === "-C" || args[index] === "--dir" || args[index]?.startsWith("--dir=")) index += args[index]!.includes("=") ? 1 : 2;
    const [sub, script] = [args[index], args[index + 1]];
    const scripts = name === "pnpm" ? ["test", "check", "typecheck"] : ["test"];
    return sub !== undefined && (scripts.includes(sub) || sub === "t" || ((sub === "run" || sub === "run-script") && scripts.includes(script ?? "")));
  }
  if (name === "node") return args.includes("--test") && !args.some((arg) => /^(?:-e|--eval|-p|--print|-r|--require|--import|--loader|--experimental-loader)(?:=|$)/.test(arg));
  if (name === "tsc") return args.includes("--noEmit") && !args.some((arg) => /^(?:-w|--watch|-b|--build)$/.test(arg));
  return false;
}

function copyDestination(args: readonly string[]): string | undefined {
  const operands: string[] = [];
  let target: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-t" || arg === "--target-directory") target = args[++index];
    else if (arg.startsWith("--target-directory=")) target = arg.slice(19);
    else if (/^-[^-]*t./.test(arg)) target = arg.slice(arg.indexOf("t") + 1);
    else if (arg === "--") operands.push(...args.slice(index + 1)), index = args.length;
    else if (arg.startsWith("-")) { if (operands.length) return undefined; }
    else operands.push(arg);
  }
  return target ?? (operands.length > 1 ? operands.at(-1) : undefined);
}

type Scope = { dirs: string[]; unknownDir: boolean; vars: Map<string, string>; pushed: { dirs: string[]; unknownDir: boolean }[] };

export function tampersWithLoadedCode(command: string, cwd: string, guarded: ProtectedSet): boolean {
  return analyze(command, { dirs: [cwd], unknownDir: false, vars: new Map(), pushed: [] }, guarded, 0);
}

const copyScope = (scope: Scope): Scope => ({ dirs: [...scope.dirs], unknownDir: scope.unknownDir, vars: new Map(scope.vars), pushed: [...scope.pushed] });

function analyze(command: string, scope: Scope, guarded: ProtectedSet, depth: number): boolean {
  if (depth > 8) return true;
  const stack: Scope[] = [];
  let words: Word[] = [];
  let redirects: (Word | undefined)[] = [];
  const expand = (text: string) => expandHome(text.replace(/\$(?:\{(\w+)\}|(\w+))/g, (match, braced, bare) => {
    const name = braced ?? bare;
    return scope.vars.get(name) ?? process.env[name] ?? match;
  }));
  const paths = (text: string) => scope.dirs.map((dir) => resolve(dir, expand(text)));
  const inside = (text: string) => (scope.unknownDir && !isAbsolute(expand(text))) || paths(text).some((path) => guarded.contains(path));
  const inProtectedDir = () => scope.unknownDir || scope.dirs.some((dir) => guarded.contains(dir));
  const ancestor = (text: string) => paths(text).some((path) => guarded.isAncestor(path));
  const finish = (): boolean | { cd: string[] | "unknown" } => {
    const current = words;
    const outputs = redirects;
    words = [];
    redirects = [];
    for (const word of [...current, ...outputs]) {
      for (const inner of word?.substitutions ?? []) if (analyze(inner, copyScope(scope), guarded, depth + 1)) return true;
    }
    if (outputs.some((target) => target && inside(target.text))) return true;
    let args = current.filter((word) => !KEYWORDS.has(word.text));
    while (args[0] && /^[A-Za-z_]\w*=/.test(args[0].text)) {
      const [name, ...value] = args[0].text.split("=");
      if (args.length === 1) scope.vars.set(name!, expand(value.join("=")));
      args = args.slice(1);
    }
    let texts = args.map((word) => word.text);
    while (texts.length > 1 && ["time", "nohup", "command", "builtin", "nice"].includes(texts[0]!) && !texts[1]!.startsWith("-")) texts = texts.slice(1);
    while (texts[0] === "env" && texts.slice(1).every((arg) => !arg.startsWith("-"))) { texts = texts.slice(1); while (texts[0] && /^[A-Za-z_]\w*=/.test(texts[0])) texts = texts.slice(1); }
    if (texts[0] === "timeout" && texts[1] && /^\d/.test(texts[1])) texts = texts.slice(2);
    if (texts[0] === "export" || texts[0] === "local" || texts[0] === "readonly") {
      for (const assignment of texts.slice(1)) {
        const [name, ...value] = assignment.split("=");
        if (value.length) scope.vars.set(name!, expand(value.join("=")));
      }
      return false;
    }
    if (!texts.length) return false;
    const name = basename(texts[0]!);
    const rest = texts.slice(1);
    if (name === "popd") {
      const previous = scope.pushed.pop();
      return previous && !previous.unknownDir ? { cd: previous.dirs } : { cd: "unknown" };
    }
    if (name === "cd" || name === "pushd") {
      if (name === "pushd") scope.pushed.push({ dirs: [...scope.dirs], unknownDir: scope.unknownDir });
      const target = rest.find((arg) => !arg.startsWith("-") || arg === "-");
      if (target === undefined) return { cd: [homedir()] };
      if (target === "-" || target.includes("\0")) return { cd: "unknown" };
      return { cd: paths(target) };
    }
    const candidates = rest.flatMap((arg) => {
      const found = [...arg.matchAll(EMBEDDED_PATH)].map((match) => match[0]);
      if (arg.includes("=")) found.push(arg.slice(arg.indexOf("=") + 1));
      if (/^-[^-]./.test(arg)) found.push(arg.slice(2));
      if (!arg.startsWith("-")) found.push(arg);
      return found;
    });
    if (SHELLS.has(name)) {
      const flag = rest.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
      if (flag >= 0 && rest[flag + 1] !== undefined && analyze(rest[flag + 1]!, copyScope(scope), guarded, depth + 1)) return true;
    }
    if (name === "eval" && analyze(rest.join(" "), copyScope(scope), guarded, depth + 1)) return true;
    const readOnly = READ_ONLY.has(name)
      || (name === "rg" && !rest.some((arg) => /^--pre(?:=|$)/.test(arg)))
      || (name === "sed" && readOnlySed(rest))
      || (name === "find" && !rest.some((arg) => FIND_ACTION.test(arg)))
      || (name === "git" && readOnlyGit(rest))
      || readOnlyTest(name, rest);
    if (readOnly) return false;
    if (name === "cp") {
      const destination = copyDestination(rest);
      if (destination !== undefined) return inside(destination);
    }
    if (inProtectedDir()) return true;
    if (candidates.some(inside)) return true;
    return DESTRUCTIVE.has(name) && candidates.some(ancestor);
  };
  for (const token of lex(command)) {
    if (token.kind === "word") words.push(token.word);
    else if (token.kind === "redirect") { if (token.output) redirects.push(token.target); }
    else {
      const result = finish();
      if (result === true) return true;
      if (result && token.op !== "||" && token.op !== "|" && token.op !== "|&") {
        if (result.cd === "unknown") scope.unknownDir = true;
        else if (token.op === "&&") { scope.dirs = result.cd; scope.unknownDir = false; }
        else scope.dirs = [...new Set([...scope.dirs, ...result.cd])];
      }
      if (token.op === "(") stack.push(copyScope(scope));
      else if (token.op === ")") scope = stack.pop() ?? scope;
    }
  }
  return finish() === true;
}
