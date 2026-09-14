import { describe, it, expect } from 'vitest';
import { createLlmResolver, createFakeResolver, buildResolverMessages } from '../src/resolver.js';
import { mockModelReturning, png } from './helpers.js';

const observation = { screenshotPng: png, a11yTree: '- button "Sign in"', url: 'http://x/login' };

describe('createLlmResolver', () => {
  it('returns a validated action for an action step', async () => {
    const { model } = mockModelReturning([{ kind: 'click', target: { selector: 'role=button[name="Sign in"]' } }]);
    const r = createLlmResolver({ model });
    const entry = await r.resolve({ step: { kind: 'action', text: 'click Sign in' }, observation });
    expect(entry).toEqual({ kind: 'click', target: { selector: 'role=button[name="Sign in"]' } });
  });

  it('returns a validated assertion for an expect step', async () => {
    const { model } = mockModelReturning([{ kind: 'textVisible', text: 'Welcome, Alice' }]);
    const r = createLlmResolver({ model });
    const entry = await r.resolve({ step: { kind: 'expect', text: 'the page shows "Welcome, Alice"' }, observation });
    expect(entry).toEqual({ kind: 'textVisible', text: 'Welcome, Alice' });
  });

  it('rejects an action returned for an expect step', async () => {
    const { model } = mockModelReturning([{ kind: 'click', target: { selector: 'text=x' } }]);
    const r = createLlmResolver({ model });
    await expect(r.resolve({ step: { kind: 'expect', text: 'x' }, observation })).rejects.toThrow(/invalid/i);
  });

  it('retries once on invalid output then throws', async () => {
    const { model, calls } = mockModelReturning([{ kind: 'navigate' }, 'not json']);
    const r = createLlmResolver({ model });
    await expect(r.resolve({ step: { kind: 'action', text: 'go to /' }, observation })).rejects.toThrow(/invalid/i);
    expect(calls.length).toBe(2);
  });

  it('recovers when the retry returns valid output', async () => {
    const { model, calls } = mockModelReturning(['garbage', { kind: 'navigate', url: '/login' }]);
    const r = createLlmResolver({ model });
    const entry = await r.resolve({ step: { kind: 'action', text: 'go to /login' }, observation });
    expect(entry).toEqual({ kind: 'navigate', url: '/login' });
    expect(calls.length).toBe(2);
  });
});

describe('buildResolverMessages', () => {
  it('includes step text, screenshot, a11y tree and url', () => {
    const msgs = buildResolverMessages({ step: { kind: 'action', text: 'click Sign in' }, observation });
    const user = msgs.find((m) => m.role === 'user')!;
    const parts = user.content as Array<{ type: string; text?: string; mediaType?: string }>;
    expect(parts.some((p) => p.type === 'text' && p.text?.includes('click Sign in'))).toBe(true);
    expect(parts.some((p) => p.type === 'text' && p.text?.includes('button "Sign in"'))).toBe(true);
    expect(parts.some((p) => p.type === 'text' && p.text?.includes('http://x/login'))).toBe(true);
    expect(parts.some((p) => p.type === 'file' && p.mediaType === 'image/png')).toBe(true);
  });

  it('includes the previous failed entry and error when healing', () => {
    const msgs = buildResolverMessages({
      step: { kind: 'action', text: 'click Sign in' },
      observation,
      previous: { entry: { kind: 'click', target: { selector: 'text=Login' } }, error: 'Timeout 5000ms' },
    });
    const text = JSON.stringify(msgs);
    expect(text).toContain('text=Login');
    expect(text).toContain('Timeout 5000ms');
  });
});

describe('createFakeResolver', () => {
  it('looks up by step text', async () => {
    const r = createFakeResolver({ 'go to /': { kind: 'navigate', url: '/' } });
    expect(await r.resolve({ step: { kind: 'action', text: 'go to /' }, observation })).toEqual({ kind: 'navigate', url: '/' });
  });
  it('throws for unknown steps', async () => {
    const r = createFakeResolver({});
    await expect(r.resolve({ step: { kind: 'action', text: 'zzz' }, observation })).rejects.toThrow(/no fake/i);
  });
});
