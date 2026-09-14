import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createDemoServer } from '../../../fixtures/demo-app/server.mjs';
import { createBrowserDriver } from '../src/index.js';

let server: ReturnType<typeof createDemoServer>;
let baseUrl: string;

beforeAll(async () => {
  server = createDemoServer();
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('BrowserDriver', () => {
  it('drives the login flow, observes, checks, screenshots and records', async () => {
    const resultsDir = await mkdtemp(join(tmpdir(), 'ete-br-'));
    const d = createBrowserDriver();
    await d.start({ baseUrl, resultsDir });

    await d.act({ kind: 'navigate', url: '/login.html' });
    const obs = await d.observe();
    expect(obs.screenshotPng.subarray(1, 4).toString()).toBe('PNG');
    expect(obs.a11yTree).toContain('Sign in');
    expect(obs.url).toBe(`${baseUrl}/login.html`);

    await d.act({ kind: 'type', target: { selector: 'css=input[name=email]' }, text: 'alice@example.com' });
    await d.act({ kind: 'type', target: { selector: 'placeholder=Password' }, text: 'hunter2' });
    await d.act({ kind: 'click', target: { selector: 'role=button[name="Sign in"]' } });

    expect(await d.check({ kind: 'textVisible', text: 'Welcome, Alice' })).toBe(true);
    expect(await d.check({ kind: 'urlMatches', pattern: '/dashboard\\.html$' })).toBe(true);
    expect(await d.check({ kind: 'elementVisible', target: { selector: 'role=link[name="Log out"]' } })).toBe(true);
    expect(await d.check({ kind: 'textVisible', text: 'Definitely not here' })).toBe(false);

    await d.screenshot(join(resultsDir, 'shot.png'));
    expect((await stat(join(resultsDir, 'shot.png'))).size).toBeGreaterThan(0);

    const rec = await d.stop();
    expect(rec.videoPath).toBe('video.webm');
    expect(rec.tracePath).toBe('trace.zip');
    expect((await stat(join(resultsDir, 'video.webm'))).size).toBeGreaterThan(0);
    expect((await stat(join(resultsDir, 'trace.zip'))).size).toBeGreaterThan(0);
  });

  it('rejects quickly when a target does not exist', async () => {
    const resultsDir = await mkdtemp(join(tmpdir(), 'ete-br-'));
    const d = createBrowserDriver({ actionTimeoutMs: 1000 });
    await d.start({ baseUrl, resultsDir });
    await d.act({ kind: 'navigate', url: '/login.html' });
    await expect(d.act({ kind: 'click', target: { selector: 'text=DoesNotExist' } })).rejects.toThrow(/Timeout|timeout/);
    await d.stop();
  });

  it('uses separate navigation, action, and assertion timeouts', async () => {
    const resultsDir = await mkdtemp(join(tmpdir(), 'ete-br-'));
    const d = createBrowserDriver({ navigationTimeoutMs: 100, actionTimeoutMs: 100, checkTimeoutMs: 100 });
    await d.start({ baseUrl, resultsDir });
    // An unroutable address must fail within the navigation timeout, not hang.
    const t = Date.now();
    await expect(d.act({ kind: 'navigate', url: 'http://10.255.255.1/' })).rejects.toThrow(/Timeout|timeout|net::/);
    expect(Date.now() - t).toBeLessThan(5000);
    await d.stop();
  });

  it('supports point targets and key presses', async () => {
    const resultsDir = await mkdtemp(join(tmpdir(), 'ete-br-'));
    const d = createBrowserDriver();
    await d.start({ baseUrl, resultsDir });
    await d.act({ kind: 'navigate', url: '/login.html' });
    await d.act({ kind: 'click', target: { selector: 'css=input[name=email]' } });
    await d.act({ kind: 'type', target: { selector: 'css=input[name=email]' }, text: 'bob@example.com' });
    await d.act({ kind: 'press', key: 'Enter' });
    expect(await d.check({ kind: 'textVisible', text: 'Invalid credentials' })).toBe(true);
    await d.act({ kind: 'scroll', dy: 100 });
    await d.act({ kind: 'wait', ms: 10 });
    await d.act({ kind: 'click', target: { point: { x: 5, y: 5 } } });
    await d.stop();
  });
});
