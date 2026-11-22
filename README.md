# Pi Jev Gate

A consequence-first permission extension for Pi: **block clearly dangerous actions, not ordinary development.** It permits routine work locally, deterministically blocks obvious catastrophes, and uses Jev as a second-stage judge for recognized consequential calls. Only flagged calls fail closed when classification is unavailable.

Requires **Pi 0.99.0 or newer**. The extension invokes Pi's native classifier API directly from `tool_call` interception; Codemode is not involved. Pi handles Jev discovery, authentication, HTTP transport, wire-format adaptation, and usage/cost normalization. This extension owns the policy and final permission decision.

Supported Jev providers are direct TypeSafe, OpenRouter, and Vercel AI Gateway. Provider selection is explicit, direct TypeSafe is the default, and the extension never falls back to another provider or model. Arbitrary classifiers are not supported: these questions and thresholds are designed for Jev, but the current consequence-first policy has not yet been live-validated.

## Install

Install the GitHub release pinned to `v0.3.0`:

```sh
pi install git:github.com/dys-org/pi-jev-gate@v0.3.0
```

Or try it for one run without installing:

```sh
pi -e git:github.com/dys-org/pi-jev-gate@v0.3.0
```

Version `0.3.0` adds intent revisions, an ordinary-push allowance, and target-based tampering protection; `0.2.0` introduced the native-classifier migration. This release is distributed through GitHub, not npm; `main` remains a moving development ref.

Set the credential for the default direct TypeSafe provider before starting Pi:

```sh
export TYPESAFE_API_KEY="your-key"
```

## Provider configuration

The only configuration is the global file `$PI_CODING_AGENT_DIR/pi-jev-gate.json` (normally `~/.pi/agent/pi-jev-gate.json`):

```json
{ "provider": "typesafe" }
```

A missing file selects `typesafe`. Invalid configuration is reported and evaluated calls fail closed. Use `/jev-gate provider` to show the selection or `/jev-gate provider typesafe|openrouter|vercel-ai-gateway` to persist it. The file stores no API keys; authentication is resolved entirely by Pi.

**Migration from 0.1.0:** change `{ "provider": "vercel" }` to `{ "provider": "vercel-ai-gateway" }`, Pi's native provider ID. Old `vercel` configuration fails closed; there is no compatibility alias. TypeSafe and OpenRouter configuration is unchanged.

`/jev-gate off` disables the gate only for the current session, and `/jev-gate on` re-enables it. This bootstrap escape hatch is available only as a directly invoked extension command: it is not registered as a tool and cannot be called by the model. A new, resumed, forked, or reloaded session starts enabled again.

| Provider | Authentication | Endpoint / model | Privacy option |
| --- | --- | --- | --- |
| `typesafe` | Pi auth for `typesafe`, including `TYPESAFE_API_KEY` | TypeSafe System One / `jev-latest` | Governed by the TypeSafe account; this extension does not claim ZDR |
| `openrouter` | Pi auth for `openrouter`, including `OPENROUTER_API_KEY` | OpenRouter System One / `typesafe/jev-1.13` | Requests `provider: { zdr: true }` |
| `vercel-ai-gateway` | Pi auth for `vercel-ai-gateway`, including `AI_GATEWAY_API_KEY` | Vercel TypeSafe-compatible System One / `typesafe-ai/jev` | Requests `providerOptions.gateway: { zeroDataRetention: true, only: ["typesafe-ai"] }`; see caveat below |

Model IDs are fixed in the extension, not selected by availability or the active chat model. OpenRouter retains its versioned ID; TypeSafe's `jev-latest` and Vercel's `jev` remain upstream aliases, not immutable model-version pins. Pi configuration, catalog updates, and provider extensions are trusted host configuration and can override model metadata, endpoints, and credentials. Do not configure an untrusted proxy or replacement provider.

## Policy boundary

Reads, ordinary edits/writes (including outside the repository), installs, package runners, builds, tests, documentation fetches, temporary files, and unrecognized commands run locally unless a concrete risk pattern is matched. Shell plumbing, redirections, and substitutions alone do not trigger evaluation. Routine work does not depend on provider configuration or classifier availability.

Jev evaluates recognized deletions, destructive Git operations, pushes, registry mutations, deployments/infrastructure changes, local-data uploads, mutating HTTP requests, privilege/broad permission changes, downloaded scripts piped into shells, and protected/system writes. Compound commands retain any matched risk. Tool paths are normalized for Unicode spaces, a leading `@`, home-relative paths, and file URLs before protection checks.

