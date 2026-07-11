# Security

## Reporting a vulnerability

Please report security issues privately via the GitHub repository's **Report a vulnerability** button (*Security* tab → *Report a vulnerability*). This opens a private advisory visible only to repository maintainers. Do **not** open a public GitHub issue for suspected vulnerabilities.

(Maintainers: enable this under repo *Settings* → *Code security and analysis* → *Private vulnerability reporting*.)

We aim to:

- Acknowledge new reports within **3 business days**.
- Provide an initial assessment within **7 business days**.
- Coordinate a fix and disclosure timeline with the reporter.

## Scope

`@icxcoffee/chorus` is a Pi extension that:

- spawns the local `pi` binary as a detached child process in **subagent mode** (one per voice),
- issues outbound HTTPS requests to model provider endpoints in **direct mode**,
- stores run history (prompts, model responses, error messages) under `~/.pi/agent/chorus/`,
- persists background job snapshots and active preset configuration in the same directory.

Security-sensitive surface includes:

- subprocess execution and argument handling (`src/subagent.ts`),
- outbound HTTP endpoint validation (`src/providers/adapters.ts`),
- credential / token redaction in errors before persistence (`src/utils/redact.ts`),
- retention of on-disk run history (`src/store.ts`).

## Threat model summary

| Threat | Mitigation |
| --- | --- |
| Bearer / API-key leakage via provider error bodies or stack traces | `redactSensitive()` is applied to all stderr and HTTP error bodies before they enter `VoiceResult.errorMessage`, `history.jsonl`, and `jobs.json`. |
| SSRF / endpoint abuse in direct mode | `assertSafeEndpoint()` rejects non-https endpoints (except localhost) and link-local / cloud-metadata IPs — including IPv4-mapped IPv6 wrappers (`::ffff:169.254.169.254`) and DNS metadata hostnames (`metadata.google.internal`) — before any credentials are attached. |
| `pi` binary hijacking via `$PATH` in untrusted cwd | `resolvePiBinary()` resolves `pi` to an absolute path on `$PATH`; `resolveSubagentCwd()` refuses world-writable cwd (override: `CHORUS_ALLOW_UNSAFE_CWD=1`). |
| Process group orphaning on Windows | `terminateSubagentProcess()` uses `taskkill /T /F` on `win32` instead of `process.kill(-pid)`. |
| Prompt-injection via voice outputs in synthesis | Conductor system prompt explicitly treats voice blocks as untrusted data and instructs the model to ignore embedded directives. |
| Sensitive data accumulation in `history.jsonl` | Default retention cap of `HISTORY_MAX_ENTRIES = 1000`; manual prune via `/chorus history prune [N]`; `~/.pi/agent/chorus/` is created with owner-only permissions. |

## Hardening tips for operators

- Treat `~/.pi/agent/chorus/` as sensitive: do not commit it, do not sync it to cloud backup without encryption.
- Use `/chorus history prune [N]` periodically if you regularly run Chorus on sensitive prompts.
- Use **subagent mode** only from a private working directory (the `cwd` world-writable check guards against this).
- Configure providers with scoped keys (per-project / per-environment) rather than global admin keys.

## Out of scope

- Vulnerabilities in upstream packages (`@earendil-works/pi-ai`, Pi itself, Node.js, Vitest, etc.). Report those to the maintainers of the affected project.
- Social-engineering, phishing, or physical-access attacks.
- Issues that require an attacker to already have shell or `pi` CLI access on the machine running Chorus.
