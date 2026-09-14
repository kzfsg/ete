# ete E2E tests (agent instructions)

# Writing E2E tests with ete

ete tests are short natural-language step lists in `e2e/*.yaml`. An LLM resolves each step to a
concrete browser action **once**; the result is cached in `e2e/.resolved/<name>.json` and replayed
deterministically in CI. The LLM is only called again when a step breaks (self-heal).

## The loop

1. **Check setup.** If there is no `ete.yaml`, run `npx ete init --url <app url> --start "<serve command>"`.
   `url` must be reachable after `start`; omit `start` for a deployed URL.
2. **Draft.** `npx ete author "<what a user should be able to do>"` explores the running app and writes
   `e2e/<slug>.yaml`. Read it. Tighten vague steps, add `expect:` assertions after every meaningful
   transition, remove exploratory dead ends. You can also write the file by hand (format below).
3. **Resolve and record.** `npx ete run e2e/<name>.yaml`. This needs an API key in the environment
   (`ANTHROPIC_API_KEY` by default). It writes `e2e/.resolved/<name>.json` and `ete-results/<name>/`
   (video, trace, per-step screenshots, `report.json`).
4. **Review.** Read `ete-results/<name>/report.json`. Every step must be `passed`, `resolved`, or `healed`.
   For a `failed` step, look at `ete-results/<name>/steps/NN.png` and the error, then fix the step text
   (be more specific, quote literal UI text) or the app, and rerun. `npx ete report` opens an HTML view.
5. **Commit** both `e2e/<name>.yaml` and `e2e/.resolved/<name>.json`. Never commit `ete-results/`.

## Step format

```yaml
name: Checkout flow
steps:
  - go to /login                                   # relative to url in ete.yaml
  - type "alice@example.com" into the email field  # quote literal text
  - click "Sign in"                                # one UI action per step
  - expect: the page shows "Welcome, Alice"        # assertion, fails hard, never auto-passed
```

Rules that make tests stable:
- One UI action per step. "Log in as Alice" is not a step; it is three.
- Quote text that appears in the UI or is typed. The resolver treats quoted text as literal.
- Put an `expect:` after form submits, navigations, and anything async. Assertions catch regressions;
  actions alone only prove the page did not crash.
- Assertions can check visible text, a visible element, or the URL. Prefer visible text.
- Do not put selectors in steps. If the resolver keeps picking the wrong element, describe it the way a
  user would ("the search box in the header").

## When CI reports healed steps

A heal means the cached selector broke and the LLM found a new one during the CI run. CI never
commits heals. Run `npx ete run e2e/<name>.yaml` locally (with an API key) and commit the updated
`e2e/.resolved/<name>.json`. If the heal was wrong, edit the step text and rerun.

## When CI reports failed steps

Download the `ete-results-*` artifact from the workflow run, open `<name>/steps/NN.png` for the failing
step, or `npx playwright show-trace <name>/trace.zip`. Decide whether the app regressed (fix the app) or
the step is stale (fix the step, rerun locally, commit the resolved file).

## Config (`ete.yaml`)

`url`, `start`, `readyTimeout`, `llm.provider` (anthropic | openai | google), `llm.model`,
`heal.maxPerRun`, `heal.maxPerStep`. API keys come only from the environment.
