import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hashStep, type ResolvedFile } from './cache.js';
import type { Driver } from './driver.js';
import { flowFor } from './flow.js';
import type { Recording, Report, ResolvedAction, ResolvedAssertion, StepReport, TestFile } from './schema.js';

export type RunOptions = {
  testPath: string;
  test: TestFile;
  driver: Driver;
  resolved: ResolvedFile;
  baseUrl: string;
  resultsDir: string;
  headed?: boolean;
  log?: (line: string) => void;
};

export type RunResult = { report: Report };

export const NO_RECORDED_ACTION = 'No recorded action for this step';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The exact command an agent runs to fix a failed step. */
export function resumeHint(testPath: string, stepIndex: number): string {
  return `ete session start --from ${testPath} --at ${stepIndex}`;
}

/**
 * Deterministic replay: every step must have a recorded entry in the resolved cache.
 * Nothing here ever calls a model; a missing or broken entry fails the step and the
 * report carries the exact resume command for the agent.
 */
export async function runTest(opts: RunOptions): Promise<RunResult> {
  const { test, driver, resultsDir } = opts;
  const log = opts.log ?? (() => {});
  const steps: StepReport[] = [];
  const started = Date.now();

  await mkdir(join(resultsDir, 'steps'), { recursive: true });
  await driver.start({ baseUrl: opts.baseUrl, resultsDir, headed: opts.headed });

  let failed = false;
  let recording: Recording;
  try {
    for (let i = 0; i < test.steps.length; i++) {
      const step = test.steps[i]!;
      const index = i + 1;
      const report: StepReport = { index, text: step.text, kind: step.kind, status: 'passed', durationMs: 0, anomalies: [] };
      steps.push(report);
      if (failed) {
        report.status = 'skipped';
        continue;
      }
      const entry = opts.resolved.steps[hashStep(step.text)];
      report.entry = entry;
      const stepStart = Date.now();
      await driver.beginStep(step.text);
      try {
        if (!entry) throw new Error(`${NO_RECORDED_ACTION} (edit or new step?)`);
        if (step.kind === 'action') {
          await driver.act(entry as ResolvedAction);
        } else if (!(await driver.check(entry as ResolvedAssertion))) {
          throw new Error(`Assertion failed: ${JSON.stringify(entry)}`);
        }
      } catch (err) {
        report.status = 'failed';
        report.error = errorMessage(err);
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
      if (report.status === 'failed') log(`   fix: ${resumeHint(opts.testPath, index)}`);
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
      durationMs: Date.now() - started,
      anomalyCount: steps.reduce((n, s) => n + s.anomalies.length, 0),
      steps,
      recording,
    },
  };
}

export function glyph(status: StepReport['status']): string {
  return { passed: '✓', failed: '✗', skipped: '-' }[status];
}
