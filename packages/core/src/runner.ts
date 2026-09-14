import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyResolved, hashStep, type ResolvedFile } from './cache.js';
import type { Driver } from './driver.js';
import { flowFor } from './flow.js';
import type { Resolver } from './resolver.js';
import {
  type Recording,
  type Report,
  type ResolvedAction,
  type ResolvedAssertion,
  type ResolvedEntry,
  type Step,
  type StepReport,
  type TestFile,
} from './schema.js';

export type HealBudget = { maxPerRun: number; maxPerStep: number };

export type RunOptions = {
  testPath: string;
  test: TestFile;
  driver: Driver;
  resolver: Resolver;
  resolved: ResolvedFile;
  baseUrl: string;
  resultsDir: string;
  heal: HealBudget;
  ci: boolean;
  headed?: boolean;
  log?: (line: string) => void;
};

export type RunResult = {
  report: Report;
  /** The full resolved file with any new or healed entries applied. */
  resolved: ResolvedFile;
  /** Only the entries that were resolved or healed during this run. */
  healed: ResolvedFile;
};

class StepFailure extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runTest(opts: RunOptions): Promise<RunResult> {
  const { test, driver, resolver, resultsDir, heal } = opts;
  const log = opts.log ?? (() => {});
  const resolved: ResolvedFile = { version: 1, steps: { ...opts.resolved.steps } };
  const healed = emptyResolved();
  const steps: StepReport[] = [];
  const started = Date.now();
  let healsThisRun = 0;

  await mkdir(join(resultsDir, 'steps'), { recursive: true });
  await driver.start({ baseUrl: opts.baseUrl, resultsDir, headed: opts.headed });

  const canHeal = (perStep: number) => healsThisRun < heal.maxPerRun && perStep < heal.maxPerStep;

  async function resolveEntry(step: Step, previous?: { entry: ResolvedEntry; error: string }): Promise<ResolvedEntry> {
    const observation = await driver.observe();
    return resolver.resolve({ step, observation, previous });
  }

  async function runAction(step: Step, entry: ResolvedAction | undefined, report: StepReport): Promise<ResolvedEntry> {
    let current: ResolvedEntry | undefined = entry;
    let perStep = 0;
    let lastError: string | undefined;
    if (!current) {
      current = await resolveEntry(step);
      report.status = 'resolved';
    }
    for (;;) {
      try {
        await driver.act(current as ResolvedAction);
        return current;
      } catch (err) {
        lastError = errorMessage(err);
        if (!canHeal(perStep)) throw new StepFailure(lastError);
        healsThisRun++;
        perStep++;
        const previous = current;
        current = await resolveEntry(step, { entry: previous, error: lastError });
        if (report.status !== 'resolved') {
          report.status = 'healed';
          report.healedFrom = report.healedFrom ?? previous;
        }
      }
    }
  }

  async function runAssertion(step: Step, entry: ResolvedAssertion | undefined, report: StepReport): Promise<ResolvedEntry> {
    let current: ResolvedEntry | undefined = entry;
    if (!current) {
      current = await resolveEntry(step);
      report.status = 'resolved';
    }
    if (await driver.check(current as ResolvedAssertion)) return current;
    // The LLM may re-resolve *where* to look, once. It never judges pass/fail.
    if (!canHeal(0)) throw new StepFailure(`Assertion failed: ${JSON.stringify(current)}`);
    healsThisRun++;
    const previous = current;
    current = await resolveEntry(step, { entry: previous, error: 'assertion returned false' });
    if (await driver.check(current as ResolvedAssertion)) {
      if (report.status !== 'resolved') {
        report.status = 'healed';
        report.healedFrom = previous;
      }
      return current;
    }
    throw new StepFailure(`Assertion failed after re-resolve: ${JSON.stringify(current)}`);
  }

  let failed = false;
  let recording: Recording;
  try {
    for (let i = 0; i < test.steps.length; i++) {
      const step = test.steps[i];
      const index = i + 1;
      const report: StepReport = { index, text: step.text, kind: step.kind, status: 'passed', durationMs: 0, anomalies: [] };
      steps.push(report);
      if (failed) {
        report.status = 'skipped';
        continue;
      }
      const hash = hashStep(step.text);
      const cached = resolved.steps[hash];
      const stepStart = Date.now();
      await driver.beginStep(step.text);
      try {
        const entry =
          step.kind === 'action'
            ? await runAction(step, cached as ResolvedAction | undefined, report)
            : await runAssertion(step, cached as ResolvedAssertion | undefined, report);
        report.entry = entry;
        if (report.status === 'resolved' || report.status === 'healed') {
          resolved.steps[hash] = entry;
          healed.steps[hash] = entry;
        }
      } catch (err) {
        report.status = 'failed';
        report.error = errorMessage(err);
        report.entry = cached;
        failed = true;
      } finally {
        report.durationMs = Date.now() - stepStart;
        try {
          const t = await driver.endStep();
          report.startMs = t.startMs;
          report.endMs = t.endMs;
          report.anomalies = t.anomalies;
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
      log(`${glyph(report.status)} ${index}. ${step.text}${report.error ? ` — ${report.error}` : ''}`);
    }
  } finally {
    recording = await driver.stop();
  }

  return {
    report: {
      name: test.name,
      file: opts.testPath,
      flow: flowFor(opts.testPath, test.flow),
      mode: 'replay',
      status: failed ? 'failed' : 'passed',
      anomalyCount: steps.reduce((n, s) => n + s.anomalies.length, 0),
      durationMs: Date.now() - started,
      steps,
      recording,
    },
    resolved,
    healed,
  };
}

export function glyph(status: StepReport['status']): string {
  return { passed: '✓', resolved: '+', healed: '~', failed: '✗', skipped: '-' }[status];
}
