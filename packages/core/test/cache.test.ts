import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashStep, loadResolved, saveResolved, resolvedPathFor } from '../src/cache.js';

describe('hashStep', () => {
  it('is stable for the same text', () => {
    expect(hashStep('click Sign in')).toBe(hashStep('click Sign in'));
  });
  it('differs when the text changes', () => {
    expect(hashStep('click Sign in')).not.toBe(hashStep('click Sign out'));
  });
});

describe('resolved cache file', () => {
  it('returns an empty file when the path does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ete-'));
    expect(await loadResolved(join(dir, 'nope.json'))).toEqual({ version: 1, steps: {} });
  });
  it('round-trips through save and load, creating parent dirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ete-'));
    const path = join(dir, 'nested', 'login.json');
    const file = { version: 1 as const, steps: { abc: { kind: 'navigate' as const, url: '/login' } } };
    await saveResolved(path, file);
    expect(await loadResolved(path)).toEqual(file);
  });
});

describe('resolvedPathFor', () => {
  it('maps a test path into the .resolved sibling dir', () => {
    expect(resolvedPathFor('e2e/login.yaml')).toBe('e2e/.resolved/login.json');
    expect(resolvedPathFor('e2e/a/b.yaml')).toBe('e2e/.resolved/a/b.json');
  });
});
