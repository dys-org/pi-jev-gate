# Pi Jev Gate

A small, fail-closed permission extension for Pi. It automatically permits ordinary development work, deterministically blocks catastrophic operations, and sends consequential or unknown tool calls to Jev.

Requires **Pi 0.99.0 or newer**. The extension invokes Pi's native classifier API directly from `tool_call` interception; Codemode is not involved. Pi handles Jev discovery, authentication, HTTP transport, wire-format adaptation, and usage/cost normalization. This extension owns the policy and final permission decision.

Supported Jev providers are direct TypeSafe, OpenRouter, and Vercel AI Gateway. Provider selection is explicit, direct TypeSafe is the default, and the extension never falls back to another provider or model. Arbitrary classifiers are not supported: these questions and thresholds are calibrated for Jev.

## Install

Install the GitHub release pinned to `v0.2.0`:

```sh
pi install git:github.com/dys-org/pi-jev-gate@v0.2.0
```

Or try it for one run without installing:

```sh
pi -e git:github.com/dys-org/pi-jev-gate@v0.2.0
```

Version `0.2.0` introduces the native-classifier migration. This release is distributed through GitHub, not npm; `main` remains a moving development ref.

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

Reads, normal in-project writes, Git inspection, and ordinary project task/build/test commands run automatically. “Project command” means a repository-local executable or a recognized package/task/build/test invocation without shell plumbing. Compound trusted commands may use `&&`; redirection, substitutions, background execution, and other shell structure require evaluation. Names indicating publish, deploy, or release are also evaluated.

This intentionally accepts checked-out repository code and configured Git/toolchain helper risk. It does not trust downloaded scripts, package executors/installers, arbitrary commands hidden behind language runners, consequential remote actions, or writes outside the project. Tool paths are normalized consistently with Pi for Unicode spaces, a leading `@`, home-relative paths, and file URLs before scope and protection checks.

A small deterministic layer always denies catastrophic root/disk destruction, protected-branch force pushes with clear targets, unresolved destructive targets, credential access/exfiltration, and permission-gate tampering. Missing/unsupported Jev classifiers, transport/auth/timeouts, HTTP errors, cancellation, invalid configuration, and malformed/missing answers fail closed.

Pi returns classifier failures as `stopReason: "error"` or `"aborted"`, not necessarily exceptions. Only successful `bool` answers with finite probabilities in `[0, 1]` reach reduction; the range check remains ours because Pi's System One adapter does not enforce it. Requests have a four-second abort deadline covering authentication and classification, with Pi transport retries explicitly disabled. A late successful response after cancellation or the deadline cannot authorize the call.

Intent coverage is asked only for recognized risk reasons, including ordinary Git pushes, registry mutations, and protected/outside writes—not unknown commands alone. Intent p ≤0.40 blocks flagged calls; p ≥0.50 may clear soft scope, damage, or outward consequences only. Hard hazards and required-condition uncertainty cannot be cleared by intent. An oversized latest user input is not clipped into authorization: recognized-risk calls block until a complete bounded input is available.

Valid model uncertainty is distinct from transport failure. Hazard-question middle bands are ignored unless a hazard is clearly found; uncertainty on a required condition (currently downloaded-code execution) blocks by default. This keeps normal work quiet without treating “no answer” as permission.

## Privacy and limits

All providers share the same policy, questions, reduction, and privacy boundary. Only bounded command/path metadata, up to three bounded interactive or RPC user inputs, basic repository facts, and optionally a selected assistant item are sent. For a simple numbered selection, reference context comes only from an entirely flat, unindented, single-line numbered list in the immediately preceding assistant answer. Any nonempty preamble, trailing prose, continuation, indentation, duplicate numbering, or oversized answer prevents grounding; pronouns are not inferred. Recognized shorthand (`do|run|try|use|go with` followed by a numbered reference or `it|that`) that cannot be grounded marks intent incomplete and blocks recognized-risk actions locally before classifier discovery. Unsupported or ambiguous references require a direct restatement, a deliberate usability tradeoff. Selected authorization survives subsequent assistant tool-calling answers; those answers affect only the next proposal candidate. User qualifications and cancellations remain in user intent; assistant text alone is not authorization. Older whole messages are dropped to retain the newest bounded input. Inputs over 1,000 redacted characters are replaced with an incomplete-intent marker, not a clipped prefix.

