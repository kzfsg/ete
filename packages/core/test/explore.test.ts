import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exploreFlow } from '../src/explore.js';
import { hashStep } from '../src/cache.js';
import { mockModelReturning } from './helpers.js';
import { FakeDriver } from './fake-driver.js';

const click = { kind: 'click', target: { selector: 'role=button[name="Sign in"]' } } as const;
const nav = { kind: 'navigate', url: '/login' } as const;

async function run(payloads: unknown[], driver = new FakeDriver(), extra: Record<string, unknown> = {}) {
  const { model, calls } = mockModelReturning(payloads);
  const resultsDir = await mkdtemp(join(tmpdir(), 'ete-exp-'));
  const result = await exploreFlow({ goal: 'a user can log in', flow: 'Login', driver, model, baseUrl: 'http://fake', resultsDir, testPath: 'e2e/login/a-user-can-log-in.yaml', ...extra });
  return { ...result, calls, driver, resultsDir };
}

describe('exploreFlow', () => {
  it('turns each action into a recorded step and returns a replayable test', async () => {
    const { report, test, resolved, driver, calls } = await run([
      { nextAction: nav }, { nextAction: click }, { done: true, summary: 'logged in' },
    ]);
    expect(calls.length).toBe(3);
    expect(driver.acted).toEqual([nav, click]);
    expect(driver.stepLabels).toEqual(['go to /login', 'click "Sign in"']);
    expect(test).toEqual({ name: 'a user can log in', flow: 'Login', target: 'browser', steps: [{ kind: 'action', text: 'go to /login' }, { kind: 'action', text: 'click "Sign in"' }] });
    for (const s of test.steps) expect(resolved.steps[hashStep(s.text)]).toBeDefined();
    expect(resolved.steps[hashStep('click "Sign in"')]).toEqual(click);
    expect(report).toMatchObject({ mode: 'explore', flow: 'Login', status: 'passed', file: 'e2e/login/a-user-can-log-in.yaml' });
    expect(report.steps.map((s) => s.status)).toEqual(['passed', 'passed']);
    expect(report.steps[0].startMs).toBe(10);
    expect(report.steps[0].screenshot).toBe('steps/01.png');
    expect(driver.stopped).toBe(true);
  });

  it('checks assertions deterministically and records them as expect steps', async () => {
    const driver = new FakeDriver();
    driver.visibleTexts.add('Welcome');
    const { report, test, resolved } = await run([
      { nextAssertion: { kind: 'textVisible', text: 'Welcome' } }, { done: true },
    ], driver);
    expect(driver.checked).toEqual([{ kind: 'textVisible', text: 'Welcome' }]);
    expect(test.steps).toEqual([{ kind: 'expect', text: 'the page shows "Welcome"' }]);
    expect(resolved.steps[hashStep('the page shows "Welcome"')]).toEqual({ kind: 'textVisible', text: 'Welcome' });
    expect(report.status).toBe('passed');
  });

  it('marks a failed assertion, keeps exploring, and fails the run', async () => {
    const { report, calls, driver } = await run([
      { nextAssertion: { kind: 'textVisible', text: 'Nope' } }, { nextAction: click }, { done: true },
    ]);
    expect(calls.length).toBe(3);
    expect(driver.acted).toEqual([click]);
    expect(report.steps.map((s) => s.status)).toEqual(['failed', 'passed']);
    expect(report.steps[0].error).toMatch(/assertion/i);
    expect(report.status).toBe('failed');
    expect(JSON.stringify(calls[1])).toContain('FAILED');
  });

  it('records a failed action, tells the model, and continues', async () => {
    const driver = new FakeDriver();
    driver.failOn.add('text=Nope');
    const { report, calls } = await run([
      { nextAction: { kind: 'click', target: { selector: 'text=Nope' } } }, { nextAction: click }, { done: true },
    ], driver);
    expect(report.steps.map((s) => s.status)).toEqual(['failed', 'passed']);
    expect(JSON.stringify(calls[1])).toContain('Timeout');
    expect(report.status).toBe('failed');
  });

  it('stops at maxActions', async () => {
    const { calls, report } = await run([{ nextAction: click }], new FakeDriver(), { maxActions: 4 });
    expect(calls.length).toBe(4);
    expect(report.steps.length).toBe(4);
  });

  it('carries anomalies into the report', async () => {
    const driver = new FakeDriver();
    driver.anomalyQueue = [[{ t: 3, kind: 'http-error', message: 'HTTP 500 GET /api' }]];
    const { report } = await run([{ nextAction: nav }, { done: true }], driver);
    expect(report.steps[0].anomalies).toEqual([{ t: 3, kind: 'http-error', message: 'HTTP 500 GET /api' }]);
    expect(report.anomalyCount).toBe(1);
    expect(report.status).toBe('passed');
  });
});
