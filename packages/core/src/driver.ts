import type { Observation, Recording, ResolvedAction, ResolvedAssertion, StepTelemetry } from './schema.js';

export interface DriverStartOptions {
  baseUrl: string;
  resultsDir: string;
  headed?: boolean;
}

/**
 * The seam between the runner and a concrete automation backend.
 * Browser today (Playwright); desktop later, with `point` targets.
 */
export interface Driver {
  start(opts: DriverStartOptions): Promise<void>;
  observe(): Promise<Observation>;
  act(action: ResolvedAction): Promise<void>;
  check(assertion: ResolvedAssertion): Promise<boolean>;
  screenshot(path: string): Promise<void>;
  /** Marks the start of a step: groups the trace and starts collecting anomalies. */
  beginStep(label: string): Promise<void>;
  /** Ends the current step and returns its timing and anomalies. */
  endStep(): Promise<StepTelemetry>;
  stop(): Promise<Recording>;
}
