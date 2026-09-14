# ete phase 4 — one central reports site

Date: 2026-09-14
Status: approved design

## Goal

Every run (CI or an agent's local session) publishes its results to one place, and the PR comment
links into it. No downloads. History across repos, PRs, and runs.

## Design

- **Storage: Vercel Blob**, one store for the team. Layout:
  `runs/<owner>/<repo>/pr-<n>/<runId>/manifest.json` plus each test's `report.json`, `video.webm`,
  `trace.zip`, `filmstrip.png`, `steps/NN.png` under `<runId>/<test-dir>/`. Non-PR runs use
  `branch-<name>` in place of `pr-<n>`. Blobs are public (unguessable URLs) so video streams and
  the hosted Playwright trace viewer can fetch traces. Manifest: `{ owner, repo, ref: {kind, number|name},
  runId, attempt, commit, branch, publishedAt, source: 'ci'|'local', totals: {tests, passed, anomalies},
  tests: [{ dir, name, flow, status, durationMs, anomalyCount, blobs: {report, video, trace, filmstrip} }] }`.
- **Publisher: `ete publish`** in the CLI (`packages/cli/src/commands/publish.ts`), used by the Action
  and by agents locally. Needs `BLOB_READ_WRITE_TOKEN`. Uploads `ete-results/`, writes the manifest,
  prints the run URL. `--retention-days` (default 30) prunes older runs for that repo.
- **Site: `packages/site`**, a Next.js app deployed once as `ete-reports` on the team's Vercel.
  Reads the store with `@vercel/blob` `list()`. Routes:
  `/` repos · `/[owner]/[repo]` PRs/branches with latest run status · `/[owner]/[repo]/[ref]` runs ·
  `/[owner]/[repo]/[ref]/[run]` the timeline, rendered by core's `renderHtmlWith(reports, assetUrl)`
  with blob URLs. Anchors `#<test-dir>` per test.
- **Comment**: headline links the run page; per test `[▶ timeline](…#dir)` and `[trace]`; failed
  tests inline the failing step screenshot (blob URL) and the `fix:` command.
- **Removed**: per-run Vercel deploys, media branch, animated preview, report artifact.
- **Privacy**: the site is public-by-URL on Hobby (production domains can't be gated without Pro);
  blobs are public-by-URL. Documented; Vercel Authentication can be enabled on Pro.
