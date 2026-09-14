import { MockLanguageModelV4 } from 'ai/test';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

/** A mock model that returns each JSON payload in order, then repeats the last one. */
export function mockModelReturning(payloads: unknown[]) {
  let i = 0;
  const calls: unknown[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      const payload = payloads[Math.min(i++, payloads.length - 1)];
      return {
        content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  return { model, calls };
}

export const png = Buffer.from('89504e470d0a1a0a', 'hex');
