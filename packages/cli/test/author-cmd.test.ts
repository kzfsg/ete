import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockLanguageModelV4 } from 'ai/test';
import type { Driver } from '@ete/core';
import { authorCommand, slugify, toYaml } from '../src/commands/author.js';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
function model(payloads: unknown[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(payloads[Math.min(i++, payloads.length - 1)]) }],
      finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [],
    }),
  });
}
const fakeDriver = (): Driver => ({
  start: async () => {}, observe: async () => ({ screenshotPng: Buffer.from('89504e470d0a1a0a', 'hex') }),
  act: async () => {}, check: async () => true, screenshot: async () => {}, stop: async () => ({}),
});

describe('slugify / toYaml', () => {
  it('slugifies goals', () => {
    expect(slugify('A user can log in!')).toBe('a-user-can-log-in');
  });
  it('serialises steps to the test file format', () => {
    expect(toYaml({ name: 'T', target: 'browser', steps: [{ kind: 'action', text: 'go to /' }, { kind: 'expect', text: 'ok' }] }))
      .toBe('name: T\nsteps:\n  - go to /\n  - expect: ok\n');
  });
});

describe('ete author', () => {
  it('writes a draft test file from the model exploration', async () => {
    const s = createServer((_, res) => { res.writeHead(200); res.end(); });
    await new Promise<void>((r) => s.listen(0, r));
    const cwd = await mkdtemp(join(tmpdir(), 'ete-auth-'));
    await writeFile(join(cwd, 'ete.yaml'), `url: http://localhost:${(s.address() as AddressInfo).port}\n`);
    const out = await authorCommand({
      cwd, goal: 'A user can log in', log: () => {}, createDriver: fakeDriver,
      model: model([{ done: false, nextAction: { kind: 'navigate', url: '/login' } }, { done: true, draftSteps: ['go to /login', { expect: 'form shown' }] }]),
    });
    expect(out).toBe('e2e/a-user-can-log-in.yaml');
    expect(await readFile(join(cwd, out), 'utf8')).toBe('name: A user can log in\nsteps:\n  - go to /login\n  - expect: form shown\n');
    await expect(authorCommand({ cwd, goal: 'A user can log in', log: () => {}, createDriver: fakeDriver, model: model([{ done: true }]) }))
      .rejects.toThrow(/already exists/);
    await new Promise<void>((r) => s.close(() => r()));
  });
});
