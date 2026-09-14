# ete

Spin up end-to-end browser tests in minutes and run them in GitHub Actions.

You describe a test in plain language. An LLM turns each step into a concrete browser action **once** and caches
the result in your repo. CI replays those actions deterministically with Playwright, records video and traces,
and only calls the LLM again when a step breaks, to self-heal. The LLM never decides whether a test passed.

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

## Quickstart

```bash
npx ete init --url http://localhost:3000 --start "npm run dev"
export ANTHROPIC_API_KEY=...                                  # only needed to explore or heal
npx ete explore "a user can log in" --flow Login --save       # agent drives the browser, records it,
                                                              # saves e2e/login/a-user-can-log-in.yaml + resolved actions
npx ete run                                                   # deterministic replay, no key needed
npx ete report                                                # timeline: video + click/assert/fail/anomaly markers
git add e2e && git commit -m "test: login flow"
```

In Claude Code, `/ete build 3 user flows, from login to checkout` does all of this for you (see `skills/ete`).

`ete init` also writes `.github/workflows/ete.yml`. Because `e2e/.resolved/` is committed, CI runs need **no API key**
unless something changes; then the run heals, reports it in the PR comment, and you persist the fix locally.

## Commands

| Command | What it does |
|---|---|
| `ete init` | Scaffold `ete.yaml`, `e2e/`, the workflow, and `.gitignore` entry |
| `ete explore "<goal>" [--flow X] [--save]` | Agent drives the browser through a flow and records it; `--save` writes a replayable test |
| `ete author "<goal>"` | Alias for `explore --save` |
| `ete run [files] [--ci] [--headed] [--url] [--start]` | Replay cached steps, resolve new ones, heal broken ones, record everything |
| `ete report [--no-open]` | Render `ete-results/` to a timeline page: video, marker rail, seek on click, anomalies |

## Config (`ete.yaml`)

```yaml
url: http://localhost:3000
start: npm run dev          # optional; omit for a deployed/preview URL
readyTimeout: 60000
llm:
  provider: anthropic       # anthropic | openai | google
  model: claude-opus-5
heal:
  maxPerRun: 5              # LLM calls per run before failing fast
  maxPerStep: 2
```

Keys are read from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`.

## In CI

```yaml
- uses: kzfsg/ete/packages/action@main
  with:
    url: http://localhost:3000
    start: npm run dev
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Each run uploads `ete-results/` as an artifact, publishes it to an `ete-media` branch in your repo, and posts one sticky
PR comment grouped by flow: pass/fail per test, a filmstrip of the run, a link to the hosted Playwright trace viewer, and
healed steps and anomalies. The job needs `pull-requests: write` and `contents: write`.

For one-click timeline links, enable GitHub Pages on the `ete-media` branch and pass `pages-url`. Set `media-branch: ''`
to keep media out of the repo; the comment then falls back to text plus the artifact link.

**Why not the video itself in the comment?** GitHub only renders media in comments when it is hosted at a fetchable URL,
and workflows cannot upload comment attachments. The media branch is the closest thing to inline playback CI can offer.

## Flows, timeline, anomalies

- `flow:` in a test file (or its `e2e/<flow>/` directory) groups tests in output and in the PR comment.
- Every step records its start and end against the video, so the timeline can seek to any click, assertion, or failure.
- Anomalies are console errors, page exceptions, failed requests, 5xx responses, and unexpected dialogs seen during a
  step. They are shown as yellow markers and listed in the comment. They never fail a test.

## For coding agents

`skills/ete/SKILL.md` (Claude Code) and `skills/ete/AGENTS.md` (Codex and others) teach an agent to turn "build these
user flows" into recorded, replayable tests, and how to act on the PR comment.

## Design

- `packages/core`: step schema, `Driver` interface, resolver (Vercel AI SDK, provider-agnostic), run loop with heal budgets, report + HTML.
- `packages/driver-browser`: Playwright implementation of `Driver`.
- `packages/cli`: `ete` binary.
- `packages/action`: composite GitHub Action.
- `fixtures/demo-app`: tiny app used by the integration tests and this repo's own self-test workflow.

Next: a desktop driver behind the same `Driver` interface using point targets, then a hosted dashboard for run history.
Specs in `docs/superpowers/specs/`.