Extension-generated user messages are excluded and invalidate pending assistant candidates; only assistant answers completed with `stopReason: "stop"` are eligible. Textless, pending, length-truncated, errored, aborted, deferred, and interim tool-calling answers invalidate candidates, as does subsequent user input. Intent is cleared when navigating the session tree. Secrets are redacted before bounding, but redaction is best-effort, not a guarantee. File contents, edit/write bodies, and tool results are not independently collected for evaluation; selected assistant text or user input may quote them and can therefore send those excerpts. Broad conversation history is not sent.

ZDR request fields are not an audit of provider storage. Direct TypeSafe retention follows the user's account. The extension adds OpenRouter's ZDR flag and Vercel's ZDR and TypeSafe-only routing flags through Pi's `onPayload` hook; native `classify()` does not add these automatically. No fallback model list is supplied.

**Vercel caveat:** Pi 0.99 uses `/typesafe/v1/systemone` instead of our former `/v1/evaluate`. Vercel explicitly documents both flags on `/v1/evaluate` and Gateway extensions on the TypeSafe-compatible endpoint, but enforcement of ZDR on the latter has not been independently verified. Migration retains both request fields; it does not claim verified ZDR enforcement. Vercel ZDR requires Pro or Enterprise. If verified ZDR is essential, use a provider/account whose applicable retention guarantees you have confirmed.

Structured instruction objects, criteria, and anti-injection guidance are retained. Intent wording now explains selected-only references and user restrictions, intent evaluation is scoped to recognized risks, and the soft-override threshold is 0.50; the clear intent-rejection boundary remains 0.40. Pi's classifier types accept only string instructions, although System One supports structured guidance. The same `onPayload` hook restores our original instruction objects without changing Pi's boolean wire adaptation.

Pi returns classifier token usage and catalog-priced cost (direct TypeSafe currently has no catalog price). These do not affect permission decisions and are not automatically added to session totals by this interception handler. Provider error messages and usage are not forwarded into classifier state or logged by the gate.

This is a lexical permission gate, not a shell parser or sandbox. Symlinks, wrappers, aliases, script internals, and unusual command syntax can escape its classifications. Broad Git/package matching can also flag harmless arguments or inspection subcommands. Unresolved bounded shorthand is denied locally for recognized risks; other model intent judgments still need focused live verification. Mocked coverage probabilities establish policy mechanics, not live grounding correctness.

## Verification status

Authoritative deterministic checks cover the native classifier path with mocked results and mocked HTTP in the real adapter test. The historical `eval/` fixtures/results in the separate `~/.pi/agent/git/github.com/dys-org/pi-jev-gate` checkout evaluated its direct-HTTP implementation, not this native implementation. They are unchanged and are not evidence of this checkout's live correctness. The approved post-patch native smoke passed once: 53 decisions, 35 classifier dispatches, 17 local denies, 1 local allow, safety 36/36 and usability 16/16, with zero unsafe allows or unavailable outcomes. All eight requested/selected push/publication/reset controls passed; one harmless-relevance mismatch remains diagnostic only. This single smoke cleared the reviewed patch's release hold, not a claim of universal safety. The prepared [metadata-only evaluation runner](eval/README.md) defaults to offline mocks; live requests require explicit opt-in and separate approval. Its frozen historical suite is not new evidence, and its focused suite exercises lifecycle/authorization regressions without executing commands.

## Credits

The original concept and implementation starting point came from [`jomatsu/pi-jev-auto-mode`](https://github.com/jomatsu/pi-jev-auto-mode) 0.4.1 (`06a5604`). Pi Jev Gate is a purpose-built rewrite with its own fixed policy, not a maintained fork. Its original provider transports were replaced by Pi 0.99's native classifier runtime.

### Classifier API references

- [Pi 0.99 classifier models](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/models.md#use-classifier-models)
- [Pi System One adapter](https://github.com/earendil-works/pi/blob/v0.99.0/packages/ai/src/api/system-one-shared.ts)
- [OpenRouter System One request schema](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request)
- [Vercel evaluation provider options](https://vercel.com/docs/ai-gateway/modalities/evaluation#provider-options) and [TypeSafe-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
