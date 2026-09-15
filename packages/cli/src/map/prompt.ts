import type { AppMap } from '@ete/core';

/** What the agent sees before the user's request: the map, in a few lines per item. */
export function mapSummary(map: AppMap): string {
  const name = (id: string) => map.screens.find((s) => s.id === id)?.name ?? id;
  const screens = map.screens.map((s) => `- ${s.id}: "${s.name}" (${s.url})${s.notes ? ` — ${s.notes}` : ''}`).join('\n');
  const edges = map.edges.map((e) => `- ${name(e.from)} → ${name(e.to)} via ${e.label}`).join('\n');
  const cases = map.cases.map((c) => `- [${c.status}] ${c.id}: ${c.title}${c.test ? ` (${c.test})` : ''}\n    steps: ${c.steps.join(' · ')}`).join('\n');
  return `Screens:\n${screens || '- (none)'}\n\nTransitions:\n${edges || '- (none)'}\n\nCases:\n${cases || '- (none)'}`;
}

export function buildPrompt(map: AppMap, userText: string, mapPath: string): string {
  return `You are helping set up end-to-end tests with ete for the app at ${map.baseUrl}.
The app map lives in ${mapPath}. It is JSON with "screens", "edges" (transitions), and "cases".
A case is { id, title, path: [screen ids], steps: [plain-language steps], status: "proposed" }.
Steps are plain user language, one UI action each, with "expect: …" lines for what should be true.

Current map:
${mapSummary(map)}

The user asks: ${userText}

Do exactly what is asked by editing ${mapPath} (add, change, or remove cases or screen notes; keep ids stable; keep existing positions x/y).
Do not record tests or run the browser unless the user explicitly asks; recording happens later from the canvas.
When done, reply with one short line per change you made.`;
}

/** Prompt for recording one proposed case through a session. */
export function recordCasePrompt(map: AppMap, c: AppMap['cases'][number], id: string): string {
  const flow = map.screens.find((s) => s.id === c.path[c.path.length - 1])?.name ?? 'General';
  return `Record ONE end-to-end test with the ete CLI. Use session id "${id}" (pass --id ${id} on every session command).
Goal: ${c.title}
Intended steps (adapt to what you actually see; skip a step if the page already matches):
${c.steps.map((s) => `- ${s}`).join('\n')}

Commands: ete session start --id ${id} --name "${c.title.replace(/"/g, '\\"')}" --flow "${flow}" · then ete session act --id ${id} click '<selector>' | goto '<path>' | type '<selector>' '<text>' | press <key> | wait <ms> · ete session expect --id ${id} text '<text>' | visible '<selector>' | url '<regex>' · ete session save --id ${id}.
Every command prints the page's accessibility tree; pick selectors from it (role=button[name="…"], role=link[name="…"], text=…). Use --as '<plain step text>' so steps read like a user's action. A failed act/expect is not recorded: try another selector. Assert after each transition. Save when the goal is met. Reply with the save output.`;
}
