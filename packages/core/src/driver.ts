import type { Observation, Recording, ResolvedAction, ResolvedAssertion } from './schema.js';

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
  stop(): Promise<Recording>;
}
