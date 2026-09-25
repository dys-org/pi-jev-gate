import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type ToolCall = { toolName: string; input: Record<string, unknown> };
export type GatedCall = {
  tool: "bash" | "read" | "write" | "edit";
  summary: string;
  command?: string;
  path?: string;
  relativePath?: string;
  outsideCwd: boolean;
  reasons: string[];
  editCount?: number;
  contentLength?: number;
};

export type LocalDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "judge"; call: GatedCall };

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "<redacted-jwt>"],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g, "<redacted-key>"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "<redacted-token>"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, "<redacted-aws-key>"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, "Bearer <redacted>"],
  [
    /((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|auth[_-]?token)\s*[:=]\s*)(["']?)([^\s"';|&]{6,})/gi,
    "$1$2<redacted>",
  ],
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

const HARD_COMMANDS: readonly [string, RegExp][] = [
  [
    "recursive delete of a system or home root",
    /\brm\b[^\n;&|]*(?:--recursive|-[^\s;&|]*[rR][^\s;&|]*)[^\n;&|]*\s+["']?(?:\/|~|\$HOME|\$\{HOME\}|\/(?:Users|home|root|System|Applications|Library|etc|usr|var|bin|sbin|opt|private|Volumes))\/*["']?(?=\s|$)/i,
  ],
  [
    "unresolved recursive delete target",
    /\brm\b(?=[^\n;&|]*(?:--recursive|-[^\s;&|]*[rR][^\s;&|]*))(?=[^\n;&|]*(?:\$\(|\$\{(?!HOME\})|\$(?!HOME\b)[A-Za-z_]|\$['"]|~[A-Za-z]|[`*?[\]{}]))/i,
  ],
  ["filesystem or disk destruction", /\b(?:mkfs(?:\.[a-z0-9_+-]+)?|wipefs)\b|\bdd\b[^\n;&|]*\bof\s*=\s*["']?\/dev\//i],
  ["macOS disk erase or partition", /\bdiskutil\b[^\n;&|]*\b(?:erase|partition|apfs\s+delete|apfs\s+erase)\b/i],
  [
    "forced push to a protected branch",
    /\bgit\b(?=[^\n;&|]*\bpush\b)(?=[^\n;&|]*(?:--force(?:-with-lease)?|-[^\s;&|]*f[^\s;&|]*))[^\n;&|]*\b(?:main|master|production|prod)\b/i,
  ],
  ["Pi credential store access", /(?:\.pi|pi)[\\/]agent[\\/]auth\.json\b/i],
  [
    "credential file access",
    /\b(?:cat|bat|less|more|head|tail|xxd|base64|grep|rg)\b[^\n;&|]*(?:\.ssh[\\/]|id_rsa|id_ed25519|id_ecdsa|\.aws[\\/]|\.gnupg|\.npmrc|credentials|\.env\b(?!\.(?:example|sample|template)))/i,
  ],
  [
    "credential exfiltration",
    /(?=.*\b(?:curl|wget|scp|rsync|sftp|nc|ncat|netcat)\b)(?=.*(?:\.ssh[\\/]|\.aws[\\/](?:credentials|config)|\.gnupg[\\/]|id_(?:rsa|ecdsa|ed25519)\b|\.npmrc\b|\.netrc\b))/i,
  ],
  [
    "permission-system tampering",
    /(?=.*\b(?:rm|mv|cp|chmod|chown|sed|perl|python|node)\b)(?=.*pi-jev-gate)/i,
  ],
];

const DANGEROUS_COMMANDS: readonly [string, RegExp][] = [
  ["recursive/forced deletion", /\brm\b[^\n;&|]*\s-(?:[^\s;&|]*[rR][^\s;&|]*[fF]?|[^\s;&|]*[fF][^\s;&|]*[rR])\b|\bfind\b[^\n;&|]*\s-delete\b/i],
  ["package execution or publishing", /\b(?:npm|pnpm|yarn|bun|pip|pip3|uv|poetry|cargo|gem|go)\b[^\n;&|]*\b(?:exec|run|dlx|publish)\b|\b(?:npx|bunx|pipx|uvx)\b/i],
  ["privilege or broad permission change", /\bsudo\b|\bchmod\b[^\n;&|]*\b777\b|\b(?:chmod|chown)\b[^\n;&|]*\s(?:-R|--recursive)\b/i],
  ["destructive Git operation", /\bgit\b[^\n;&|]*\b(?:reset\b[^\n;&|]*--hard|clean\b[^\n;&|]*-[^\s;&|]*f|push\b[^\n;&|]*--(?:force|force-with-lease|mirror)|branch\b[^\n;&|]*-D|tag\b[^\n;&|]*-d|rm\b)/i],
  ["container or volume destruction", /\bdocker\b[^\n;&|]*(?:system\s+prune|volume\s+(?:rm|prune)|compose\b[^\n;&|]*down\b[^\n;&|]*(?:-v|--volumes))/i],
  ["downloaded script execution", /\b(?:curl|wget)\b[^\n;&|]*(?:\|\s*(?:sh|bash|zsh)\b|\b(?:sh|bash|zsh)\s*<\s*\()/i],
  ["network upload of local data", /\b(?:curl|wget)\b[^\n;&|]*(?:\s-d\s*@|\s--data(?:-binary|-raw|-urlencode)?\s*@|\s-T\s|\s--upload-file\b|\s-F\s[^\s;&|]*=@)|\b(?:scp|rsync|sftp)\b/i],
  ["raw network connection", /\b(?:nc|ncat|netcat|telnet)\b/i],
];

const READ_ONLY = [
  /^(?:pwd|whoami|hostname|date)(?:\s|$)/,
  /^(?:cd|ls|tree|cat|bat|head|tail|wc|file|stat|realpath|readlink|basename|dirname|du|df|find|grep|rg|ag|jq|diff|cmp|sort|uniq|cut|column|nl|xxd)(?:\s|$)/,
  /^git\s+(?:status|diff|log|show|branch(?:\s*$)|remote(?:\s+-v)?|blame|shortlog|describe|rev-parse|ls-files|ls-tree|worktree\s+list|stash\s+list|tag(?:\s*$))(?:\s|$)/,
  /^(?:node|npm|python|python3|uv|cargo|gh)\s+--version(?:\s|$)|^go\s+version(?:\s|$)|^uname(?:\s|$)/,
];

const SHELL_STRUCTURE = /[\r\n;&|<>$`()\\]/;

function isReadOnly(command: string): boolean {
  const value = command.trim();
  return !SHELL_STRUCTURE.test(value) && READ_ONLY.some((pattern) => pattern.test(value));
}

function isTrustedProjectCommand(command: string): boolean {
  const value = command.trim();
  if (!value || SHELL_STRUCTURE.test(value)) return false;
  if (/\b(?:deploy|publish|release|production|prod)\b/i.test(value)) return false;
  if (/^\.\/[A-Za-z0-9_./-]+(?:\s|$)/.test(value)) return true;
  if (/^(?:make|just|task)(?:\s|$)|^mise\s+(?:run|x)(?:\s|$)/.test(value)) return true;
  if (/^(?:npm|pnpm|yarn|bun)\s+(?!add\b|install\b|update\b|upgrade\b|exec\b|dlx\b|x\b|publish\b)(?:run\s+)?[^\s-][^\s]*(?:\s|$)/.test(value)) return true;
  return /^(?:(?:uv|poetry)\s+run\s+(?:pytest|python3?\s+-m\s+(?:pytest|unittest))|bundle\s+exec\s+(?:rspec|rake(?:\s+test)?)|cargo\s+(?:test|build|check|clippy|fmt)|go\s+(?:test|build|vet|fmt)|pytest|python3?\s+-m\s+(?:pytest|unittest)|(?:\.\/)?gradlew?\s+(?:test|check|build)|(?:\.\/)?mvnw?\s+(?:test|verify|package)|dotnet\s+(?:test|build)|turbo\s+(?:run\s+)?(?:test|build|check|lint|typecheck)|nx\s+(?:test|build|lint))(?:\s|$)/.test(value);
}

function isTrustedDevelopmentChain(command: string, reasons: readonly string[]): boolean {
  if (/\|\||[;|<>\n]/.test(command)) return false;
  const trusted = command.split("&&").map((part) => part.trim()).filter(Boolean)
    .every((part) => isReadOnly(part) || isTrustedProjectCommand(part));
  return trusted && reasons.every((reason) => reason === "package execution or publishing");
}

function resolveToolPath(path: string, cwd: string): string {
  let normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    normalized = join(homedir(), normalized.slice(2));
  } else if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // Pi preserves malformed file URLs as ordinary paths.
    }
  }
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function target(path: string, cwd: string) {
  const absolute = resolveToolPath(path, cwd);
  const rel = relative(resolve(cwd), absolute);
  const outside = isAbsolute(rel) || rel === "" || rel === ".." || rel.startsWith(`..${sep}`);
  return { absolute, relativePath: outside ? undefined : rel, outside };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function credentialPath(path: string): boolean {
  const normalized = normalizePath(path);
  const base = basename(normalized);
  if (normalized.endsWith("/.pi/agent/auth.json")) return true;
  if (/(?:^|\/)\.(?:ssh|aws|gnupg)(?:\/|$)/.test(normalized)) return true;
  if (/^\.env\.(?:example|sample|template|dist)$/i.test(base)) return false;
  return /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.+\.(?:pem|key|p12|pfx))$/i.test(base);
}

function permissionPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.endsWith("/.pi/agent/auth.json") || /\/pi-jev-gate(?:\.json|-policy\.md)$/.test(normalized);
}

function protectedWrite(path: string): string | undefined {
  const normalized = normalizePath(path);
  if (credentialPath(path)) return "credential-bearing target";
  if (/(?:^|\/)\.(?:git|husky|pi|claude|codex)(?:\/|$)/.test(normalized)) return "agent, Git, or hook configuration";
  if (normalized.includes("/.github/workflows/")) return "CI workflow";
  if (/\/(?:agents|claude)\.md$/i.test(normalized)) return "agent instruction file";
  return undefined;
}

function deny(reason: string): LocalDecision {
  return { action: "deny", reason: `Jev Gate hard-denied this call: ${reason}.` };
}

export function classifyToolCall(event: ToolCall, cwd: string): LocalDecision {
  if (event.toolName === "bash") {
    const raw = typeof event.input.command === "string" ? event.input.command : "";
    const hard = HARD_COMMANDS.filter(([, pattern]) => pattern.test(raw)).map(([name]) => name);
    if (hard.length) return deny(hard.join(", "));

    const reasons = DANGEROUS_COMMANDS.filter(([, pattern]) => pattern.test(raw)).map(([name]) => name);
    if (isTrustedDevelopmentChain(raw, reasons)) return { action: "allow" };

    const command = redactSecrets(raw).slice(0, 4000);
    return {
      action: "judge",
      call: {
        tool: "bash",
        summary: redactSecrets((raw.split("\n")[0] ?? "").trim()).slice(0, 200) || "(empty command)",
        command,
        outsideCwd: false,
        reasons: reasons.length ? reasons : ["not a trusted development command"],
      },
    };
  }

  if (!["read", "write", "edit"].includes(event.toolName)) return { action: "allow" };
  const path = typeof event.input.path === "string" ? event.input.path : "";
  const resolved = target(path, cwd);

  if (event.toolName === "read") {
    if (credentialPath(resolved.absolute)) return deny("credential file access");
    return { action: "allow" };
  }

  if (permissionPath(resolved.absolute)) return deny("permission-system tampering");
  const protectedReason = protectedWrite(resolved.absolute);
  const reasons = [
    ...(resolved.outside ? ["write outside the working directory"] : []),
    ...(protectedReason ? [protectedReason] : []),
  ];
  if (!reasons.length) return { action: "allow" };

  return {
    action: "judge",
    call: {
      tool: event.toolName as "write" | "edit",
      summary: `${event.toolName} ${resolved.relativePath ?? resolved.absolute}`,
      path: resolved.absolute,
      relativePath: resolved.relativePath,
      outsideCwd: resolved.outside,
      reasons,
      ...(Array.isArray(event.input.edits) ? { editCount: event.input.edits.length } : {}),
      ...(typeof event.input.content === "string" ? { contentLength: event.input.content.length } : {}),
    },
  };
}
