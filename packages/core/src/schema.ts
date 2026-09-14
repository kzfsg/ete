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
  target: z.enum(['browser', 'desktop']).default('browser'),
  steps: z.array(RawStep).min(1),
});

export type TestFile = { name: string; target: 'browser' | 'desktop'; steps: Step[] };

export function parseTestFile(yamlText: string): TestFile {
  const raw = RawTestFile.parse(YAML.parse(yamlText));
  return {
    name: raw.name,
    target: raw.target,
    steps: raw.steps.map((s): Step =>
      typeof s === 'string' ? { kind: 'action', text: s } : { kind: 'expect', text: s.expect },
    ),
  };
}

export type Observation = { screenshotPng: Buffer; a11yTree?: string; url?: string };
export type Recording = { videoPath?: string; tracePath?: string };
export type StepStatus = 'passed' | 'resolved' | 'healed' | 'failed' | 'skipped';
export type StepReport = {
  index: number;
  text: string;
  kind: Step['kind'];
  status: StepStatus;
  durationMs: number;
  screenshot?: string;
  error?: string;
  healedFrom?: ResolvedEntry;
  entry?: ResolvedEntry;
};
export type Report = {
  name: string;
  file: string;
  status: 'passed' | 'failed';
  durationMs: number;
  steps: StepReport[];
  recording: Recording;
};