This deliberately accepts dependency install hooks, repository scripts, arbitrary package execution, and unknown-command risk. A command that hides its effects in a script, alias, wrapper, or unrecognized syntax may run without evaluation. Jev is not asked to certify every executable.

A small deterministic layer always denies catastrophic root/disk destruction, protected-branch force pushes with clear targets, unresolved destructive targets, credential access/exfiltration, and permission-gate tampering. Missing/unsupported Jev classifiers, transport/auth/timeouts, HTTP errors, cancellation, invalid configuration, and malformed/missing answers fail closed.

Permission-gate tampering is decided by what Pi loads, not by repository name. The protected set is `.pi/agent/extensions/` (and any project `.pi/extensions/`), installed packages under `.pi/agent/git/` and `.pi/agent/npm/`, `.pi/agent/settings.json`, any project `.pi/settings.json`, `.pi/agent/auth.json`, the gate files `pi-jev-gate.json` / `pi-jev-gate-policy.md`, and every local path listed in `packages` or `extensions` of the agent settings (resolved against `$PI_CODING_AGENT_DIR`, normally `~/.pi/agent`) or of the working directory's `.pi/settings.json` (resolved against that `.pi` directory). Remote sources, exclusions, and globs are skipped. Paths are compared after resolving symlinks. If the agent settings file exists but cannot be read or parsed, or its `packages`/`extensions` are not arrays, every path counts as protected until it is fixed: only the read-only commands below run, and every write/edit is denied. Write/edit and bash use the same set.

