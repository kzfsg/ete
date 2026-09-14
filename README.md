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
export ANTHROPIC_API_KEY=...          # only needed to resolve new steps or heal broken ones
npx ete author "a user can log in"    # LLM explores your app and drafts e2e/a-user-can-log-in.yaml
npx ete run                           # resolves steps, records video/trace, writes e2e/.resolved/
npx ete report                        # opens ete-results/index.html
git add e2e && git commit -m "test: login flow"
```

`ete init` also writes `.github/workflows/ete.yml`. Because `e2e/.resolved/` is committed, CI runs need **no API key**
unless something changes; then the run heals, reports it in the PR comment, and you persist the fix locally.

## Commands

| Command | What it does |
|---|---|
| `ete init` | Scaffold `ete.yaml`, `e2e/`, the workflow, and `.gitignore` entry |
| `ete author "<goal>"` | LLM explores the running app and drafts a test file |
| `ete run [files] [--ci] [--headed] [--url] [--start]` | Replay cached steps, resolve new ones, heal broken ones, record everything |
| `ete report [--no-open]` | Render `ete-results/` to one HTML page |

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

Each run uploads `ete-results/` (video, trace, per-step screenshots, `report.json`) as an artifact and posts one sticky
PR comment with per-test status, failed steps with errors, and any healed steps with before/after actions.

**Limitation:** GitHub does not render images in comments posted by Actions, so screenshots and video are viewed by
downloading the artifact, `npx playwright show-trace <test>/trace.zip`, or `npx ete report` locally.

## For coding agents

`skills/ete-author/SKILL.md` (Claude Code) and `skills/ete-author/AGENTS.md` (Codex and others) teach an agent the
author → run → review → commit loop and the step-writing rules.

## Design

- `packages/core`: step schema, `Driver` interface, resolver (Vercel AI SDK, provider-agnostic), run loop with heal budgets, report + HTML.
- `packages/driver-browser`: Playwright implementation of `Driver`.
- `packages/cli`: `ete` binary.
- `packages/action`: composite GitHub Action.
- `fixtures/demo-app`: tiny app used by the integration tests and this repo's own self-test workflow.

Phase 2 adds a desktop driver behind the same `Driver` interface using point targets. Phase 3 is a hosted dashboard for
run history and shareable recordings. Full spec in `docs/superpowers/specs/2026-09-14-ete-design.md`.
