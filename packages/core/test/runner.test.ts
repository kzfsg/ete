import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTest, resumeHint, NO_RECORDED_ACTION, type RunOptions } from '../src/runner.js';
import { hashStep, emptyResolved, type ResolvedFile } from '../src/cache.js';
import type { ResolvedEntry, TestFile } from '../src/schema.js';
import { FakeDriver } from './fake-driver.js';

const clickSignIn: ResolvedEntry = { kind: 'click', target: { selector: 'role=button[name="Sign in"]' } };
const welcome: ResolvedEntry = { kind: 'textVisible', text: 'Welcome' };

function test(steps: TestFile['steps']): TestFile { return { name: 'T', target: 'browser', steps }; }
function resolvedWith(entries: Record<string, ResolvedEntry>): ResolvedFile {
  const f = emptyResolved();
  for (const [text, e] of Object.entries(entries)) f.steps[hashStep(text)] = e;
  return f;
}
async function opts(partial: Partial<RunOptions> & Pick<RunOptions, 'test'>): Promise<RunOptions> {
  return {
    testPath: 'e2e/t.yaml',
    driver: new FakeDriver(),
    resolved: emptyResolved(),
    baseUrl: 'http://fake',
    resultsDir: await mkdtemp(join(tmpdir(), 'ete-run-')),
    ...partial,
  };
}

describe('runTest', () => {
  it('replays cached actions and assertions', async () => {
    const driver = new FakeDriver();
    driver.visibleTexts.add('Welcome');
    const o = await opts({ test: test([{ kind: 'action', text: 'click Sign in' }, { kind: 'expect', text: 'shows welcome' }]), driver, resolved: resolvedWith({ 'click Sign in': clickSignIn, 'shows welcome': welcome }) });
    const { report } = await runTest(o);
    expect(driver.acted).toEqual([clickSignIn]);
    expect(driver.checked).toEqual([welcome]);
    expect(report.steps.map((s) => s.status)).toEqual(['passed', 'passed']);
    expect(report.status).toBe('passed');
    expect(report.mode).toBe('replay');
  });

  it('fails a step with no recorded action and points at the resume command', async () => {
    const lines: string[] = [];
    const o = await opts({ testPath: 'e2e/login/a.yaml', test: test([{ kind: 'action', text: 'new step' }, { kind: 'action', text: 'never' }]), log: (l) => lines.push(l) });
    const { report } = await runTest(o);
    expect(report.steps[0].status).toBe('failed');
    expect(report.steps[0].error).toContain(NO_RECORDED_ACTION);
    expect(report.steps[1].status).toBe('skipped');
    expect(lines.join('\n')).toContain(resumeHint('e2e/login/a.yaml', 1));
    expect(resumeHint('e2e/login/a.yaml', 1)).toBe('ete session start --from e2e/login/a.yaml --at 1');
  });

  it('fails when a cached action throws, skips the rest, and never retries', async () => {
    const driver = new FakeDriver();
    driver.failOn.add('text=Login');
    const stale: ResolvedEntry = { kind: 'click', target: { selector: 'text=Login' } };
    const o = await opts({ test: test([{ kind: 'action', text: 'click Sign in' }, { kind: 'action', text: 'never' }]), driver, resolved: resolvedWith({ 'click Sign in': stale, never: clickSignIn }) });
    const { report } = await runTest(o);
    expect(driver.acted.length).toBe(1);
    expect(report.steps[0]).toMatchObject({ status: 'failed', entry: stale });
    expect(report.steps[0].error).toMatch(/Timeout/);
    expect(report.steps[1].status).toBe('skipped');
    expect(report.status).toBe('failed');
  });

  it('fails a false assertion without consulting anything', async () => {
    const driver = new FakeDriver();
    const o = await opts({ test: test([{ kind: 'expect', text: 'shows welcome' }]), driver, resolved: resolvedWith({ 'shows welcome': welcome }) });
    const { report } = await runTest(o);
    expect(driver.checked.length).toBe(1);
    expect(report.steps[0].status).toBe('failed');
    expect(report.steps[0].error).toMatch(/Assertion failed/);
  });

  it('takes a numbered screenshot after each executed step and stops the driver', async () => {
    const driver = new FakeDriver();
    driver.visibleTexts.add('Welcome');
    const o = await opts({ test: test([{ kind: 'action', text: 'click Sign in' }, { kind: 'expect', text: 'shows welcome' }]), driver, resolved: resolvedWith({ 'click Sign in': clickSignIn, 'shows welcome': welcome }) });
    const { report } = await runTest(o);
    expect(driver.screenshots).toEqual([join(o.resultsDir, 'steps', '01.png'), join(o.resultsDir, 'steps', '02.png')]);
    expect(report.steps.map((s) => s.screenshot)).toEqual(['steps/01.png', 'steps/02.png']);
    expect(driver.stopped).toBe(true);
    expect(report.recording).toEqual({ videoPath: 'video.webm', tracePath: 'trace.zip' });
  });

  it('marks remaining steps skipped and still stops the driver when it crashes', async () => {
    const driver = new FakeDriver();
    driver.crash = new Error('browser closed');
    const o = await opts({ test: test([{ kind: 'action', text: 'click Sign in' }, { kind: 'action', text: 'next' }]), driver, resolved: resolvedWith({ 'click Sign in': clickSignIn, next: clickSignIn }) });
    const { report } = await runTest(o);
    expect(report.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(driver.stopped).toBe(true);
  });
});

describe('runTest telemetry', () => {
  it('records start/end and anomalies per executed step, none for skipped', async () => {
    const driver = new FakeDriver();
    driver.failOn.add('text=Nope');
    driver.anomalyQueue = [[{ t: 5, kind: 'console-error', message: 'boom' }], []];
    const stale: ResolvedEntry = { kind: 'click', target: { selector: 'text=Nope' } };
    const o = await opts({
      test: test([{ kind: 'action', text: 'click Sign in' }, { kind: 'action', text: 'then fail' }, { kind: 'action', text: 'never' }]),
      driver, resolved: resolvedWith({ 'click Sign in': clickSignIn, 'then fail': stale, never: clickSignIn }),
    });
    const { report } = await runTest(o);
    expect(driver.stepLabels).toEqual(['click Sign in', 'then fail']);
    expect(report.steps[0]).toMatchObject({ status: 'passed', startMs: 10, endMs: 110, anomalies: [{ kind: 'console-error', message: 'boom', t: 5 }] });
    expect(report.steps[1]).toMatchObject({ status: 'failed', startMs: 120, endMs: 220, anomalies: [] });
    expect(report.steps[2].startMs).toBeUndefined();
    expect(report.anomalyCount).toBe(1);
    expect(report.flow).toBe('General');
  });
  it('derives the flow from the path or the declared field', async () => {
    const o = await opts({ testPath: 'e2e/checkout/pay.yaml', test: test([{ kind: 'action', text: 'click Sign in' }]), resolved: resolvedWith({ 'click Sign in': clickSignIn }) });
    expect((await runTest(o)).report.flow).toBe('Checkout');
    const o2 = await opts({ testPath: 'e2e/checkout/pay.yaml', test: { ...test([{ kind: 'action', text: 'click Sign in' }]), flow: 'Buying' }, resolved: resolvedWith({ 'click Sign in': clickSignIn }) });
    expect((await runTest(o2)).report.flow).toBe('Buying');
  });
});
