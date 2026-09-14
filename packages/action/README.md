# ete GitHub Action

Replays your `e2e/*.yaml` tests in CI with video and trace recording, publishes the run to your central ete reports
site, and posts a sticky PR comment that links straight into each test's timeline.

```yaml
- uses: kzfsg/ete/packages/action@main
  with:
    url: http://localhost:3000        # or a preview URL; defaults to ete.yaml
    start: npm run dev                # optional; defaults to ete.yaml
    blob-token: ${{ secrets.ETE_BLOB_TOKEN }}   # Vercel Blob read-write token of the reports store
    site-url: https://ete-reports.vercel.app     # your deployed reports site
```

The job needs `pull-requests: write` for the comment. No API keys: replay is deterministic and the agent that
recorded the tests is the only intelligence involved. Without `blob-token`/`site-url` the comment is text plus the
artifact link; with them, each test links to its timeline (playable video, step markers, anomalies) and failed tests
inline the failing step's screenshot.
