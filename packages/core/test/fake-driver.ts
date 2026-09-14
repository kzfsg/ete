import type { Driver, DriverStartOptions } from '../src/driver.js';
import type { Anomaly, Observation, Recording, ResolvedAction, ResolvedAssertion, StepTelemetry } from '../src/schema.js';
import { png } from './helpers.js';

export class FakeDriver implements Driver {
  calls: string[] = [];
  acted: ResolvedAction[] = [];
  checked: ResolvedAssertion[] = [];
  screenshots: string[] = [];
  startOpts?: DriverStartOptions;
  stopped = false;
  /** selectors whose click/type throws */
  failOn = new Set<string>();
  /** textVisible texts that return true */
  visibleTexts = new Set<string>();
  /** if set, act() throws this for every action */
  crash?: Error;
  /** step labels seen by beginStep */
  stepLabels: string[] = [];
  /** anomalies to hand back from the next endStep calls, in order */
  anomalyQueue: Anomaly[][] = [];
  private clock = 0;
  private stepStart = 0;

  async beginStep(label: string) { this.calls.push('beginStep'); this.stepLabels.push(label); this.clock += 10; this.stepStart = this.clock; }
  async endStep(): Promise<StepTelemetry> { this.calls.push('endStep'); this.clock += 100; return { startMs: this.stepStart, endMs: this.clock, anomalies: this.anomalyQueue.shift() ?? [] }; }

  async start(opts: DriverStartOptions) { this.startOpts = opts; this.calls.push('start'); }
  async observe(): Promise<Observation> { this.calls.push('observe'); return { screenshotPng: png, a11yTree: '- fake', url: 'http://fake/' }; }
  async act(action: ResolvedAction) {
    this.calls.push('act');
    this.acted.push(action);
    if (this.crash) throw this.crash;
    const sel = 'target' in action && action.target && 'selector' in action.target ? action.target.selector : undefined;
    if (sel && this.failOn.has(sel)) throw new Error(`Timeout 5000ms waiting for ${sel}`);
  }
  async check(assertion: ResolvedAssertion) {
    this.calls.push('check');
    this.checked.push(assertion);
    return assertion.kind === 'textVisible' && this.visibleTexts.has(assertion.text);
  }
  async screenshot(path: string) { this.screenshots.push(path); }
  async stop(): Promise<Recording> { this.stopped = true; this.calls.push('stop'); return { videoPath: 'video.webm', tracePath: 'trace.zip' }; }
}
