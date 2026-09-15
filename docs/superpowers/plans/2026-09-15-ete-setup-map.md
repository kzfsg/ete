# ete setup mode plan
Spec: `docs/superpowers/specs/2026-09-15-ete-setup-map-design.md`
1. core: `map.ts` types + `signature()` + `layout()`; `crawl.ts` BFS crawler over `Driver`, tests with FakeDriver + real fixture.
2. cli: `ete setup` command: crawl → write map + screenshots → serve canvas. `map/server.ts` (static + /api/map GET/PUT + /api/prompt SSE + /api/run), `map/agents.ts` adapters, `map/canvas.html`.
3. canvas UI: pan/zoom/drag, nodes, edges, cases panel, prompt box, run button; screenshot-verified.
4. skill: `/ete` gains the setup flow; README.
