# ete setup mode — the app map on a local canvas

Date: 2026-09-15
Status: approved design (branch `feat/setup-map`)

## Goal

On first run in a repo, ete maps the app before any test exists: a wireframe of screens and the
actions between them, on a draggable canvas at localhost. The user edits it and asks the agent
(Claude Code or Codex, running locally with the user's own auth) to add cases. When satisfied, one
click records the cases and opens the results.

## Pieces

1. **Crawl (deterministic, no model).** `ete setup` starts the app, opens `/`, and explores
   breadth-first: on each screen it reads the accessibility tree, lists interactive elements
   (links, buttons, tabs), and tries each in a fresh page reached by replaying the path. A screen
   is identified by a signature: URL path + level-1/2 headings + dialog/alert presence; a click that
   yields a new signature adds a screen and an edge. Limits: max 40 screens, depth 4, 12 actions per
   screen, same-origin only, skip mailto/tel/download, skip destructive-looking labels (delete,
   remove, sign out, pay). Every screen gets a screenshot. Output: `e2e/map.json` + `e2e/.map/*.png`.
2. **Map file.** `e2e/map.json` (committed):
   `{ version:1, baseUrl, screens:[{id,name,url,signature,screenshot,depth,x,y,notes?}],
     edges:[{id,from,to,action:{kind,selector,text?},label}],
     cases:[{id,title,path:[screenId…],steps:[string],status:'proposed'|'recorded'|'passed'|'failed',test?}] }`
   Positions are layered by depth on first layout; user drags persist.
3. **Local canvas: `ete setup` → http://localhost:4747.** Static HTML+JS served by the CLI (no
   framework). Pan (drag background / wheel zoom), drag nodes, nodes show screenshot + name + case
   count, edges show action labels, cases panel lists cases with status; select a case to light up
   its path; uncovered screens are dimmed. Edit names/notes/case titles/steps inline. A prompt box
   sends text to the agent. A **Run** button records every `proposed` case, replays all, and opens
   the report.
4. **Agent bridge.** `POST /api/prompt {text}` spawns the local agent CLI in the repo with a
   composed prompt (the /ete skill text + the current map summary + the user's text) and streams
   its output to the canvas (SSE). Adapters: `claude -p --output-format stream-json
   --allowedTools "Bash(ete *)" …` and `codex exec --full-auto`. Chosen with `--agent claude|codex`
   or auto-detected. The agent's job is to edit `e2e/map.json` (add cases) and/or record tests via
   sessions; the server watches the file and pushes updates to the canvas.
5. **Run.** `POST /api/run`: for each proposed case, ask the agent to record it (one session per
   case, fan-out with named sessions), then `ete run`, then update case statuses from
   `ete-results`, then open `ete report`.
6. **Auto-proposed cases.** After the crawl, one case per leaf path: title "a visitor can reach
   <leaf>" with steps from the edge labels. The user prunes/edits before running.

## Out of scope for this branch
Site hosting of the map; in-canvas agent chat history beyond the current session; Codex
end-to-end verification (adapter written, untested here).
