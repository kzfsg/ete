# ete E2E tests (agent instructions)

# Building user flows with ete

ete records real browser runs of user flows and replays them deterministically in CI. You drive the
browser once with `ete explore`; the actions taken are saved as a test file plus its resolved actions,
so CI needs no LLM. Every run produces a video, a trace, per-step screenshots, anomalies, and a
timeline. On a pull request the Action posts one comment grouped by flow with a filmstrip per test
and links to the full timeline.

## When asked for flows (e.g. "build 3 user flows, login through checkout")

1. **Setup.** If there is no `ete.yaml`, run `npx ete init --url <app url> --start "<serve command>"`.
   The app must be reachable at `url` after `start`. Omit `--start` for a deployed URL. An LLM key must
   be in the environment (`ANTHROPIC_API_KEY` by default) for explore; replay needs none.
2. **Name the flows.** Turn the request into short flow names and one goal sentence each, written as
   what a user can do. Example: `Login` / "a user can sign in with valid credentials";
   `Browse` / "a user can search for a product and open it"; `Checkout` / "a user can add an item to
   the cart and complete checkout". One flow may have several tests.
3. **Record each one.**
   `npx ete explore "<goal>" --flow "<Flow>" --save`
   This writes `e2e/<flow>/<slug>.yaml` and `e2e/.resolved/<flow>/<slug>.json`, and
   `ete-results/<slug>/` with `report.json`, `video.webm`, `trace.zip`, `filmstrip.png`, `steps/`.
   Read `report.json`. If a step `failed` or the recorded steps look wrong or wander, edit the yaml
   (or rerun explore with a more specific goal, after deleting the files it wrote).
4. **Prove the replay.** `npx ete run` replays everything from the cache. Every step must be `passed`.
   A `resolved` or `healed` step means the yaml was edited after recording; that is fine once, then it
   is cached. `npx ete report` opens the timeline.
5. **Commit** `e2e/` including `.resolved/`. Never commit `ete-results/`.
6. **Tell the user** what the PR comment will show: per flow, pass/fail per test, a filmstrip, a
   timeline link (video with click/assertion/failure/anomaly markers), and a trace link.

## Test file format (when writing or editing by hand)

```yaml
name: Pay with a saved card
flow: Checkout
steps:
  - go to /cart
  - click "Checkout"
  - type "4242 4242 4242 4242" into the card number field
  - click "Pay now"
  - expect: the page shows "Order confirmed"
```

- One UI action per step; quote text that appears on screen or is typed.
- Add `expect:` after every meaningful transition. Assertions catch regressions; they never
  auto-pass. They can check visible text, a visible element, or the URL.
- No selectors in steps. Editing a step invalidates only that step's cached action.

## When the CI comment reports problems

- **❌ failed**: open the timeline or download the artifact and look at the failing step's screenshot
  and the video around it. Decide whether the app regressed (fix the app) or the step is stale
  (edit the step, `npx ete run <file>` locally with a key, commit the updated `.resolved` file).
- **🩹 healed**: the cached selector broke and the LLM found a new one during CI. CI never commits
  heals. Run `npx ete run <file>` locally and commit `e2e/.resolved/`. If the heal picked the wrong
  element, tighten the step text first.
- **⚠️ anomalies**: console errors, page exceptions, failed requests, 5xx responses, or unexpected
  dialogs seen during a step. They do not fail the test. Mention them to the user; they are often
  real bugs.

## Commands

| Command | Use |
|---|---|
| `ete init` | scaffold config, `e2e/`, workflow |
| `ete explore "<goal>" [--flow X] [--save]` | agent-driven recorded run; `--save` makes it a replayable test |
| `ete author "<goal>"` | alias for `explore --save` |
| `ete run [files] [--ci] [--headed]` | deterministic replay with self-heal |
| `ete report` | timeline HTML for the last run |

Config lives in `ete.yaml`: `url`, `start`, `readyTimeout`, `llm.provider` (anthropic | openai | google),
`llm.model`, `heal.maxPerRun`, `heal.maxPerStep`.
