import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyResolved, hashStep, type ResolvedFile } from './cache.js';
import { describeEntry } from './describe.js';
import type { Driver } from './driver.js';
import { flowFor } from './flow.js';
import type { Recording, Report, ResolvedAction, ResolvedAssertion, ResolvedEntry, Step, StepReport, StepTelemetry, TestFile } from './schema.js';

export type RecorderOptions = {
  driver: Driver;
  name: string;
  flow?: string;
  testPath: string;
  baseUrl: string;
  resultsDir: string;
  headed?: boolean;
  /** Steps to replay before recording resumes (heal/extend an existing test). */
  prefix?: { steps: Step[]; entries: ResolvedEntry[] };
  log?: (line: string) => void;
};

export type StepResult = {
  ok: boolean;
  recorded: boolean;
  error?: string;
  telemetry?: StepTelemetry;
  step?: StepReport;
};

export type RecorderOutput = { report: Report; test: TestFile; resolved: ResolvedFile };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Records an agent-driven browser session as a replayable test. The agent decides what to do;
 * the recorder executes it, keeps only what worked (unless told otherwise), and captures
 * telemetry, screenshots, and the recording. No model is involved.
 */
export class Recorder {
  private readonly driver: Driver;
  private readonly opts: RecorderOptions;
  private readonly recorded: StepReport[] = [];
  private readonly entries: ResolvedEntry[] = [];
  private readonly startedAt = Date.now();
  private started = false;
  private finished = false;

  constructor(opts: RecorderOptions) {
    this.opts = opts;
    this.driver = opts.driver;
  }

  async start(): Promise<void> {
    const { driver, resultsDir, prefix } = this.opts;
    await mkdir(join(resultsDir, 'steps'), { recursive: true });
    await driver.start({ baseUrl: this.opts.baseUrl, resultsDir, headed: this.opts.headed });
    this.started = true;
    if (!prefix) return;
    for (let i = 0; i < prefix.steps.length; i++) {
      const step = prefix.steps[i]!;
      const entry = prefix.entries[i];
      const res = await this.execute(entry, step, { record: true, allowFailure: false });
      if (!res.ok) {
        await this.abort();
        throw new Error(`Could not replay prefix step ${i + 1} "${step.text}": ${res.error}`);
      }
    }
  }

  steps(): StepReport[] {
    return [...this.recorded];
  }

  async act(entry: ResolvedAction, o: { as?: string } = {}): Promise<StepResult> {
    return this.execute(entry, { kind: 'action', text: o.as ?? describeEntry(entry) }, { record: false, allowFailure: true });
  }

  async expect(assertion: ResolvedAssertion, o: { as?: string; record?: boolean } = {}): Promise<StepResult> {
    const text = o.as ?? describeEntry(assertion).replace(/^expect /, '');
    return this.execute(assertion, { kind: 'expect', text }, { record: o.record ?? false, allowFailure: true });
  }

  /** Drops the last recorded step. The browser state is not rewound. */
  undo(): StepReport | undefined {
    const step = this.recorded.pop();
    if (step) this.entries.pop();
    return step;
  }

  private async execute(
    entry: ResolvedEntry | undefined,
    step: Step,
    o: { record: boolean; allowFailure: boolean },
  ): Promise<StepResult> {
    if (!this.started || this.finished) throw new Error('Recorder is not active');
    const driver = this.driver;
    const index = this.recorded.length + 1;
    const report: StepReport = { index, text: step.text, kind: step.kind, status: 'passed', durationMs: 0, entry, anomalies: [] };
    const t = Date.now();
    let error: string | undefined;
    await driver.beginStep(step.text);
    try {
      if (!entry) throw new Error('No recorded action for this step');
      if (step.kind === 'action') await driver.act(entry as ResolvedAction);
      else if (!(await driver.check(entry as ResolvedAssertion))) throw new Error(`Assertion failed: ${JSON.stringify(entry)}`);
    } catch (err) {
      error = errorMessage(err);
    }
    report.durationMs = Date.now() - t;
    let telemetry: StepTelemetry | undefined;
    try {
      telemetry = await driver.endStep();
      report.startMs = telemetry.startMs;
      report.endMs = telemetry.endMs;
      report.anomalies = telemetry.anomalies;
    } catch (err) {
      this.opts.log?.(`telemetry failed: ${errorMessage(err)}`);
    }
    const ok = !error;
    // Successful steps are always kept; failures only when explicitly requested.
    const keep = ok || o.record;
    if (!keep) return { ok, recorded: false, error, telemetry };
    if (!ok) {
      report.status = 'failed';
      report.error = error;
    }
    const shot = `steps/${String(index).padStart(2, '0')}.png`;
    try {
      await driver.screenshot(join(this.opts.resultsDir, shot));
      report.screenshot = shot;
    } catch (err) {
      this.opts.log?.(`screenshot failed for step ${index}: ${errorMessage(err)}`);
    }
    this.recorded.push(report);
    this.entries.push(entry!);
    return { ok, recorded: true, error, telemetry, step: report };
  }

  async finish(): Promise<RecorderOutput> {
    if (this.finished) throw new Error('Recorder already finished');
    this.finished = true;
    const recording: Recording = await this.driver.stop();
    const flow = flowFor(this.opts.testPath, this.opts.flow);
    const failed = this.recorded.some((s) => s.status === 'failed');
    const report: Report = {
      name: this.opts.name,
      file: this.opts.testPath,
      flow,
      mode: 'session',
      status: failed ? 'failed' : 'passed',
      durationMs: Date.now() - this.startedAt,
      anomalyCount: this.recorded.reduce((n, s) => n + s.anomalies.length, 0),
      steps: this.recorded,
      recording,
    };
    const test: TestFile = {
      name: this.opts.name,
      ...(this.opts.flow ? { flow: this.opts.flow } : {}),
      target: 'browser',
      steps: this.recorded.map((s): Step => ({ kind: s.kind, text: s.text })),
    };
    const resolved = emptyResolved();
    this.recorded.forEach((s, i) => { resolved.steps[hashStep(s.text)] = this.entries[i]!; });
    return { report, test, resolved };
  }

  async abort(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.driver.stop();
  }
}
