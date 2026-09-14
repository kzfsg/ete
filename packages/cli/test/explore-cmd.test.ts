import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { MockLanguageModelV4 } from 'ai/test';
import { hashStep } from '@ete/core';
import { createDemoServer } from '../../../fixtures/demo-app/server.mjs';
import { exploreCommand, slugify, toYaml } from '../src/commands/explore.js';
import { runCommand } from '../src/commands/run.js';

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

let server: ReturnType<typeof createDemoServer>;
let url: string;
beforeAll(async () => {
  server = createDemoServer();
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('slugify / toYaml', () => {
  it('slugifies goals', () => {
    expect(slugify('A user can log in!')).toBe('a-user-can-log-in');
  });
  it('serialises steps and flow', () => {
    expect(toYaml({ name: 'T', flow: 'Login', target: 'browser', steps: [{ kind: 'action', text: 'go to /' }, { kind: 'expect', text: 'ok' }] }))
      .toBe('name: T\nflow: Login\nsteps:\n  - go to /\n  - expect: ok\n');
  });
});

describe('ete explore', () => {
  it('records a real exploration, saves a replayable test, and the replay passes without a key', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ete-expl-'));
    await writeFile(join(cwd, 'ete.yaml'), `url: ${url}\nheal:\n  maxPerRun: 0\n`);
    const lines: string[] = [];
    const result = await exploreCommand({
      cwd, goal: 'A user can log in', flow: 'Login', save: true, log: (l) => lines.push(l),
      model: model([
        { nextAction: { kind: 'navigate', url: '/login.html' } },
        { nextAction: { kind: 'type', target: { selector: 'css=input[name=email]' }, text: 'alice@example.com' } },
        { nextAction: { kind: 'click', target: { selector: 'role=button[name="Sign in"]' } } },
        { nextAssertion: { kind: 'textVisible', text: 'Welcome, Alice' } },
        { done: true, summary: 'Logged in' },
      ]),
    });
    expect(result.savedTo).toBe('e2e/login/a-user-can-log-in.yaml');
    expect(result.report.status).toBe('passed');
    expect(result.report.mode).toBe('explore');
    const yaml = await readFile(join(cwd, 'e2e/login/a-user-can-log-in.yaml'), 'utf8');
    expect(yaml).toContain('flow: Login');
    expect(yaml).toContain('- expect: the page shows "Welcome, Alice"');
    const resolved = JSON.parse(await readFile(join(cwd, 'e2e/.resolved/login/a-user-can-log-in.json'), 'utf8'));
    expect(resolved.steps[hashStep('the page shows "Welcome, Alice"')]).toEqual({ kind: 'textVisible', text: 'Welcome, Alice' });
    const dir = join(cwd, 'ete-results', 'a-user-can-log-in');
    expect((await stat(join(dir, 'video.webm'))).size).toBeGreaterThan(0);
    expect((await stat(join(dir, 'filmstrip.png'))).size).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')).recording.filmstripPath).toBe('filmstrip.png');

    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const out: string[] = [];
      const code = await runCommand({ cwd, files: [], ci: true, log: (l) => out.push(l) });
      expect(code).toBe(0);
      expect(out.join('\n')).toMatch(/## Login/);
      const replay = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
      expect(replay.mode).toBe('replay');
      expect(replay.flow).toBe('Login');
      expect(replay.steps.map((s: { status: string }) => s.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  }, 90_000);

  it('does not save without --save and reports failure when an assertion fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ete-expl-'));
    await writeFile(join(cwd, 'ete.yaml'), `url: ${url}\n`);
    const result = await exploreCommand({
      cwd, goal: 'Nothing here', save: false, log: () => {},
      model: model([{ nextAction: { kind: 'navigate', url: '/' } }, { nextAssertion: { kind: 'textVisible', text: 'Absent text' } }, { done: true }]),
    });
    expect(result.savedTo).toBeUndefined();
    expect(result.report.status).toBe('failed');
    await expect(stat(join(cwd, 'e2e'))).rejects.toThrow();
  }, 60_000);
});
