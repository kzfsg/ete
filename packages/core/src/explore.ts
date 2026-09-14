import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateText, Output, type LanguageModel, type ModelMessage } from 'ai';
import { z } from 'zod';
import { describeEntry } from './describe.js';
import { emptyResolved, hashStep, type ResolvedFile } from './cache.js';
import type { Driver } from './driver.js';
import { flowFor } from './flow.js';
import {
  ResolvedActionSchema,
  ResolvedAssertionSchema,
  type Recording,
  type Report,
  type ResolvedEntry,
  type Step,
  type StepReport,
  type TestFile,
} from './schema.js';

const TurnSchema = z.object({
  nextAction: ResolvedActionSchema.optional(),
  nextAssertion: ResolvedAssertionSchema.optional(),
  done: z.boolean().optional(),
  summary: z.string().optional(),
});

export const EXPLORE_INSTRUCTIONS = `You are driving a real browser to walk through a user flow and record it as an end-to-end test.

Each turn you see a screenshot, the URL, an accessibility tree, and what has happened so far. Reply with exactly one of:
- { "nextAction": ... }      take ONE action, then look again
- { "nextAssertion": ... }   check something that should be true now (textVisible / elementVisible / urlMatches)
- { "done": true, "summary": "..." }  the goal is complete, or clearly impossible

Rules:
- Prefer few, decisive actions. One UI interaction per turn.
- After every meaningful transition (a form submit, a navigation, an item added) add an assertion for what a user would expect to see.
- Never repeat an action that already failed; choose a different target.
- Selectors are Playwright selector strings: role=button[name="Sign in"], text=Welcome, label=Password, placeholder=Email, css=input[name=email].
- For "go to" use navigate with a path relative to the base URL.
- You do not decide whether assertions pass; they are checked for you.`;

export type ExploreOptions = {
  goal: string;
  driver: Driver;
  model: LanguageModel;
  baseUrl: string;
  resultsDir: string;
  /** Path the test will be saved to; used for the report's file/flow. */
  testPath: string;
  flow?: string;
  maxActions?: number;
  headed?: boolean;
  log?: (line: string) => void;
};

export type ExploreResult = { report: Report; test: TestFile; resolved: ResolvedFile; summary?: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function exploreFlow(opts: ExploreOptions): Promise<ExploreResult> {
  const { goal, driver, model, resultsDir } = opts;
  const maxActions = opts.maxActions ?? 30;
  const log = opts.log ?? (() => {});
  const flow = flowFor(opts.testPath, opts.flow);
  const steps: StepReport[] = [];
  const testSteps: Step[] = [];
  const resolved = emptyResolved();
  const history: string[] = [];
  const started = Date.now();
  let failed = false;
  let summary: string | undefined;

  await mkdir(join(resultsDir, 'steps'), { recursive: true });
  await driver.start({ baseUrl: opts.baseUrl, resultsDir, headed: opts.headed });

  async function record(entry: ResolvedEntry, step: Step, execute: () => Promise<string | undefined>): Promise<void> {
    const index = steps.length + 1;
    const report: StepReport = { index, text: step.text, kind: step.kind, status: 'passed', durationMs: 0, entry, anomalies: [] };
    steps.push(report);
    testSteps.push(step);
    resolved.steps[hashStep(step.text)] = entry;
    const t = Date.now();
    await driver.beginStep(step.text);
    try {
      const error = await execute();
      if (error) {
        report.status = 'failed';
        report.error = error;
        failed = true;
      }
    } finally {
      report.durationMs = Date.now() - t;
      try {
        const tel = await driver.endStep();
        report.startMs = tel.startMs;
        report.endMs = tel.endMs;
        report.anomalies = tel.anomalies;
      } catch (err) {
        log(`telemetry failed for step ${index}: ${errorMessage(err)}`);
      }
      const shot = `steps/${String(index).padStart(2, '0')}.png`;
      try {
        await driver.screenshot(join(resultsDir, shot));
        report.screenshot = shot;
      } catch (err) {
        log(`screenshot failed for step ${index}: ${errorMessage(err)}`);
      }
    }
    const outcome = report.error ? `FAILED: ${report.error.split('\n')[0]}` : 'ok';
    history.push(`${step.kind === 'expect' ? 'expect ' : ''}${step.text} — ${outcome}`);
    log(`  ${report.status === 'failed' ? '✗' : '✓'} ${index}. ${step.text}${report.error ? ` — ${report.error.split('\n')[0]}` : ''}`);
  }

  let recording: Recording;
  try {
    for (let turn = 0; turn < maxActions; turn++) {
      const obs = await driver.observe();
      const lines = [`Goal: ${goal}`, `Base URL: ${opts.baseUrl}`, `Current URL: ${obs.url ?? 'unknown'}`];
      if (history.length) lines.push(`So far:\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n')}`);
      if (obs.a11yTree) lines.push(`Accessibility tree:\n${obs.a11yTree}`);
      const messages: ModelMessage[] = [
        { role: 'user', content: [{ type: 'text', text: lines.join('\n\n') }, { type: 'file', mediaType: 'image/png', data: obs.screenshotPng }] },
      ];
      const { output } = await generateText({ model, instructions: EXPLORE_INSTRUCTIONS, messages, output: Output.object({ schema: TurnSchema }) });

      if (output.done) {
        summary = output.summary;
        if (summary) log(`  done: ${summary}`);
        break;
      }
      if (output.nextAction) {
        const action = output.nextAction;
        await record(action, { kind: 'action', text: describeEntry(action) }, async () => {
          try {
            await driver.act(action);
            return undefined;
          } catch (err) {
            return errorMessage(err);
          }
        });
        continue;
      }
      if (output.nextAssertion) {
        const assertion = output.nextAssertion;
        await record(assertion, { kind: 'expect', text: describeEntry(assertion).replace(/^expect /, '') }, async () =>
          (await driver.check(assertion)) ? undefined : `Assertion failed: ${JSON.stringify(assertion)}`,
        );
        continue;
      }
      history.push('(model returned neither an action nor an assertion)');
    }
  } finally {
    recording = await driver.stop();
  }

  const report: Report = {
    name: goal,
    file: opts.testPath,
    flow,
    mode: 'explore',
    status: failed ? 'failed' : 'passed',
    durationMs: Date.now() - started,
    anomalyCount: steps.reduce((n, s) => n + s.anomalies.length, 0),
    steps,
    recording,
  };
  const test: TestFile = { name: goal, flow, target: 'browser', steps: testSteps };
  return { report, test, resolved, summary };
}
