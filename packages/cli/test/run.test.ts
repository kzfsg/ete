import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { hashStep } from '@ete/core';
import { createDemoServer } from '../../../fixtures/demo-app/server.mjs';
import { runCommand } from '../src/commands/run.js';

let server: ReturnType<typeof createDemoServer>;
let url: string;
beforeAll(async () => {
  server = createDemoServer();
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const steps = ['go to /login.html', 'type "alice@example.com" into the email field', 'click Sign in'];
const loginYaml = `name: Login\nsteps:\n  - ${steps[0]}\n  - ${steps[1]}\n  - ${steps[2]}\n  - expect: the page shows "Welcome, Alice"\n`;
const resolved = {
  version: 1,
  steps: {
    [hashStep(steps[0])]: { kind: 'navigate', url: '/login.html' },
    [hashStep(steps[1])]: { kind: 'type', target: { selector: 'css=input[name=email]' }, text: 'alice@example.com' },
    [hashStep(steps[2])]: { kind: 'click', target: { selector: 'role=button[name="Sign in"]' } },
    [hashStep('the page shows "Welcome, Alice"')]: { kind: 'textVisible', text: 'Welcome, Alice' },
  },
};

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ete-proj-'));
  await mkdir(join(dir, 'e2e', '.resolved'), { recursive: true });
  await writeFile(join(dir, 'ete.yaml'), `url: ${url}\nheal:\n  maxPerRun: 0\n`);
  await writeFile(join(dir, 'e2e', 'login.yaml'), loginYaml);
  await writeFile(join(dir, 'e2e', '.resolved', 'login.json'), JSON.stringify(resolved));
  return dir;
}

describe('ete run', () => {
  it('replays a fully resolved test with no api key and writes results', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const cwd = await project();
      const lines: string[] = [];
      const code = await runCommand({ cwd, files: [], ci: true, log: (l) => lines.push(l) });
      expect(code).toBe(0);
      const report = JSON.parse(await readFile(join(cwd, 'ete-results', 'login', 'report.json'), 'utf8'));
      expect(report.status).toBe('passed');
      expect(report.steps.map((s: { status: string }) => s.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
      expect((await stat(join(cwd, 'ete-results', 'login', 'video.webm'))).size).toBeGreaterThan(0);
      expect((await stat(join(cwd, 'ete-results', 'login', 'steps', '04.png'))).size).toBeGreaterThan(0);
      expect(lines.join('\n')).toMatch(/✓ 4\./);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('fails an unresolved step with the missing-key message and exits 1', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const cwd = await project();
      await writeFile(join(cwd, 'e2e', 'new.yaml'), 'name: New\nsteps:\n  - go to /login.html\n  - click something unknown\n');
      const code = await runCommand({ cwd, files: ['e2e/new.yaml'], ci: false, log: () => {} });
      expect(code).toBe(1);
      const report = JSON.parse(await readFile(join(cwd, 'ete-results', 'new', 'report.json'), 'utf8'));
      expect(report.steps[0].status).toBe('failed');
      expect(report.steps[0].error).toMatch(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('writes resolved.healed.json in ci mode and updates e2e/.resolved locally', async () => {
    const cwd = await project();
    const stale = { ...resolved, steps: { ...resolved.steps, [hashStep(steps[2])]: { kind: 'click', target: { selector: 'text=Nope' } } } };
    await writeFile(join(cwd, 'e2e', '.resolved', 'login.json'), JSON.stringify(stale));
    await writeFile(join(cwd, 'ete.yaml'), `url: ${url}\n`);
    const fixed = { kind: 'click', target: { selector: 'role=button[name="Sign in"]' } };
    const resolver = { resolve: async () => fixed as never };

    const ci = await runCommand({ cwd, files: [], ci: true, log: () => {}, resolver });
    expect(ci).toBe(0);
    const healed = JSON.parse(await readFile(join(cwd, 'ete-results', 'login', 'resolved.healed.json'), 'utf8'));
    expect(healed.steps[hashStep(steps[2])]).toEqual(fixed);
    expect(JSON.parse(await readFile(join(cwd, 'e2e', '.resolved', 'login.json'), 'utf8'))).toEqual(stale);

    const local = await runCommand({ cwd, files: [], ci: false, log: () => {}, resolver });
    expect(local).toBe(0);
    expect(JSON.parse(await readFile(join(cwd, 'e2e', '.resolved', 'login.json'), 'utf8')).steps[hashStep(steps[2])]).toEqual(fixed);
  });
});
