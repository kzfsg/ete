# ete phase 3 — everything moves to the agent

Date: 2026-09-14
Status: approved design
Supersedes the LLM parts of phase 1 and phase 2 specs.

## Decision

ete no longer calls any model. The user's coding agent (Claude Code, Codex, anything that can run a
shell command) is the only intelligence: it authors tests, resolves steps, and heals broken ones by
driving a **session**. ete records, replays, checks, captures anomalies, and reports. No API key,
anywhere. CI replay was already key-free; now authoring and healing are too.

Removed: `ete explore`, `ete author`, the resolver, self-heal, `llm:` and `heal:` config, the AI SDK
dependencies, the `resolved` and `healed` step statuses.

## 1. Sessions

A session is a live browser plus a recorder, owned by a background daemon so it survives across
CLI invocations. State lives in `ete-results/.session/`.

```
ete session start --name "<test name>" [--flow <Flow>] [--url <url>]
ete session start --from e2e/checkout/pay.yaml --at 4      # heal/extend: replays steps 1..3 first
ete session observe                                        # url, a11y tree, screenshot path
ete session act goto <path|url>
ete session act click <selector>
ete session act type <selector> <text>
ete session act press <key>
ete session act scroll <dy> [selector]
ete session act wait <ms>
ete session expect text <text>
ete session expect visible <selector>
ete session expect url <regex>
ete session undo                                           # drop the last recorded step (browser state unchanged)
ete session status                                         # recorded steps so far
ete session save [--out <path>]                            # write yaml + resolved, finish recording, stop
ete session abort                                          # discard, stop
```

Every `act`/`expect` takes `--as "<step text>"` to override the natural-language step text
(default from `describeEntry`). Every `act`/`expect` prints the outcome, anomalies, and a fresh
observation (url, a11y tree, screenshot path) so the agent rarely needs a separate `observe`.

**Recording rules.** A successful act or expect is recorded as a step with its concrete entry, so
the saved test replays with no resolution. A **failed act is not recorded**: it is an attempt; the
error is returned and the agent tries something else. A **failed expect is not recorded** either,
unless `--record` is passed (to deliberately capture a known failure). Each recorded step is wrapped
in `beginStep`/`endStep` (trace group, timestamps, anomalies) and screenshotted.

**Resume (`--from --at N`).** The daemon replays steps 1..N-1 from the resolved cache. If one fails,
`start` fails and says which. Recorded steps then continue from N; on `save`, the file becomes
steps 1..N-1 + the newly recorded steps, and the resolved file is rewritten to match.

**Daemon.** `ete session start` spawns `ete session serve …` detached; the server starts the app
(`start` from config), launches the driver, and listens on `127.0.0.1:<random>` with a per-session
token, writing `ete-results/.session/server.json` (`port`, `token`, `pid`). Client commands read it.
`save`/`abort` stop the driver, the app, and the daemon. `start` refuses if a session exists
(`abort` first). A stale `server.json` whose pid is dead is cleaned up automatically.

`save` writes `ete-results/<slug>/` (report.json with `mode: 'session'`, video, trace, steps/,
filmstrip) plus `e2e/<flow>/<slug>.yaml` and `e2e/.resolved/<flow>/<slug>.json`.

## 2. `ete run` without a model

Unchanged replay, but when a step has no cached entry or its cached entry fails, the step fails
and the output ends with the exact resume command:

```
✗ 4. click "Pay now" — Timeout 5000ms waiting for role=button[name="Pay"]
   fix: ete session start --from e2e/checkout/pay.yaml --at 4
```

`RunOptions` loses `resolver`, `heal`, `ci`. `--ci` remains accepted as a no-op for compatibility.
`Report.mode` is `'replay' | 'session'`.

## 3. Healing in CI

The Action replays. On failure the PR comment shows the failing step, its screenshot in the
filmstrip, and the resume command. `ete init` writes the workflow with a commented second job,
gated on failure, that runs the user's agent action with the `/ete` skill; the agent resumes the
session at the failing step, fixes it, and pushes. Auth is the agent's own. ete documents this and
never holds credentials.

## 4. The `/ete` skill

Rewritten around sessions: for each requested flow, `session start`, loop `observe` →
`act`/`expect` until the goal is met, `save`; then `ete run` to prove replay; commit. For a failure
(local or from a PR comment): `session start --from <file> --at N`, fix, `save`, `ete run <file>`.

## 5. Testing

- core: `Recorder` (steps, attempts not recorded, `--record` failures, telemetry, screenshots,
  finish → report/test/resolved with matching hashes, resume merge).
- cli: session server in-process against the fixture (start, observe, act, expect, undo, save
  produces a replayable test that `run` passes; failed act not recorded; resume replays prefix and
  merges); daemon lifecycle via the real CLI (start → status → abort; stale pid cleanup).
- runner/run: missing cache → failed with resume hint; no resolver anywhere.
- action: comment without healed section, with resume hint for failures.
