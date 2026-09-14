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

The job needs `pull-requests: write` for the comment. Recordings are uploaded as the `ete-results-<run>` artifact.
