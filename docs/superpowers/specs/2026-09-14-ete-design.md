# ete — LLM-authored, deterministically replayed E2E tests for CI

Date: 2026-09-14
Status: approved design, phase 1 (browser)

## Goal

Let a developer spin up an end-to-end test in minutes by describing it in
natural language, have an LLM turn that into concrete browser actions once,
replay those actions deterministically in GitHub Actions, self-heal when the
UI drifts, and see recordings of every run.

## Non-goals (phase 1)

- Native desktop automation. The driver interface is designed for it; the
  desktop driver is phase 2.
- A hosted dashboard, auth, run history, or shareable recording links.
  Recordings live in GitHub Actions artifacts. A dashboard is phase 3 if
  artifacts prove insufficient.
- The LLM judging whether a test passed. It only resolves *where* to act or
  look; pass/fail is always a deterministic check.

## Decisions already made

| Question | Decision |
|---|---|
| Product shape | Skill for authoring, CLI + GitHub Action for execution, artifacts for viewing |
| CI execution model | LLM resolves once, deterministic replay, LLM self-heals on failure |
| Target | Browser first (Playwright/Chromium), desktop as phase 2 behind the same driver interface |
| App under test in CI | User supplies a start command and URL, or just a URL for preview deployments |
| LLM provider | Provider-agnostic via the Vercel AI SDK |
| Language | TypeScript monorepo, pnpm workspaces |

## Repository layout

```
packages/
  core/            step schema, driver interface, resolver, runner, cache, report
  driver-browser/  Playwright implementation of Driver
  cli/             `ete` binary: init, author, run, report
  action/          GitHub composite action wrapping the CLI + artifact upload + PR comment
skills/
  ete-author/      Claude Code skill (SKILL.md) and Codex AGENTS.md snippet
fixtures/
  demo-app/        tiny static web app used by integration tests and the Action's own CI
```

## 1. Test file format

One YAML file per test under `e2e/`.

```yaml
# e2e/checkout.yaml
name: Checkout flow
target: browser          # "desktop" reserved for phase 2
steps:
  - go to /login
  - type "alice@example.com" into the email field
  - type "hunter2" into the password field
  - click Sign in
  - expect: the page shows "Welcome, Alice"
```

- A step is either a plain string (an action) or an object with a single
  `expect` key (an assertion).
- Relative paths in "go to" steps are resolved against the base URL.

Repo-level config in `ete.yaml`:

```yaml
url: http://localhost:3000
start: npm run dev            # optional; omitted for preview-deployment URLs
readyTimeout: 60000           # ms to wait for `url` to respond after `start`
llm:
  provider: anthropic         # any provider supported by the AI SDK
  model: claude-sonnet-5
heal:
  maxPerRun: 5                # LLM heal attempts per run before failing fast
  maxPerStep: 2
```

API keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...),
never from config.

### Resolved cache

`e2e/.resolved/<test>.json`, committed to the repo. Keyed by
`sha256(step text)` so editing a step invalidates only that step.

```json
{
  "version": 1,
  "steps": {
    "3f2a…": { "kind": "navigate", "url": "/login" },
    "9b1c…": { "kind": "type", "target": { "selector": "input[name=email]" }, "text": "alice@example.com" },
    "c04e…": { "kind": "assert", "check": { "kind": "textVisible", "text": "Welcome, Alice" } }
  }
}
```

## 2. Driver interface

```ts
interface Driver {
  start(opts: { baseUrl: string; resultsDir: string }): Promise<void>
  observe(): Promise<Observation>
  act(action: ResolvedAction): Promise<void>
  check(assertion: ResolvedAssertion): Promise<boolean>
  screenshot(path: string): Promise<void>
  stop(): Promise<Recording>
}

type Observation = {
  screenshotPng: Buffer
  a11yTree?: string       // browser only; desktop supplies screenshot only
  url?: string
}

type Target = { selector: string } | { point: { x: number; y: number } }

type ResolvedAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; target: Target }
  | { kind: "type"; target: Target; text: string }
  | { kind: "press"; key: string }
  | { kind: "scroll"; target?: Target; dy: number }
  | { kind: "wait"; ms: number }

type ResolvedAssertion =
  | { kind: "textVisible"; text: string }
  | { kind: "elementVisible"; target: Target }
  | { kind: "urlMatches"; pattern: string }

type Recording = { videoPath?: string; tracePath?: string }
```

Targets are selectors for the browser driver and points for desktop. The
runner never inspects targets; it passes them through, so adding the desktop
driver changes nothing above this interface.

The browser driver uses Playwright Chromium, records video and trace for
every run, and builds the `a11yTree` from Playwright's accessibility snapshot
with element refs so the LLM can name an element and the driver can map it
back to a stable selector.

## 3. Run loop and self-heal

For each test file:

