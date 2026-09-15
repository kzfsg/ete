# ete

Spin up end-to-end browser tests in minutes and run them in GitHub Actions. No API key, ever.

Your coding agent (Claude Code, Codex, anything with a shell) drives a real browser through `ete session`; ete records
what worked as a plain-language test plus the exact actions. CI replays those actions deterministically with Playwright,
records video and traces, and posts a PR comment grouped by user flow. When a step breaks, the comment carries the one
command that lets the agent resume at that step and fix it. ete itself never calls a model.

```yaml
# e2e/login.yaml
name: Login flow
steps:
  - go to /login
  - type "alice@example.com" into the email field
  - type "hunter2" into the password field
  - click Sign in
  - expect: the page shows "Welcome, Alice"
```

## Start with a map of the app

```bash
npx ete init --url http://localhost:3000 --start "npm run dev"
npx ete setup          # crawls every screen, opens http://localhost:4747
```

`ete setup` explores the app breadth-first with a real browser (no model), records every screen with a screenshot and
the action that reaches it, and opens a draggable canvas: screens as nodes, actions as edges, one proposed case per
leaf. Edit names and steps inline, add cases from any screen, or type a request in "Ask agent": it runs your local
Claude Code or Codex CLI with the map as context and the change appears on the canvas. "Run · record & replay" has the
agent record every proposed case through sessions, replays everything, and opens the report; case statuses update.

## Quickstart

```bash
npx ete init --url http://localhost:3000 --start "npm run dev"

npx ete session start --name "a user can log in" --flow Login    # live browser, opened at /
npx ete session act click 'role=link[name="Log in"]'             # each act prints the page after it
npx ete session act type 'label=Email' alice@example.com
npx ete session act click 'role=button[name="Sign in"]'
npx ete session expect text "Welcome, Alice"
npx ete session save        # writes e2e/login/a-user-can-log-in.yaml + e2e/.resolved/… + recording

npx ete run                 # deterministic replay
npx ete report              # timeline: video + click/assert/fail/anomaly markers
git add e2e && git commit -m "test: login flow"
```

In Claude Code, `/ete build 3 user flows, from login to checkout` does all of this for you (see `skills/ete`).

`ete init` also writes `.github/workflows/ete.yml`. Because `e2e/.resolved/` is committed, CI runs need **no API key**
unless something changes; then the run heals, reports it in the PR comment, and you persist the fix locally.

## Commands

| Command | What it does |
|---|---|
| `ete init` | Scaffold `ete.yaml`, `e2e/`, the workflow, and `.gitignore` entry |
| `ete session start --name … [--flow …]` | Open a live browser to record a new test |
| `ete session start --from <test> --at N` | Replay steps 1..N-1 of an existing test, then record from N (fix or extend) |
| `ete session observe / act / expect / undo / status / save / abort` | Drive and finish the session |
| `ete run [files] [--ci] [--headed] [--url] [--start]` | Replay cached steps, resolve new ones, heal broken ones, record everything |
| `ete report [--no-open]` | Render `ete-results/` to a timeline page: video, marker rail, seek on click, anomalies |

## Config (`ete.yaml`)

```yaml
url: http://localhost:3000
start: npm run dev          # optional; omit for a deployed/preview URL
readyTimeout: 60000
```

## In CI, with a central reports site

```yaml
- uses: kzfsg/ete/packages/action@main
  with:
    url: http://localhost:3000
    start: npm run dev
    blob-token: ${{ secrets.ETE_BLOB_TOKEN }}     # Vercel Blob read-write token of your reports store
    site-url: https://ete-reports.vercel.app       # your deployed reports site
```

Every run is published to one site for all your repos: `packages/site` is a small Next.js app you deploy once to
Vercel, backed by a Vercel Blob store. It lists repos → PRs/branches → runs, and renders each run's timeline with
playable video, step markers, screenshots, and anomalies, streamed from Blob. The PR comment links the run and each
test's timeline, and inlines the failing step's screenshot. Runs older than `retention-days` (default 30) are pruned.
Agents can publish local sessions the same way with `ete publish`.

One-time setup: create a public Blob store and the site project on Vercel (`vercel blob create-store ete-reports
--access public` linked to the site project), deploy `packages/site` with `vercel build --prod && vercel deploy
--prebuilt --prod` from the repo root, then add the store's read-write token as `ETE_BLOB_TOKEN` in each repo.
Without `blob-token`/`site-url` the comment is text plus the artifact link.

## Scaling to hundreds of tests

- **Authoring in parallel:** `ete session start --id <name>` runs any number of recording sessions side by side in one
  project, so an orchestrating agent can fan goals out to cheap subagents. `--port <n>` gives a session its own app
  instance (`{port}` in `start`/`url` is substituted); otherwise sessions share the running app.
- **Replay in parallel:** `ete run --workers 8` replays tests concurrently, one browser each. Tests must not share app
  state. `--shard 2/4` runs one slice of the suite; use a CI matrix with the `shard` input and every shard publishes to
  the same run on the reports site.
- **Readable results:** past ten tests the PR comment leads with failures and collapses passing flows.

## Flows, timeline, anomalies

- `flow:` in a test file (or its `e2e/<flow>/` directory) groups tests in output and in the PR comment.
- Every step records its start and end against the video, so the timeline can seek to any click, assertion, or failure.
- Anomalies are console errors, page exceptions, failed requests, 5xx responses, and unexpected dialogs seen during a
  step. They are shown as yellow markers and listed in the comment. They never fail a test.

## For coding agents

`skills/ete/SKILL.md` (Claude Code) and `skills/ete/AGENTS.md` (Codex and others) teach an agent to turn "build these
user flows" into recorded, replayable tests, and how to act on the PR comment.

## Design

- `packages/core`: step schema, `Driver` interface, deterministic runner, session `Recorder`, timeline report.
- `packages/driver-browser`: Playwright implementation of `Driver`.
- `packages/cli`: `ete` binary.
- `packages/action`: composite GitHub Action.
- `fixtures/demo-app`: tiny app used by the integration tests and this repo's own self-test workflow.

Next: a desktop driver behind the same `Driver` interface using point targets, then a hosted dashboard for run history.
Specs in `docs/superpowers/specs/`.
