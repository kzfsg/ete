import { z } from 'zod';
import YAML from 'yaml';

export const TargetSchema = z.union([
  z.object({ selector: z.string().min(1) }),
  z.object({ point: z.object({ x: z.number(), y: z.number() }) }),
]);
export type Target = z.infer<typeof TargetSchema>;

export const ResolvedActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string().min(1) }),
  z.object({ kind: z.literal('click'), target: TargetSchema }),
  z.object({ kind: z.literal('type'), target: TargetSchema, text: z.string() }),
  z.object({ kind: z.literal('press'), key: z.string().min(1) }),
  z.object({ kind: z.literal('scroll'), target: TargetSchema.optional(), dy: z.number() }),
  z.object({ kind: z.literal('wait'), ms: z.number().int().min(0).max(30000) }),
]);
export type ResolvedAction = z.infer<typeof ResolvedActionSchema>;

export const ResolvedAssertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('textVisible'), text: z.string().min(1) }),
  z.object({ kind: z.literal('elementVisible'), target: TargetSchema }),
  z.object({ kind: z.literal('urlMatches'), pattern: z.string().min(1) }),
]);
export type ResolvedAssertion = z.infer<typeof ResolvedAssertionSchema>;
export type ResolvedEntry = ResolvedAction | ResolvedAssertion;

export type Step = { kind: 'action'; text: string } | { kind: 'expect'; text: string };

const RawStep = z.union([z.string().min(1), z.object({ expect: z.string().min(1) }).strict()]);
const RawTestFile = z.object({
  name: z.string().min(1),
  flow: z.string().min(1).optional(),
  target: z.enum(['browser', 'desktop']).default('browser'),
  steps: z.array(RawStep).min(1),
});

export type TestFile = { name: string; flow?: string; target: 'browser' | 'desktop'; steps: Step[] };

export function parseTestFile(yamlText: string): TestFile {
  const raw = RawTestFile.parse(YAML.parse(yamlText));
  return {
    name: raw.name,
    ...(raw.flow ? { flow: raw.flow } : {}),
    target: raw.target,
    steps: raw.steps.map((s): Step =>
      typeof s === 'string' ? { kind: 'action', text: s } : { kind: 'expect', text: s.expect },
    ),
  };
}

export type Observation = { screenshotPng: Buffer; a11yTree?: string; url?: string };
export type Recording = { videoPath?: string; tracePath?: string; filmstripPath?: string };

export type AnomalyKind = 'console-error' | 'page-error' | 'request-failed' | 'http-error' | 'dialog';
export type Anomaly = {
  /** ms since recording start */
  t: number;
  kind: AnomalyKind;
  message: string;
};
export type StepTelemetry = { startMs: number; endMs: number; anomalies: Anomaly[] };
export type StepStatus = 'passed' | 'failed' | 'skipped';
export type StepReport = {
  index: number;
  text: string;
  kind: Step['kind'];
  status: StepStatus;
  durationMs: number;
  screenshot?: string;
  error?: string;
  entry?: ResolvedEntry;
  /** ms since recording start; absent for skipped steps */
  startMs?: number;
  endMs?: number;
  anomalies: Anomaly[];
};
export type Report = {
  name: string;
  file: string;
  flow: string;
  mode: 'replay' | 'session';
  status: 'passed' | 'failed';
  anomalyCount: number;
  durationMs: number;
  steps: StepReport[];
  recording: Recording;
};

/** Written next to a published run so listing pages need no per-test fetches. */
export type RunManifest = {
  version: 1;
  owner: string;
  repo: string;
  ref: { kind: 'pr'; number: number } | { kind: 'branch'; name: string };
  runId: string;
  attempt?: string;
  commit?: string;
  branch?: string;
  publishedAt: string;
  source: 'ci' | 'local';
  totals: { tests: number; passed: number; anomalies: number };
  tests: Array<{
    dir: string;
    /** Test file path in the repo, for the fix command. */
    file?: string;
    name: string;
    flow: string;
    status: 'passed' | 'failed';
    durationMs: number;
    anomalyCount: number;
    steps: number;
    failedStep?: { index: number; text: string; error?: string; screenshot?: string };
    blobs: { report: string; video?: string; trace?: string; filmstrip?: string; screenshots: Record<string, string> };
  }>;
};