1. Start the driver (starts video + trace).
2. For each step, in order:
   - Look up the resolved entry by step hash.
   - **Miss:** `observe()`, call the resolver LLM with the step text and the
     observation, receive a `ResolvedAction`/`ResolvedAssertion`, store it,
     mark the step `resolved`.
   - **Hit:** run it directly.
   - If an action throws (target not found, timeout): consume one heal from
     both budgets, `observe()`, call the resolver with the step text, the
     failed action, the error, and the observation, run the new action, mark
     the step `healed`. If budget is exhausted or the healed action also
     fails, mark `failed` and stop the test.
   - If an assertion's `check()` returns false: the resolver may re-resolve
     the assertion target once (same budget). Run `check()` again. If still
     false, mark `failed` and stop. The LLM is never asked "did this pass".
   - Take a screenshot after every step.
3. Stop the driver, write `report.json`.

Heals are ephemeral in CI: the updated resolved entries are written to
`ete-results/<test>/resolved.healed.json` and reported, but never committed.
Running `ete run` locally writes them to `e2e/.resolved/`. `ete run --ci`
selects the ephemeral behaviour; the Action always passes `--ci`.

### Resolver prompt contract

Input: step text, observation (screenshot as an image part, a11y tree as
text), optional previous action and error. Output: a single JSON object
validated with Zod against the `ResolvedAction | ResolvedAssertion` union.
The AI SDK's structured-output call enforces the schema; on validation
failure the resolver retries once, then throws.

## 4. Recording and reporting

Per run, `ete-results/<test>/` contains:

```
video.webm
trace.zip
steps/01.png … NN.png
report.json
resolved.healed.json     # only when --ci and something healed
```

`report.json`:

```json
{
  "name": "Checkout flow",
  "status": "passed" | "failed",
  "durationMs": 12345,
  "steps": [
    { "index": 1, "text": "go to /login", "status": "passed" | "resolved" | "healed" | "failed",
      "durationMs": 300, "screenshot": "steps/01.png", "error": "…optional…" }
  ]
}
```

`ete report` renders all reports in `ete-results/` to a single static
`ete-results/index.html` with video, per-step screenshots and status, and
opens it.

### GitHub Action

Composite action, inputs: `url`, `start` (optional), `config` (path to
`ete.yaml`, default `./ete.yaml`), `tests` (glob, default `e2e/**/*.yaml`),
`comment` (default `true`).

Steps:
1. Install the pinned `ete` CLI and Playwright Chromium.
2. Run `ete run --ci`; capture the exit code but do not fail yet.
3. Upload `ete-results/` as an artifact named `ete-results-<run id>`.
4. If `comment` and the event is a pull request, post or update one sticky
   comment (identified by an HTML marker) with: a per-test table, per-step
   status for failed tests, heal notices with the old and new action, the
   failing step's error, and a link to the artifact.
5. Exit with the captured code so the job fails on test failure.

Known limitation: GitHub does not render images from Action-posted comments
unless externally hosted. Screenshots and video are viewed by downloading the
artifact, via `npx playwright show-trace trace.zip`, or via `ete report`
locally. This is the gap a phase-3 dashboard would close.

## 5. Authoring and the skill

Authoring lives in the CLI so the skill is thin instructions.

- `ete init`: writes `ete.yaml`, `e2e/`, `.github/workflows/ete.yml`, and
  adds `ete-results/` to `.gitignore`.
- `ete author "<goal>"`: starts the app, gives the LLM the driver in an
  explore loop (observe, act, up to N actions) and asks it to emit a draft
  test file for the goal. Writes `e2e/<slug>.yaml`. Never writes the
  resolved cache; that happens on the first `ete run`.
- `ete run [files...] [--ci] [--headed]`: the run loop above.
- `ete report`: static HTML viewer.

`skills/ete-author/SKILL.md` teaches a Claude Code agent the loop: `ete init`
if needed, `ete author`, `ete run`, read `report.json`, edit steps, rerun
until green, commit the test and its resolved file. `skills/ete-author/AGENTS.md`
is the same content for Codex.

## 6. Error handling

- App fails to become ready within `readyTimeout`: fail before running any
  test, with the captured start-command output.
- Missing API key when a resolve or heal is needed: fail that test with a
  clear message; steps with cache hits still run.
- Resolver returns invalid JSON twice: mark the step `failed` with the raw
  output in the error.
- Driver crash mid-test: mark remaining steps `skipped`, still write the
  report and whatever recording exists.
- The runner never swallows an error into a pass.

## 7. Testing

- **Unit (Vitest, `packages/core`)**: step parsing, hashing, cache
  read/write, run loop with a fake driver and a fake resolver: miss →
  resolved, hit → passed, throw → healed, budget exhaustion → failed,
  assertion false → re-resolve once then fail, skipped after crash.
- **Integration (`packages/driver-browser`)**: real Playwright against
  `fixtures/demo-app` served on a local port. Resolver mocked with canned
  actions. One opt-in live-LLM test gated on an env var.
- **Action**: this repo's own workflow runs the action against the fixture
  app on every PR, with the resolver mocked, and asserts the sticky comment
  is posted.
- **Report renderer**: snapshot test of `index.html` from a fixture
  `report.json`.

## Phase 2 and 3 (recorded, not designed)

- Phase 2: `driver-desktop` using screenshots and OS-level input with point
  targets; requires a display on the runner.
- Phase 3: hosted dashboard for run history and shareable recordings.
