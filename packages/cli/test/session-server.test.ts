import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { hashStep } from '@ete/core';
import { createDemoServer } from '../../../fixtures/demo-app/server.mjs';
import { startSessionServer, type SessionServer } from '../src/session/server.js';
import { runCommand } from '../src/commands/run.js';

let server: ReturnType<typeof createDemoServer>;
let url: string;
beforeAll(async () => {
  server = createDemoServer();
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function project(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'ete-sess-'));
  await writeFile(join(cwd, 'ete.yaml'), `url: ${url}\n`);
  return cwd;
}

async function call(s: SessionServer, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    method: body === undefined && path === '/status' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('session server', () => {
  it('records an authoring session and the saved test replays', async () => {
    const cwd = await project();
    const s = await startSessionServer({ cwd, name: 'A user can log in', flow: 'Login' });
    try {
      expect((await call(s, '/status')).json).toMatchObject({ name: 'A user can log in', flow: 'Login', testPath: 'e2e/login/a-user-can-log-in.yaml', steps: [{ index: 1, text: 'go to /' }] });

      const obs = await call(s, '/observe');
      expect(obs.json.observation.url).toBe(`${url}/`);
      expect(obs.json.observation.a11yTree).toContain('Log in');
      expect(obs.json.observation.screenshot).toMatch(/\.session[\\/]observe\.png$/);

      const nav = await call(s, '/act', { entry: { kind: 'navigate', url: '/login.html' } });
      expect(nav.json.result).toMatchObject({ ok: true, recorded: true, step: { index: 2, text: 'go to /login.html' } });
      expect(nav.json.observation.a11yTree).toContain('Sign in');

      const bad = await call(s, '/act', { entry: { kind: 'click', target: { selector: 'text=Nope' } } });
      expect(bad.json.result).toMatchObject({ ok: false, recorded: false });
      expect(bad.json.result.error).toMatch(/Timeout/);

      await call(s, '/act', { entry: { kind: 'type', target: { selector: 'css=input[name=email]' }, text: 'alice@example.com' }, as: 'type "alice@example.com" into the email field' });
      await call(s, '/act', { entry: { kind: 'click', target: { selector: 'role=button[name="Sign in"]' } } });
      const exp = await call(s, '/expect', { assertion: { kind: 'textVisible', text: 'Welcome, Alice' } });
      expect(exp.json.result).toMatchObject({ ok: true, recorded: true, step: { index: 5, kind: 'expect' } });
      const miss = await call(s, '/expect', { assertion: { kind: 'textVisible', text: 'Absent' } });
      expect(miss.json.result).toMatchObject({ ok: false, recorded: false });
      expect((await call(s, '/status')).json.steps.length).toBe(5);

      const saved = await call(s, '/save', {});
      expect(saved.json).toMatchObject({ testPath: 'e2e/login/a-user-can-log-in.yaml', report: { status: 'passed', mode: 'session' } });
      const yaml = await readFile(join(cwd, 'e2e/login/a-user-can-log-in.yaml'), 'utf8');
      expect(yaml).toContain('flow: Login');
      expect(yaml).toContain('- type "alice@example.com" into the email field');
      const resolved = JSON.parse(await readFile(join(cwd, 'e2e/.resolved/login/a-user-can-log-in.json'), 'utf8'));
      expect(resolved.steps[hashStep('the page shows "Welcome, Alice"')]).toEqual({ kind: 'textVisible', text: 'Welcome, Alice' });
      const report = JSON.parse(await readFile(join(cwd, 'ete-results/a-user-can-log-in/report.json'), 'utf8'));
      expect(report.recording.filmstripPath).toBe('filmstrip.png');
      expect(report.steps.length).toBe(5);
    } finally {
      await s.close();
    }
    const lines: string[] = [];
    expect(await runCommand({ cwd, files: [], log: (l) => lines.push(l) })).toBe(0);
    expect(lines.join('\n')).toMatch(/## Login/);
  }, 90_000);

  it('rejects requests without the token', async () => {
    const cwd = await project();
    const s = await startSessionServer({ cwd, name: 'x' });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/status`);
      expect(res.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('resumes from an existing test at a step, replays the prefix, and merges on save', async () => {
    const cwd = await project();
    await mkdir(join(cwd, 'e2e/.resolved/login'), { recursive: true });
    const steps = ['go to /login.html', 'type "alice@example.com" into the email field', 'click the login button', 'the page shows "Welcome, Alice"'];
    await mkdir(join(cwd, 'e2e/login'), { recursive: true });
    await writeFile(join(cwd, 'e2e/login/sign-in.yaml'), `name: Sign in\nflow: Login\nsteps:\n  - ${steps[0]}\n  - ${steps[1]}\n  - ${steps[2]}\n  - expect: ${steps[3]}\n`);
    await writeFile(join(cwd, 'e2e/.resolved/login/sign-in.json'), JSON.stringify({ version: 1, steps: {
      [hashStep(steps[0])]: { kind: 'navigate', url: '/login.html' },
      [hashStep(steps[1])]: { kind: 'type', target: { selector: 'css=input[name=email]' }, text: 'alice@example.com' },
      [hashStep(steps[2])]: { kind: 'click', target: { selector: 'text=Log In Now' } },   // stale
      [hashStep(steps[3])]: { kind: 'textVisible', text: 'Welcome, Alice' },
    } }));
    const s = await startSessionServer({ cwd, from: 'e2e/login/sign-in.yaml', at: 3 });
    try {
      const st = (await call(s, '/status')).json;
      expect(st.steps.map((x: { text: string }) => x.text)).toEqual(steps.slice(0, 2));
      expect(st.observation.a11yTree).toContain('Sign in');
      await call(s, '/act', { entry: { kind: 'click', target: { selector: 'role=button[name="Sign in"]' } }, as: 'click the login button' });
      await call(s, '/expect', { assertion: { kind: 'textVisible', text: 'Welcome, Alice' } });
      const saved = await call(s, '/save', {});
      expect(saved.json.testPath).toBe('e2e/login/sign-in.yaml');
    } finally {
      await s.close();
    }
    const yaml = await readFile(join(cwd, 'e2e/login/sign-in.yaml'), 'utf8');
    expect(yaml).toBe(`name: Sign in\nflow: Login\nsteps:\n  - ${steps[0]}\n  - ${steps[1]}\n  - click the login button\n  - expect: the page shows "Welcome, Alice"\n`);
    const resolved = JSON.parse(await readFile(join(cwd, 'e2e/.resolved/login/sign-in.json'), 'utf8'));
    expect(resolved.steps[hashStep('click the login button')]).toEqual({ kind: 'click', target: { selector: 'role=button[name="Sign in"]' } });
    expect(await runCommand({ cwd, files: ['e2e/login/sign-in.yaml'], log: () => {} })).toBe(0);
  }, 90_000);

  it('fails to start when the prefix cannot be replayed', async () => {
    const cwd = await project();
    await mkdir(join(cwd, 'e2e/.resolved'), { recursive: true });
    await writeFile(join(cwd, 'e2e/x.yaml'), 'name: X\nsteps:\n  - go to /login.html\n  - click nothing\n  - press Enter\n');
    await writeFile(join(cwd, 'e2e/.resolved/x.json'), JSON.stringify({ version: 1, steps: {
      [hashStep('go to /login.html')]: { kind: 'navigate', url: '/login.html' },
      [hashStep('click nothing')]: { kind: 'click', target: { selector: 'text=Nothing' } },
    } }));
    await expect(startSessionServer({ cwd, from: 'e2e/x.yaml', at: 3 })).rejects.toThrow(/prefix step 2 "click nothing"/);
  }, 60_000);
});
