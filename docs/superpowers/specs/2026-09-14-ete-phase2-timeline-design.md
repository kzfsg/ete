# ete phase 2 — flows, timeline, PR media, exploratory runs

Date: 2026-09-14
Status: approved design
Builds on: `2026-09-14-ete-design.md` (phase 1, shipped on `feat/phase1`)

## Goal

The ideal user flow:

1. In Claude Code: `/ete build 3 user flows, from logging in to checking out the cart`.
   The agent explores each flow in a real browser, records it, flags anomalies, and saves
   it as a replayable test, grouped under a flow name.
2. On the pull request, one comment shows each flow with a filmstrip of the run, pass/fail,
   and a link to a timeline where a reviewer can rewind, jump to any click, assertion,
   failure, or anomaly, and inspect what happened.

## Constraints carried forward

- CI runs are deterministic replay. The agent runs a flow itself only when asked
  (`ete explore`), never on every push.
- The LLM never judges pass/fail.
- GitHub does not render video or images in workflow-posted comments unless they are
  hosted at a fetchable URL. We host media on a branch in the user's repo and link out
  for full playback. This is stated in the docs, not hidden.

## 1. Flows

A test belongs to a flow. `flow:` in the yaml; if absent, the directory name under `e2e/`
(`e2e/checkout/pay.yaml` -> `Checkout`, title-cased, dashes to spaces); if the file is
directly in `e2e/`, `General`.

`Report` gains `flow: string`. `ete run` output and the PR comment group by flow.

## 2. Driver step telemetry

The driver learns where steps begin and end so it can group the trace, timestamp steps
against the recording, and attribute anomalies to a step.

```ts
type Anomaly = {
  t: number;                       // ms since recording start
  kind: 'console-error' | 'page-error' | 'request-failed' | 'http-error' | 'dialog';
  message: string;                 // one line, <= 500 chars
};
type StepTelemetry = { startMs: number; endMs: number; anomalies: Anomaly[] };

interface Driver {
  // ...phase 1 methods unchanged...
  beginStep(label: string): Promise<void>;
  endStep(): Promise<StepTelemetry>;
}
```

Browser driver: `beginStep` calls `context.tracing.group(label)` and notes `elapsed()`;
`endStep` calls `tracing.groupEnd()` and returns the anomalies collected since `beginStep`.
Recording start is the moment the context is created. Listeners: `page.on('console')`
(type `error`), `page.on('pageerror')`, `page.on('requestfailed')`, `page.on('response')`
with status >= 500 (4xx is not an anomaly: apps legitimately return 401/404), and
`page.on('dialog')` (auto-dismissed, recorded).

`StepReport` gains `startMs`, `endMs`, `anomalies`. `Report` gains `anomalyCount`.
A step with anomalies still passes; anomalies are shown, not enforced.

The runner wraps every executed step in `beginStep(text)` / `endStep()`; skipped steps
get no telemetry.

## 3. Filmstrip

Per test, the driver-browser package renders `filmstrip.png`: the step screenshots
scaled to 240px wide, laid out horizontally with a 1-based index in the corner, failed
steps outlined in red, a maximum of 12 frames (evenly sampled when there are more).
Rendered by loading an HTML page in Chromium and screenshotting it, so no image library
is needed. `Report.recording` gains `filmstripPath?: string`.

## 4. Timeline report

`ete report` renders one static `ete-results/index.html` with, per test:

- The video, with a marker rail beneath it. One marker per step at `startMs / totalMs`,
  colour by status (passed green, resolved blue, healed amber, failed red, skipped grey);
  anomaly markers in yellow at their `t`. Hover shows the label; click seeks the video.
- The step list. As the video plays, the current step is highlighted (`timeupdate`).
  Clicking a step seeks. Each step shows its screenshot, duration, error, and anomalies.
- Links: `npx playwright show-trace <test>/trace.zip` and, when the report is published
  (section 5), a hosted trace-viewer link.

Total duration = `endMs` of the last executed step, or the video duration once loaded.
All paths are relative, so the same file works locally, in the artifact, and on Pages.

## 5. Publishing media from the Action

New Action inputs:

