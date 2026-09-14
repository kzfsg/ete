# ete GitHub Action

Runs your `e2e/*.yaml` tests in CI with deterministic replay, LLM self-heal, video + trace recording, and a sticky PR comment.

```yaml
- uses: kzfsg/ete/packages/action@main
  with:
    url: http://localhost:3000        # or a preview URL; defaults to ete.yaml
    start: npm run dev                # optional; defaults to ete.yaml
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}   # only needed to resolve/heal
```

The job needs `pull-requests: write` for the comment and `contents: write` to publish recordings to the media branch.

Each run uploads `ete-results/` as the `ete-results-<run>` artifact and, by default, publishes it to the `ete-media` branch
so the comment can embed a filmstrip per test and link every trace to the hosted Playwright trace viewer. Set
`media-branch: ''` to disable. Enable GitHub Pages on `ete-media` and pass `pages-url` to get one-click timeline links.
