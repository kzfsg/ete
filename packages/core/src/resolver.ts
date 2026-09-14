import { generateText, Output, type LanguageModel, type ModelMessage } from 'ai';
import type { z } from 'zod';
import {
  ResolvedActionSchema,
  ResolvedAssertionSchema,
  type Observation,
  type ResolvedEntry,
  type Step,
} from './schema.js';

export type ResolveInput = {
  step: Step;
  observation: Observation;
  /** Present when healing: the entry that just failed and why. */
  previous?: { entry: ResolvedEntry; error: string };
};

export interface Resolver {
  resolve(input: ResolveInput): Promise<ResolvedEntry>;
}

const SYSTEM_PROMPT = `You turn one natural-language end-to-end test step into exactly one concrete browser action or assertion for the page shown.

You are given a screenshot, the page URL, and an accessibility tree of the current page. Use them to pick the target.

Selectors are Playwright selector strings. Prefer, in order:
- role=button[name="Sign in"]   (role + accessible name; most stable)
- text=Welcome, Alice           (visible text)
- placeholder=Email             (input placeholder)
- css=input[name=email]         (CSS, when nothing better exists)

Rules:
- "go to X" or "open X" -> navigate with the path or URL as written.
- Quoted text in the step is literal: type it exactly, or match it exactly.
- If a previous attempt is shown with an error, choose a different target that fixes the error.
- Never decide whether the step passed. Only say where to act or what to check.
- Output only the JSON object, nothing else.`;

export const RESOLVER_INSTRUCTIONS = SYSTEM_PROMPT;

/** User-turn messages only; pass RESOLVER_INSTRUCTIONS as `instructions`. */
export function buildResolverMessages(input: ResolveInput): ModelMessage[] {
  const { step, observation, previous } = input;
  const ask =
    step.kind === 'action'
      ? `Step to perform: ${step.text}\nReturn one action.`
      : `Expectation to check: ${step.text}\nReturn one assertion (textVisible, elementVisible, or urlMatches).`;
  const lines: string[] = [ask];
  if (observation.url) lines.push(`Current URL: ${observation.url}`);
  if (previous) {
    lines.push(`Previous attempt: ${JSON.stringify(previous.entry)}`);
    lines.push(`It failed with: ${previous.error}`);
  }
  if (observation.a11yTree) lines.push(`Accessibility tree:\n${observation.a11yTree}`);
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: lines.join('\n\n') },
        { type: 'file', mediaType: 'image/png', data: observation.screenshotPng },
      ],
    },
  ];
}

async function generateEntry<T extends ResolvedEntry>(
  model: LanguageModel,
  schema: z.ZodType<T>,
  messages: ModelMessage[],
): Promise<T> {
  const { output } = await generateText({
    model,
    instructions: RESOLVER_INSTRUCTIONS,
    messages,
    output: Output.object({ schema }),
    maxRetries: 0,
  });
  return output;
}

export function createLlmResolver(opts: { model: LanguageModel }): Resolver {
  return {
    async resolve(input) {
      const messages = buildResolverMessages(input);
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return input.step.kind === 'action'
            ? await generateEntry(opts.model, ResolvedActionSchema, messages)
            : await generateEntry(opts.model, ResolvedAssertionSchema, messages);
        } catch (err) {
          lastError = err;
        }
      }
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`Resolver returned invalid output for step "${input.step.text}": ${detail}`, { cause: lastError });
    },
  };
}

export function createFakeResolver(
  source: Record<string, ResolvedEntry> | ((input: ResolveInput) => ResolvedEntry),
): Resolver {
  return {
    async resolve(input) {
      if (typeof source === 'function') return source(input);
      const entry = source[input.step.text];
      if (!entry) throw new Error(`No fake resolution for step "${input.step.text}"`);
      return entry;
    },
  };
}
