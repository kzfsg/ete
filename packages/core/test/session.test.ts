import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from '../src/session.js';
import { hashStep } from '../src/cache.js';
import type { ResolvedAction, ResolvedAssertion } from '../src/schema.js';
import { FakeDriver } from './fake-driver.js';

const nav: ResolvedAction = { kind: 'navigate', url: '/login' };
const click: ResolvedAction = { kind: 'click', target: { selector: 'role=button[name="Sign in"]' } };
const welcome: ResolvedAssertion = { kind: 'textVisible', text: 'Welcome' };

async function recorder(driver = new FakeDriver(), extra: Record<string, unknown> = {}) {
  const resultsDir = await mkdtemp(join(tmpdir(), 'ete-rec-'));
  const r = new Recorder({ driver, name: 'a user can log in', flow: 'Login', testPath: 'e2e/login/a-user-can-log-in.yaml', baseUrl: 'http://fake', resultsDir, ...extra });
  await r.start();
  return { r, driver, resultsDir };
}

describe('Recorder', () => {
  it('records successful actions and assertions as replayable steps', async () => {
    const { r, driver } = await recorder();
    driver.visibleTexts.add('Welcome');
    expect(await r.act(nav)).toMatchObject({ ok: true, recorded: true, step: { index: 1, text: 'go to /login' } });
    expect(await r.act(click, { as: 'click the sign in button' })).toMatchObject({ ok: true, recorded: true, step: { index: 2, text: 'click the sign in button' } });
    expect(await r.expect(welcome)).toMatchObject({ ok: true, recorded: true, step: { index: 3, text: 'the page shows "Welcome"' } });
    expect(driver.stepLabels).toEqual(['go to /login', 'click the sign in button', 'the page shows "Welcome"']);
    const { report, test, resolved } = await r.finish();
    expect(test).toEqual({ name: 'a user can log in', flow: 'Login', target: 'browser', steps: [
      { kind: 'action', text: 'go to /login' }, { kind: 'action', text: 'click the sign in button' }, { kind: 'expect', text: 'the page shows "Welcome"' },
    ] });
    expect(resolved.steps[hashStep('click the sign in button')]).toEqual(click);
    expect(resolved.steps[hashStep('the page shows "Welcome"')]).toEqual(welcome);
    expect(report).toMatchObject({ mode: 'session', flow: 'Login', status: 'passed', file: 'e2e/login/a-user-can-log-in.yaml', anomalyCount: 0 });
    expect(report.steps.map((s) => s.screenshot)).toEqual(['steps/01.png', 'steps/02.png', 'steps/03.png']);
    expect(report.steps[0].startMs).toBe(10);
    expect(driver.stopped).toBe(true);
  });

  it('does not record a failed action, returns the error, and keeps going', async () => {
    const { r, driver } = await recorder();
    driver.failOn.add('text=Nope');
    const res = await r.act({ kind: 'click', target: { selector: 'text=Nope' } });
    expect(res.ok).toBe(false);
    expect(res.recorded).toBe(false);
    expect(res.error).toMatch(/Timeout/);
    expect(await r.act(click)).toMatchObject({ ok: true, step: { index: 1 } });
    expect(r.steps().length).toBe(1);
    expect(driver.screenshots.length).toBe(1);
  });

  it('does not record a failed assertion unless asked to', async () => {
    const { r } = await recorder();
    expect(await r.expect(welcome)).toMatchObject({ ok: false, recorded: false });
    expect(r.steps().length).toBe(0);
    expect(await r.expect(welcome, { record: true })).toMatchObject({ ok: false, recorded: true, step: { index: 1, status: 'failed' } });
    const { report } = await r.finish();
    expect(report.status).toBe('failed');
    expect(report.steps[0].error).toMatch(/Assertion failed/);
  });

  it('undo drops the last recorded step', async () => {
    const { r } = await recorder();
    await r.act(nav);
    await r.act(click);
    expect(r.undo()?.text).toBe('click "Sign in"');
    expect(r.steps().map((s) => s.text)).toEqual(['go to /login']);
    expect(r.undo()?.text).toBe('go to /login');
    expect(r.undo()).toBeUndefined();
  });

  it('carries anomalies and reports them without failing', async () => {
    const driver = new FakeDriver();
    driver.anomalyQueue = [[{ t: 3, kind: 'http-error', message: 'HTTP 500 GET /api' }]];
    const { r } = await recorder(driver);
    const res = await r.act(nav);
    expect(res.telemetry?.anomalies).toEqual([{ t: 3, kind: 'http-error', message: 'HTTP 500 GET /api' }]);
    const { report } = await r.finish();
    expect(report.anomalyCount).toBe(1);
    expect(report.status).toBe('passed');
  });

  it('resumes from a prefix: replays it, then appends new steps and merges on finish', async () => {
    const driver = new FakeDriver();
    const { r } = await recorder(driver, {
      prefix: { steps: [{ kind: 'action', text: 'go to /login' }, { kind: 'action', text: 'type email' }], entries: [nav, { kind: 'type', target: { selector: 'css=input' }, text: 'a@b.c' }] },
    });
    expect(driver.acted.length).toBe(2);
    expect(driver.stepLabels).toEqual(['go to /login', 'type email']);
    expect(r.steps().length).toBe(2);
    await r.act(click);
    expect(r.steps().map((s) => s.index)).toEqual([1, 2, 3]);
    const { test, resolved, report } = await r.finish();
    expect(test.steps.map((s) => s.text)).toEqual(['go to /login', 'type email', 'click "Sign in"']);
    expect(Object.keys(resolved.steps).length).toBe(3);
    expect(report.steps.length).toBe(3);
  });

  it('fails to start when a prefix step cannot be replayed', async () => {
    const driver = new FakeDriver();
    driver.failOn.add('text=Nope');
    const resultsDir = await mkdtemp(join(tmpdir(), 'ete-rec-'));
    const r = new Recorder({ driver, name: 'x', testPath: 'e2e/x.yaml', baseUrl: 'http://fake', resultsDir,
      prefix: { steps: [{ kind: 'action', text: 'bad' }], entries: [{ kind: 'click', target: { selector: 'text=Nope' } }] } });
    await expect(r.start()).rejects.toThrow(/prefix step 1.*bad.*Timeout/s);
    expect(driver.stopped).toBe(true);
  });

  it('abort stops the driver without producing a test', async () => {
    const { r, driver } = await recorder();
    await r.act(nav);
    await r.abort();
    expect(driver.stopped).toBe(true);
  });
});
