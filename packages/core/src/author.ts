import { generateText, Output, type LanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { Driver } from './driver.js';
import { ResolvedActionSchema, type ResolvedAction, type ResolvedEntry, type Step, type TestFile } from './schema.js';

const TurnSchema = z.object({
  done: z.boolean(),
  nextAction: ResolvedActionSchema.optional(),
  draftSteps: z.array(z.union([z.string(), z.object({ expect: z.string() })])).optional(),
  note: z.string().optional(),
});

const INSTRUCTIONS = `You are exploring a web app to write an end-to-end test for a goal.

Each turn you see a screenshot, the URL, and an accessibility tree. Either:
- return { done: false, nextAction } to take ONE action and look again, or
- return { done: true, draftSteps } when you have completed the goal (or proven it impossible).

draftSteps is the test as short natural-language steps, one UI action per step, quoting literal text,
with { expect: "..." } assertions after meaningful transitions (e.g. after submitting a form).
Write steps a human would write; do not include selectors. Example:
  ["go to /login", "type \\"alice@example.com\\" into the email field", "click \\"Sign in\\"", { "expect": "the page shows \\"Welcome, Alice\\"" }]

Selectors for nextAction are Playwright selector strings: role=button[name="Sign in"], text=Welcome, label=Password, placeholder=Email, css=input[name=email].
Do not repeat an action that already failed; try a different target. Prefer few, decisive actions.`;

function selectorLabel(selector: string): string {
  const named = /^(?:role=\w+\[name=|text=|label=|placeholder=)"?([^"\]]+)"?\]?$/.exec(selector);
  if (named) return `"${named[1]}"`;
  return selector.replace(/^css=/, '');
}

export function describeEntry(entry: ResolvedEntry): string {
  switch (entry.kind) {
    case 'navigate': return `go to ${entry.url}`;
    case 'click': return 'selector' in entry.target ? `click ${selectorLabel(entry.target.selector)}` : `click at (${entry.target.point.x}, ${entry.target.point.y})`;
    case 'type': return 'selector' in entry.target ? `type "${entry.text}" into ${selectorLabel(entry.target.selector)}` : `type "${entry.text}" at (${entry.target.point.x}, ${entry.target.point.y})`;
    case 'press': return `press ${entry.key}`;
    case 'scroll': return `scroll ${entry.dy > 0 ? 'down' : 'up'}`;
    case 'wait': return `wait ${entry.ms} ms`;
    case 'textVisible': return `expect the page shows "${entry.text}"`;
    case 'elementVisible': return 'selector' in entry.target ? `expect ${selectorLabel(entry.target.selector)} is visible` : 'expect element is visible';
    case 'urlMatches': return `expect the URL matches ${entry.pattern}`;
  }
}

export type AuthorOptions = {
  goal: string;
  driver: Driver;
  model: LanguageModel;
  baseUrl: string;
  resultsDir?: string;
  maxActions?: number;
  log?: (line: string) => void;
};

export async function authorTest(opts: AuthorOptions): Promise<TestFile> {
  const { goal, driver, model } = opts;
  const maxActions = opts.maxActions ?? 25;
  const log = opts.log ?? (() => {});
  const history: string[] = [];
  const taken: ResolvedAction[] = [];
  let draft: Step[] | undefined;

  await driver.start({ baseUrl: opts.baseUrl, resultsDir: opts.resultsDir ?? '.' });
  try {
    for (let turn = 0; turn < maxActions; turn++) {
      const obs = await driver.observe();
      const lines = [`Goal: ${goal}`, `Base URL: ${opts.baseUrl}`, `Current URL: ${obs.url ?? 'unknown'}`];
      if (history.length) lines.push(`Actions so far:\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n')}`);
      if (obs.a11yTree) lines.push(`Accessibility tree:\n${obs.a11yTree}`);
      const messages: ModelMessage[] = [
        { role: 'user', content: [{ type: 'text', text: lines.join('\n\n') }, { type: 'file', mediaType: 'image/png', data: obs.screenshotPng }] },
      ];
      const { output } = await generateText({ model, instructions: INSTRUCTIONS, messages, output: Output.object({ schema: TurnSchema }) });
      if (output.note) log(output.note);
      if (output.done) {
        if (output.draftSteps?.length) {
          draft = output.draftSteps.map((s): Step => (typeof s === 'string' ? { kind: 'action', text: s } : { kind: 'expect', text: s.expect }));
        }
        break;
      }
      if (!output.nextAction) {
        history.push('(model returned no action)');
        continue;
      }
      const desc = describeEntry(output.nextAction);
      try {
        await driver.act(output.nextAction);
        taken.push(output.nextAction);
        history.push(`${desc} — ok`);
        log(`  ${desc}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        history.push(`${desc} — FAILED: ${msg.split('\n')[0]}`);
        log(`  ${desc} (failed: ${msg.split('\n')[0]})`);
      }
    }
  } finally {
    await driver.stop();
  }

  return { name: goal, target: 'browser', steps: draft ?? taken.map((a) => ({ kind: 'action', text: describeEntry(a) })) };
}
