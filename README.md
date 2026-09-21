# Pi Jev Gate

A small, fail-closed permission extension for Pi. It automatically permits ordinary development work, deterministically blocks catastrophic operations, and sends consequential or unknown tool calls to Jev.

The extension supports direct TypeSafe, OpenRouter Decisions, and Vercel AI Gateway. Provider selection is explicit, direct TypeSafe is the default, and providers never fall back to one another.

## Install

Install from npm:

```sh
pi install npm:@dys-org/pi-jev-gate
```

Or install the tagged Git release:

```sh
pi install git:github.com/dys-org/pi-jev-gate@v0.1.0
```

Or try it for one run without installing:

```sh
pi -e git:github.com/dys-org/pi-jev-gate@v0.1.0
```

Set the credential for the default direct TypeSafe provider before starting Pi:

```sh
export TYPESAFE_API_KEY="your-key"
```

## Provider configuration

The only configuration is the global file `$PI_CODING_AGENT_DIR/pi-jev-gate.json` (normally `~/.pi/agent/pi-jev-gate.json`):

```json
{ "provider": "typesafe" }
```

A missing file selects `typesafe`. Invalid configuration is reported and evaluated calls fail closed. Use `/jev-gate provider` to show the selection or `/jev-gate provider typesafe|openrouter|vercel` to persist it. No API keys are stored.

`/jev-gate off` disables the gate only for the current session, and `/jev-gate on` re-enables it. This bootstrap escape hatch is available only as a directly invoked extension command: it is not registered as a tool and cannot be called by the model. A new, resumed, forked, or reloaded session starts enabled again.

| Provider | Authentication | Endpoint / model | Privacy option |
| --- | --- | --- | --- |
| `typesafe` | `TYPESAFE_API_KEY` | `https://api.typesafe.ai/v1/systemone` / `jev-latest` | Governed by the TypeSafe account; this extension does not claim ZDR |
| `openrouter` | Pi provider auth for `openrouter` | OpenRouter Decisions / `typesafe/jev-1.13` | `provider: { zdr: true }` |
| `vercel` | Pi provider auth for `vercel-ai-gateway` | `https://ai-gateway.vercel.sh/v1/evaluate` / `typesafe-ai/jev` | TypeSafe-only routing and `providerOptions.gateway.zeroDataRetention: true`; Vercel ZDR requires Pro or Enterprise |

## Policy boundary

Reads, normal in-project writes, Git inspection, and ordinary project task/build/test commands run automatically. “Project command” means a repository-local executable or a recognized package/task/build/test invocation without shell plumbing. Compound trusted commands may use `&&`; redirection, substitutions, background execution, and other shell structure require evaluation. Names indicating publish, deploy, or release are also evaluated.

This intentionally accepts checked-out repository code and configured Git/toolchain helper risk. It does not trust downloaded scripts, package executors/installers, arbitrary commands hidden behind language runners, consequential remote actions, or writes outside the project. Tool paths are normalized consistently with Pi for Unicode spaces, a leading `@`, home-relative paths, and file URLs before scope and protection checks.

A small deterministic layer always denies catastrophic root/disk destruction, protected-branch force pushes with clear targets, unresolved destructive targets, credential access/exfiltration, and permission-gate tampering. Transport/auth/timeouts, HTTP errors, cancellation, invalid configuration, and malformed/missing answers fail closed.

Valid model uncertainty is distinct from transport failure. Hazard-question middle bands are ignored unless a hazard is clearly found; uncertainty on a required condition (currently downloaded-code execution) blocks by default. This keeps normal work quiet without treating “no answer” as permission.

## Privacy and limits

All providers share the same policy, questions, reduction, and privacy boundary. Only bounded, redacted command/path metadata, up to three bounded interactive or RPC user inputs, and basic repository facts are sent. Extension-generated user messages are excluded, intent is cleared when navigating the session tree, and secrets are redacted before truncation. File contents, edit/write bodies, tool results, and broad conversation history are not sent.

ZDR request fields are not an audit of provider storage. Direct TypeSafe retention follows the user's account. OpenRouter receives its ZDR routing flag. Vercel receives its ZDR flag and TypeSafe-only routing, but Vercel ZDR requires Pro or Enterprise.

This is a lexical permission gate, not a shell parser or sandbox. Symlinks, wrappers, aliases, script internals, and unusual command syntax can escape its classifications.

## Credits

The original concept and implementation starting point came from [`jomatsu/pi-jev-auto-mode`](https://github.com/jomatsu/pi-jev-auto-mode) 0.4.1 (`06a5604`). Pi Jev Gate is a purpose-built rewrite with its own fixed policy and provider transports, not a maintained fork.
