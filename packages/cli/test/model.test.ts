import { describe, it, expect } from 'vitest';
import { createModel, envKeyFor, createLazyResolver } from '../src/model.js';

describe('envKeyFor', () => {
  it('maps known providers to their env var', () => {
    expect(envKeyFor('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(envKeyFor('openai')).toBe('OPENAI_API_KEY');
    expect(envKeyFor('google')).toBe('GOOGLE_GENERATIVE_AI_API_KEY');
  });
});

describe('createModel', () => {
  it('builds a model id from provider and model', () => {
    const m = createModel({ provider: 'anthropic', model: 'claude-opus-5' });
    expect(m.modelId).toBe('claude-opus-5');
    expect(m.provider).toMatch(/anthropic/);
  });
  it('rejects unknown providers', () => {
    expect(() => createModel({ provider: 'nope', model: 'x' })).toThrow(/provider/i);
  });
});

describe('createLazyResolver', () => {
  it('fails with a clear message when the api key is missing', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = createLazyResolver({ provider: 'anthropic', model: 'claude-opus-5' });
      await expect(r.resolve({ step: { kind: 'action', text: 'x' }, observation: { screenshotPng: Buffer.alloc(0) } }))
        .rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