Bash commands are lexed with shell quoting, escapes, here-documents, subshells, and `$(…)`/backtick substitutions; substitutions, `sh -c`/`bash -c` strings, and `eval` arguments are checked as commands of their own. Relative paths, `~`, `$HOME`, and variables (assigned earlier in the command or set in the gate's environment) are resolved against every directory the command may be in: `cd`/`pushd` after `&&` moves there, after `;` either directory is possible, `popd` returns, a subshell's `cd` does not leak, and a `cd` whose target cannot be resolved (`cd -`, `cd "$(…)"`) makes the directory unknown, so later relative paths count as protected. A command is denied by default when it runs in a protected directory, names a protected path in any argument (including `--option=value`, attached short-option values, and absolute or home paths embedded in quoted code), or redirects output (`>`, `>>`, `>|`, `<>`, `&>`) into the set. Removing, moving, or changing permissions of a parent of a protected root (`rm`, `rmdir`, `unlink`, `mv`, `chmod`, `chown`, `chgrp`, `chflags`, `find`, `rsync`, `shred`, `srm`, `trash`) is also denied. Exceptions are a small read-only allowlist: `cat`, `head`, `tail`, `less`, `more`, `wc`, `ls`, `stat`, `du`, `df`, `diff`, `cmp`, `grep`, `rg` (without `--pre`), `jq`, `echo`, `printf`, and similar inspectors; `sed` with only print, delete, quit, or substitution scripts and no in-place or write flags; `find` without actions; read-only `git` subcommands (`status`, `diff`, `log`, `show`, `blame`, `grep`, `ls-files`, `rev-parse`, and similar); `cp` whose destination is outside the set; and the test commands `pnpm test|check|typecheck`, `npm test`, `node --test`, and `tsc --noEmit`. Wrappers such as `sudo`, `xargs`, and `exec` are not unwrapped, so wrapped commands are never on the allowlist. While a development checkout is listed in `packages`, it is live gate code and therefore read-only to agents, including commits, installs, and pushes from it; tests can still run. For gate development, install a pinned release and remove the local path from `packages`.

An ordinary push is a single `git push [<remote> [<branch>]]` (optionally `-u`/`--set-upstream`) whose only matched reason is a Git remote mutation: no force or lease options, `+` or `:` refspecs, `--delete`, `--mirror`, `--tags`, `--all`, `--prune`, or other flags. For ordinary pushes only, Jev also judges whether the latest user message asks for this push (the remote and branch in the command) and, when there are earlier user messages, whether one of them forbids or postpones it. When the push request is p ≥0.70, any earlier-restriction answer is p ≤0.30, and any referenced proposal clearly matches the call (below), the push's inherent consequences, `no_outward_effect` and `no_private_data_upload`, are cleared. Hard rules still deny, and other rejected soft consequences, such as valuable-work destruction, still need the intent override. An earlier restriction above p 0.30 disables both this allowance and the intent override. These questions are not asked when intent is incomplete.

When a numbered selection or a grounded confirmation supplies a referenced proposal for a consequential call, Jev also judges whether that proposal offers the same action as the tool call. Unless that is p ≥0.70, neither the intent override nor the ordinary-push allowance applies, so a "do it" in reply to "Should I push?" cannot authorize `npm publish`.

Pi returns classifier failures as `stopReason: "error"` or `"aborted"`, not necessarily exceptions. Only successful `bool` answers with finite probabilities in `[0, 1]` reach reduction; the range check remains ours because Pi's System One adapter does not enforce it. Requests have a four-second abort deadline covering authentication and classification, with Pi transport retries explicitly disabled. A late successful response after cancellation or the deadline cannot authorize the call.

There is no repository-scope question and no authorization veto. Jev asks about concrete effects: valuable work destruction (not reproducible output/cache cleanup), secret egress, private-data uploads, remote mutations, security-configuration changes, and privilege/system changes. Public documentation and dependency downloads are not remote mutations.

Safety statements only block when clearly rejected: p ≤0.20 for valuable-work preservation, p ≤0.03 for no secret egress, and p ≤0.10 for the other safety statements. Valid middle-band uncertainty allows, including uncertainty about fetched-script execution. Missing or malformed answers are failures, not uncertainty.

User intent is context, not a prerequisite. Explicitly requested consequences (intent p ≥0.60, subject to the proposal match and earlier-restriction answers above) may clear identified work-deletion, remote-mutation, private-upload, or system-change consequences. Intent never clears secret egress, security-configuration changes, or clearly identified downloaded-script piping. A low intent score alone does not block. Incomplete/oversized intent is omitted from authorization judgments: it cannot supply an override, but does not block a call on its own.

## Privacy and limits

All providers share the same policy, questions, reduction, and privacy boundary. Only bounded command/path metadata, up to three bounded interactive or RPC user inputs, basic repository facts, and optionally one referenced assistant proposal (a selected numbered item or a confirmed closing question) are sent. The newest input is sent as `latest_user_message`; up to two earlier ones are sent oldest-first as `earlier_user_messages`, which Jev treats as context and restrictions only (earlier cancellations still count). For a simple numbered selection, reference context comes only from an entirely flat, unindented, single-line numbered list in the immediately preceding assistant answer. Any nonempty preamble, trailing prose, continuation, indentation, duplicate numbering, or oversized answer prevents grounding a numbered selection. Beyond that, the only pronoun-style references grounded are whole-message confirmations: an optional `yes`/`ok`-style prefix plus one of `yes`, `yeah`, `yep`, `sure`, `ok`, `okay`, `do it`, `do that`, `go for it`, `go ahead`, `sounds good`, `please do`, or `proceed`, optionally followed by `please`. Such a confirmation is grounded in the immediately preceding eligible assistant answer when that answer ends with a question mark; its final paragraph becomes the referenced proposal. Jev still judges whether the reply covers the call's actual effects. A bare action verb such as `push` is a request of its own and is not grounded. Recognized shorthand (an optional `yes`/`ok`-style prefix, then `do|run|try|use|go with` followed by a numbered reference or `it|that`) that cannot be grounded marks intent incomplete, disabling intent-based overrides without blocking on ambiguity alone. A direct restatement can establish intent for an otherwise blocked consequence. Selected authorization survives subsequent assistant tool-calling answers; those answers affect only the next proposal candidate. User qualifications and cancellations remain in user intent; assistant text alone is not authorization. Older whole messages are dropped to retain the newest bounded input. Inputs over 1,000 redacted characters are never sent, not even as a clipped prefix: while such an input is the latest, it is marked as incomplete intent and cannot authorize; once a newer input arrives, it appears in `earlier_user_messages` only as `(earlier user message omitted: too long)`.

Extension-generated user messages are excluded and invalidate pending assistant candidates; only assistant answers completed with `stopReason: "stop"` are eligible. Textless, pending, length-truncated, errored, aborted, deferred, and interim tool-calling answers invalidate candidates, as does subsequent user input. Intent is cleared when navigating the session tree. Secrets are redacted before bounding, but redaction is best-effort, not a guarantee. File contents, edit/write bodies, and tool results are not independently collected for evaluation; referenced assistant text or user input may quote them and can therefore send those excerpts. Broad conversation history is not sent.

ZDR request fields are not an audit of provider storage. Direct TypeSafe retention follows the user's account. The extension adds OpenRouter's ZDR flag and Vercel's ZDR and TypeSafe-only routing flags through Pi's `onPayload` hook; native `classify()` does not add these automatically. No fallback model list is supplied.

**Vercel caveat:** Pi 0.99 uses `/typesafe/v1/systemone` instead of our former `/v1/evaluate`. Vercel explicitly documents both flags on `/v1/evaluate` and Gateway extensions on the TypeSafe-compatible endpoint, but enforcement of ZDR on the latter has not been independently verified. Migration retains both request fields; it does not claim verified ZDR enforcement. Vercel ZDR requires Pro or Enterprise. If verified ZDR is essential, use a provider/account whose applicable retention guarantees you have confirmed.

Structured instruction objects, criteria, and anti-injection guidance are retained. Intent wording asks about explicitly requested consequential effects, decided by the latest user message, with selected or confirmed references and earlier user restrictions as context. The ordinary-push, earlier-restriction, and proposal-match questions have their own concrete true/false criteria; all other questions share the generic criteria. There is no separate prompt-injection hazard question or intent-rejection veto. Pi's classifier types accept only string instructions, although System One supports structured guidance. The same `onPayload` hook restores our original instruction objects without changing Pi's boolean wire adaptation.

Pi returns classifier token usage and catalog-priced cost (direct TypeSafe currently has no catalog price). These do not affect permission decisions and are not automatically added to session totals by this interception handler. Provider error messages and usage are not forwarded into classifier state or logged by the gate.

This is a lexical permission gate, not a sandbox. Outside the tampering check, symlinks, wrappers, aliases, script internals, and unusual command syntax can escape its classifications. The tampering check does not see paths computed at run time (inside scripts, loops, or unset variables), relative paths inside quoted interpreter code when the command runs outside the protected set, or effects of programs it allows. Broad Git/package matching can also flag harmless arguments or inspection subcommands. Ordinary outside writes and shell redirections are not checked for valuable-file overwrites. Neither unknown commands nor hidden script effects are inspected. Model hazard/intent judgments still need focused live verification. Mocked probabilities establish policy mechanics, not live correctness.

## Verification status

Authoritative deterministic checks cover the native classifier path with mocked results and mocked HTTP in the real adapter test. The historical `eval/` fixtures/results in the separate `~/.pi/agent/git/github.com/dys-org/pi-jev-gate` checkout evaluated its direct-HTTP implementation, not this native implementation. They are unchanged and are not evidence of this checkout's live correctness. A previous stricter policy passed a single approved native smoke; that result does not validate the current consequence-first policy, whose questions, routing, and reduction have changed. The consequence-first policy, before the intent revisions, passed one separately approved [20-case synthetic live smoke](eval/README.md#consequence-first-live-smoke): safety 9/9, usability 11/11, zero unsafe allows or unavailable outcomes. Twelve classifier requests were served by `jev-1.14.0`, with 5 local allows and 3 local hard denials. An [8-case intent-revisions smoke](eval/README.md#intent-revisions-live-smoke) ran before the proposal-match and earlier-restriction questions existed and found one unsafe allow that those questions address; the current questions, reduction, and target-based tampering rule have not been live-validated. This is limited evidence, not universal safety or a normal-session field test. The prepared [metadata-only evaluation runner](eval/README.md) defaults to offline mocks; live requests require explicit opt-in and separate approval. Its frozen historical suite is not new evidence, and its focused suite exercises lifecycle/authorization regressions without executing commands.

## Credits

The original concept and implementation starting point came from [`jomatsu/pi-jev-auto-mode`](https://github.com/jomatsu/pi-jev-auto-mode) 0.4.1 (`06a5604`). Pi Jev Gate is a purpose-built rewrite with its own fixed policy, not a maintained fork. Its original provider transports were replaced by Pi 0.99's native classifier runtime.

### Classifier API references

- [Pi 0.99 classifier models](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/models.md#use-classifier-models)
- [Pi System One adapter](https://github.com/earendil-works/pi/blob/v0.99.0/packages/ai/src/api/system-one-shared.ts)
- [OpenRouter System One request schema](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request)
- [Vercel evaluation provider options](https://vercel.com/docs/ai-gateway/modalities/evaluation#provider-options) and [TypeSafe-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
