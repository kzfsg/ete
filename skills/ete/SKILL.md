---
name: ete
description: Use when asked to build, record, add, run, fix, or debug end-to-end (E2E) browser tests or "user flows" with ete, when a request like "/ete build 3 user flows from login to checkout" arrives, or when a CI "ete E2E results" PR comment shows a failing step with a `fix:` command. You drive the browser yourself through `ete session`; ete records, replays, and reports. No API key is involved.
---

# Building user flows with ete

You are the driver. `ete session` gives you a live browser: you look at the page, act, and assert;
ete records what worked as a replayable test with video, trace, screenshots, and anomalies. CI
replays those tests deterministically with no model. When a replay fails, you resume the session at
the failing step and fix it. ete never calls a model and never needs credentials.

## When asked for flows (e.g. "build 3 user flows, login through checkout")

1. **Setup.** If there is no `ete.yaml`: `npx ete init --url <app url> --start "<serve command>"`.
   Omit `--start` for a deployed URL. Check the app actually serves at `url`.
2. **Name the flows.** Turn the request into flow names with one goal sentence each, e.g.
   `Login` / "a user can sign in with valid credentials"; `Checkout` / "a user can add an item to the
   cart and complete checkout". A flow may hold several tests.
3. **Record each test** with a session (below). Keep it tight: a user's happy path, one action per
   step, an `expect` after every meaningful transition.
4. **Prove the replay.** `npx ete run` replays everything. Every step must be `passed`.
   `npx ete report` opens the timeline.
5. **Commit** `e2e/` including `e2e/.resolved/`. Never commit `ete-results/`.
6. **Tell the user** what the PR comment will show: per flow, pass/fail per test, a filmstrip, a
   timeline link, a trace link, and anomalies.

## Many flows at once: fan out to cheap subagents

Recording is narrow work: look at the page, take one action, assert one outcome. A small, cheap
model does it well **when the goal is precise**. Keep the judgement with the strong model.

1. **Decompose (strong model).** Turn the request into concrete goals, one per test, each stating
   the expected outcome: not "checkout works" but "a user with an expired card sees the 'card
   declined' message and stays on checkout". Group them into flows. Write the list down.
2. **Fan out (cheap subagents, in parallel).** Give each subagent one goal and one session id:
   `ete session start --id <slug> --name "<goal>" --flow "<Flow>"`, then the observe → act → expect
   loop, then `ete session save --id <slug>`. Every command takes `--id`. Sessions share the running
   app; for flows that write shared state, give each its own app with `--port <n>` (the start command
   and URL may use `{port}`). Tell subagents: one UI action per step, quote literal text, assert after
   every transition, stop when the goal is met, and never invent a step that did not work.
3. **Review (strong model).** Read each saved `e2e/<flow>/<slug>.yaml`: it must reach the goal and
   contain at least one `expect`. Reject and re-record anything thin or off-goal.
4. **Verify.** `ete run --workers 4` (or more, if tests do not share state). Everything must pass.
5. **Commit** `e2e/` including `.resolved/`.

For fixes, subagents can run the `fix:` command and re-record a stale step, but the decision
"regression or stale test?" goes to the strong model when the page no longer matches the goal.

## Driving a session

```bash
ete session start --name "a user can sign in" --flow Login   # opens the app at "/" (recorded as step 1)
ete session observe                                           # URL, accessibility tree, screenshot path
ete session act goto /login
ete session act click 'role=button[name="Sign in"]'
ete session act type 'label=Email' alice@example.com
ete session act press Enter
ete session expect text "Welcome, Alice"
ete session status                                            # steps recorded so far
ete session save                                              # writes the test + actions, stops
```

- Every `act` and `expect` prints the outcome and a fresh observation (URL, accessibility tree,
  screenshot path). Read the screenshot when the tree is not enough.
- Selectors are Playwright selectors. Prefer `role=button[name="Sign in"]`, then `text=…`,
  `label=…`, `placeholder=…`, and `css=…` last. Coordinates `x,y` also work.
- **A failed `act` is not recorded.** It tells you why; try a different target. A failed `expect`
  is not recorded either unless you pass `--record` on purpose.
- `--as "<step text>"` sets the natural-language step text. Use it when the default is unclear,
  e.g. `--as 'type the customer email'`.
- `undo` drops the last recorded step (the browser is not rewound). `abort` discards everything.
- Actions: `goto`, `click`, `type`, `press`, `scroll <dy> [sel]`, `wait <ms>`.
  Assertions: `text <visible text>`, `visible <sel>`, `url <regex>`.
- Anomalies (console errors, page exceptions, failed requests, 5xx, dialogs) are printed with a
  ⚠️. They do not fail the step. Mention them to the user; they are often real bugs.

## When a replay fails (locally or from a PR comment)

The failure line includes the exact command:

```
✗ 4. click "Pay now" — Timeout 5000ms waiting for role=button[name="Pay"]
   fix: ete session start --from e2e/checkout/pay.yaml --at 4
```

Run it. Steps 1–3 are replayed, then you are at step 4 with a live page. Look, decide whether the
app regressed (fix the app, tell the user) or the step is stale (redo step 4 and any that follow),
then `ete session save`. The file keeps steps 1–3 and takes your new steps from 4 on. Finish with
`ete run <file>` and commit.

## Test file format (when editing by hand)

```yaml
name: Pay with a saved card
flow: Checkout
steps:
  - go to /cart
  - click "Checkout"
  - expect: the page shows "Order confirmed"
```

Editing a step's text invalidates only that step's recorded action; resume at it to re-record.
