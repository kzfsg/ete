import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { createDemoServer } from '../../../fixtures/demo-app/server.mjs';
import { parseAct, parseExpect } from '../src/commands/session.js';

const exec = promisify(execFile);
const BIN = resolve(__dirname, '../dist/index.js');

let server: ReturnType<typeof createDemoServer>;
let url: string;
beforeAll(async () => {
  server = createDemoServer();
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('parseAct / parseExpect', () => {
  it('parses action argv into entries', () => {
    expect(parseAct(['goto', '/login'])).toEqual({ kind: 'navigate', url: '/login' });
    expect(parseAct(['click', 'role=button[name="Sign in"]'])).toEqual({ kind: 'click', target: { selector: 'role=button[name="Sign in"]' } });
    expect(parseAct(['type', 'label=Email', 'a@b.c'])).toEqual({ kind: 'type', target: { selector: 'label=Email' }, text: 'a@b.c' });
    expect(parseAct(['press', 'Enter'])).toEqual({ kind: 'press', key: 'Enter' });
    expect(parseAct(['scroll', '300'])).toEqual({ kind: 'scroll', dy: 300 });
    expect(parseAct(['scroll', '-100', 'css=main'])).toEqual({ kind: 'scroll', dy: -100, target: { selector: 'css=main' } });
    expect(parseAct(['wait', '250'])).toEqual({ kind: 'wait', ms: 250 });
    expect(parseAct(['click', '120,40'])).toEqual({ kind: 'click', target: { point: { x: 120, y: 40 } } });
    expect(() => parseAct(['dance'])).toThrow(/unknown action/i);
    expect(() => parseAct(['type', 'label=Email'])).toThrow(/usage/i);
  });
  it('parses assertion argv into entries', () => {
    expect(parseExpect(['text', 'Welcome, Alice'])).toEqual({ kind: 'textVisible', text: 'Welcome, Alice' });
    expect(parseExpect(['visible', 'role=link[name="Log out"]'])).toEqual({ kind: 'elementVisible', target: { selector: 'role=link[name="Log out"]' } });
    expect(parseExpect(['url', '/dashboard'])).toEqual({ kind: 'urlMatches', pattern: '/dashboard' });
    expect(() => parseExpect(['smells', 'nice'])).toThrow(/unknown assertion/i);
  });
});

describe('ete session (daemon)', () => {
  it('start → act → status → save through the real CLI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ete-daemon-'));
    await writeFile(join(cwd, 'ete.yaml'), `url: ${url}\n`);
    const ete = (...args: string[]) => exec(process.execPath, [BIN, 'session', ...args], { cwd });

    const start = await ete('start', '--name', 'Home links to login', '--flow', 'Nav');
    expect(start.stdout).toMatch(/Session started/);
    expect(start.stdout).toMatch(/Log in/);   // observation printed
    expect((await stat(join(cwd, 'ete-results/.session/server.json'))).isFile()).toBe(true);

    await expect(ete('start', '--name', 'again')).rejects.toThrow(/already active/);

    const act = await ete('act', 'click', 'role=link[name="Log in"]');
    expect(act.stdout).toMatch(/✓ recorded step 2/);
    expect(act.stdout).toMatch(/Sign in/);
    const bad = await ete('act', 'click', 'text=Nope').catch((e) => e);
    expect(bad.code).toBe(1);
    expect(String(bad.stdout + bad.stderr)).toMatch(/not recorded/);
    const exp = await ete('expect', 'text', 'Sign in');
    expect(exp.stdout).toMatch(/✓ recorded step 3/);

    const status = await ete('status');
    expect(status.stdout).toMatch(/1\. go to \//);
    expect(status.stdout).toMatch(/2\. click "Log in"/);
    expect(status.stdout).toMatch(/3\. expect: the page shows "Sign in"/);

    const save = await ete('save');
    expect(save.stdout).toMatch(/Saved e2e\/nav\/home-links-to-login\.yaml/);
    await expect(stat(join(cwd, 'ete-results/.session/server.json'))).rejects.toThrow();
    expect(await readFile(join(cwd, 'e2e/nav/home-links-to-login.yaml'), 'utf8')).toContain('- click "Log in"');

    const run = await exec(process.execPath, [BIN, 'run'], { cwd });
    expect(run.stdout).toMatch(/1\/1 passed/);
  }, 120_000);

  it('abort discards, and a stale server.json is cleaned up', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ete-daemon-'));
    await writeFile(join(cwd, 'ete.yaml'), `url: ${url}\n`);
    const ete = (...args: string[]) => exec(process.execPath, [BIN, 'session', ...args], { cwd });
    await ete('start', '--name', 'Throwaway');
    const abort = await ete('abort');
    expect(abort.stdout).toMatch(/aborted/i);
    await expect(stat(join(cwd, 'e2e'))).rejects.toThrow();
    // stale file with a dead pid must not block a new session
    await writeFile(join(cwd, 'ete-results/.session/server.json'), JSON.stringify({ port: 1, token: 'x', pid: 999999999 }));
    const again = await ete('start', '--name', 'Fresh');
    expect(again.stdout).toMatch(/Session started/);
    await ete('abort');
  }, 120_000);
});
