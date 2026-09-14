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
  await writeFile(join(dir, 'ete.yaml'), `url: ${url}\n`);
  await writeFile(join(dir, 'e2e', 'login.yaml'), loginYaml);
  await writeFile(join(dir, 'e2e', '.resolved', 'login.json'), JSON.stringify(resolved));
  return dir;
}

describe('ete run', () => {
  it('replays a fully resolved test with no api key and writes results', async () => {
    {
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
    }
  });

  it('fails a step with no recorded action and prints the resume command', async () => {
    const cwd = await project();
    await writeFile(join(cwd, 'e2e', 'new.yaml'), 'name: New\nsteps:\n  - go to /login.html\n  - click something unknown\n');
    const lines: string[] = [];
    const code = await runCommand({ cwd, files: ['e2e/new.yaml'], log: (l) => lines.push(l) });
    expect(code).toBe(1);
    const report = JSON.parse(await readFile(join(cwd, 'ete-results', 'new', 'report.json'), 'utf8'));
    expect(report.steps[0].status).toBe('failed');
    expect(report.steps[0].error).toMatch(/No recorded action/);
    expect(lines.join('\n')).toContain('ete session start --from e2e/new.yaml --at 1');
  });

});

describe('ete run --workers and --shard', () => {
  async function multi(): Promise<string> {
    const cwd = await project();
    for (const n of ['a', 'b', 'c', 'd']) {
      await writeFile(join(cwd, 'e2e', `${n}.yaml`), `name: ${n.toUpperCase()}\nsteps:\n  - ${steps[0]}\n  - expect: the URL ends with /login.html\n`);
      await writeFile(join(cwd, 'e2e', '.resolved', `${n}.json`), JSON.stringify({ version: 1, steps: { [hashStep(steps[0])]: { kind: 'navigate', url: '/login.html' }, [hashStep('the URL ends with /login.html')]: { kind: 'urlMatches', pattern: '/login\\.html$' } } }));
    }
    return cwd;
  }
  it('replays tests concurrently with --workers and keeps per-test output grouped', async () => {
    const cwd = await multi();
    const lines: string[] = [];
    const t = Date.now();
    const code = await runCommand({ cwd, files: [], workers: 4, log: (l) => lines.push(l) });
    if (code !== 0) console.log(lines.join('\n'));
    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toMatch(/5\/5 passed/);
    // each test's lines stay together: a header line is followed by its own steps
    const idx = out.indexOf('A (e2e/a.yaml)');
    expect(out.slice(idx, idx + 200)).toMatch(/A \(e2e\/a\.yaml\)\n\s+✓ 1\. go to \/login\.html/);
    expect(Date.now() - t).toBeLessThan(60_000);
  }, 120_000);
  it('--shard i/n selects a deterministic subset', async () => {
    const cwd = await multi();
    const seen: string[][] = [];
    for (let i = 1; i <= 2; i++) {
      const lines: string[] = [];
      expect(await runCommand({ cwd, files: [], shard: { index: i, total: 2 }, log: (l) => lines.push(l) })).toBe(0);
      seen.push(lines.filter((l) => /\(e2e\/.*\.yaml\)$/.test(l)).map((l) => l.replace(/.*\((e2e\/[^)]*)\)$/, '$1')));
    }
    expect(seen[0]!.length + seen[1]!.length).toBe(5);
    expect(new Set([...seen[0]!, ...seen[1]!]).size).toBe(5);
    expect(seen[0]).not.toEqual(seen[1]);
  }, 120_000);
});