| input | default | meaning |
|---|---|---|
| `media-branch` | `ete-media` | branch to push media to; empty string disables publishing |
| `media-retention-days` | `30` | run directories older than this are pruned on each publish |
| `pages-url` | `` | base URL where the media branch is served (GitHub Pages). Enables direct timeline links |

`scripts/publish.mjs` copies `ete-results/` to `runs/<run_id>-<attempt>/` on the media
branch (creating it as an orphan if needed), prunes old runs, commits, and pushes with the
job token. Requires `contents: write`. Outputs `MEDIA_BASE` (raw URL of the run dir) and
`TIMELINE_URL` (Pages URL of the run's `index.html`, when `pages-url` is set).

The comment (`scripts/comment.mjs`) becomes:

```
🧪 ete E2E results · 4/5 passed · 2 anomalies

### Login  — 2/2 passed  [▶ timeline] [trace]
![filmstrip](raw…/login/filmstrip.png)
✅ Sign in with valid credentials · 3.1s
✅ Wrong password shows an error · 2.4s · ⚠️ 1 anomaly

### Checkout — 2/3 passed  [▶ timeline] [trace]
![filmstrip](raw…/checkout/filmstrip.png)
❌ Pay with saved card — step 6: expect "Order confirmed" · Assertion failed
…
🩹 1 step healed (not persisted; run `ete run` locally and commit e2e/.resolved/)
📦 Full videos and traces: <artifact>
```

`[▶ timeline]` links to `TIMELINE_URL#<test>` when available; `[trace]` always links to
`https://trace.playwright.dev/?trace=<raw trace.zip url>` (raw.githubusercontent.com sends
`Access-Control-Allow-Origin: *`, so the hosted viewer can load it). When publishing is
disabled, filmstrips are omitted and the comment falls back to the phase 1 layout.

## 6. Exploratory runs: `ete explore`

```
ete explore "<goal>" [--flow <name>] [--save [path]] [--max-actions 30]
```

The agent drives the browser toward the goal. Each turn: observe, then the model returns
one of `{ nextAction }`, `{ nextAssertion }`, or `{ done, summary }`. Every action becomes a
step (text from `describeEntry`), every assertion becomes an `expect` step whose result is
checked deterministically and recorded; a failed assertion marks the run failed but the
exploration continues so the recording shows what happened next. Steps are wrapped in
`beginStep`/`endStep`, so the explore run has the same report, filmstrip, and timeline as a
replay. `Report` gains `mode: 'replay' | 'explore'`.

`--save` writes the yaml (with `flow:`) and the resolved file directly from the actions
taken, so a saved exploration is immediately replayable with no resolver call.
`ete author` becomes an alias for `ete explore --save`.

Exploration prompt rules: prefer few decisive actions; add an assertion after every
meaningful transition; stop when the goal is met or clearly impossible; never repeat a
failed action.

## 7. The `/ete` skill

`skills/ete/SKILL.md` (Claude Code) and `AGENTS.md` (Codex). When asked for flows:

1. Ensure `ete.yaml` exists (`ete init`), and the app is startable.
2. Turn the request into named flows, e.g. "Login", "Browse products", "Checkout".
3. For each: `ete explore "<goal>" --flow "<Flow>" --save`. Read `report.json`; if the run
   failed or the steps look wrong, edit the yaml and rerun `ete run <file>`.
4. `ete run` everything once to prove the replay is stable.
5. Commit `e2e/` including `.resolved/`. Explain what the PR comment will show.

## 8. Testing

- core: flow derivation; runner telemetry (fake driver returns telemetry, runner records
  `startMs/endMs/anomalies`, skipped steps have none); explore loop with mock model
  (actions, assertion pass, assertion fail continues, save output is replayable: resolved
  hashes match yaml steps); timeline HTML contains markers with correct percentages.
- driver-browser: telemetry against the fixture (a page that logs a console error, a
  failing request, and a 500), trace groups present in `trace.zip`, filmstrip renders.
- cli: `explore --save` end to end with a mock model and the fixture; `run` output grouped
  by flow.
- action: comment grouping and links; `publish.mjs` tested against a local bare repo.

## Out of scope

Desktop driver (was phase 2, now phase 3). Hosted dashboard. LLM review of recordings.
