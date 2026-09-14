import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTest, type RunOptions } from '../src/runner.js';
import { createFakeResolver, type ResolveInput } from '../src/resolver.js';
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
    resolver: createFakeResolver({}),
    resolved: emptyResolved(),
    baseUrl: 'http://fake',
    resultsDir: await mkdtemp(join(tmpdir(), 'ete-run-')),
    heal: { maxPerRun: 5, maxPerStep: 2 },
    ci: false,
    ...partial,
  };
}

describe('runTest', () => {
  it('resolves a cache miss, runs it, and stores the entry', async () => {
    const driver = new FakeDriver();
    let resolverCalls = 0;
    const resolver = createFakeResolver((i: ResolveInput) => { resolverCalls++; return clickSignIn; });
    const o = await opts({ test: test([{ kind: 'action', text: 'click Sign in' }]), driver, resolver });
    const { report, resolved } = await runTest(o);
    expect(resolverCalls).toBe(1);
    expect(report.steps[0].status).toBe('resolved');
    expect(driver.acted).toEqual([clickSignIn]);
    expect(resolved.steps[hashStep('click Sign in')]).toEqual(clickSignIn);
    expect(report.status).toBe('passed');
  });

  it('runs a cache hit without calling the resolver', async () => {
    const driver = new FakeDriver();
    let resolverCalls = 0;
    const resolver = createFakeResolver(() => { resolverCalls++; return clickSignIn; });
    const o = await opts({ test: test([{ kind: 'action', text: 'click Sign in' }]), driver, resolver, resolved: resolvedWith({ 'click Sign in': clickSignIn }) });
    const { report } = await runTest(o);
    expect(resolverCalls).toBe(0);
    expect(report.steps[0].status).toBe('passed');
  });

  it('heals when a cached action throws', async () => {
    const driver = new FakeDriver();
    const stale: ResolvedEntry = { kind: 'click', target: { selector: 'text=Login' } };
    driver.failOn.add('text=Login');
    const seen: ResolveInput[] = [];
    const resolver = createFakeResolver((i) => { seen.push(i); return clickSignIn; });
    const o = await opts({ test: test([{ kind: 'action', text: 'click Sign in' }]), driver, resolver, resolved: resolvedWith({ 'click Sign in': stale }) });
    const { report, resolved, healed } = await runTest(o);
    expect(seen[0].previous?.entry).toEqual(stale);
    expect(seen[0].previous?.error).toMatch(/Timeout/);
    expect(driver.acted).toEqual([stale, clickSignIn]);
    expect(report.steps[0].status).toBe('healed');
    expect(report.steps[0].healedFrom).toEqual(stale);
    expect(resolved.steps[hashStep('click Sign in')]).toEqual(clickSignIn);
    expect(healed.steps[hashStep('click Sign in')]).toEqual(clickSignIn);
    expect(report.status).toBe('passed');
  });

  it('fails and skips the rest when the heal budget is exhausted', async () => {
    const driver = new FakeDriver();
    driver.failOn.add('text=Login');
    const stale: ResolvedEntry = { kind: 'click', target: { selector: 'text=Login' } };
    let resolverCalls = 0;
    const resolver = createFakeResolver(() => { resolverCalls++; return clickSignIn; });
    const o = await opts({
      test: test([{ kind: 'action', text: 'click Sign in' }, { kind: 'action', text: 'never' }]),
      driver, resolver, resolved: resolvedWith({ 'click Sign in': stale }), heal: { maxPerRun: 0, maxPerStep: 2 },
    });
    const { report } = await runTest(o);
    expect(resolverCalls).toBe(0);
    expect(report.steps[0].status).toBe('failed');
    expect(report.steps[0].error).toMatch(/Timeout/);
    expect(report.steps[1].status).toBe('skipped');
    expect(report.status).toBe('failed');
  });

  it('fails when the healed action also throws', async () => {
    const driver = new FakeDriver();
    driver.failOn.add('text=Login');
    driver.failOn.add('role=button[name="Sign in"]');
    const stale: ResolvedEntry = { kind: 'click', target: { selector: 'text=Login' } };
    const resolver = createFakeResolver(() => clickSignIn);
    const o = await opts({ test: test([{ kind: 'action', text: 'click Sign in' }]), driver, resolver, resolved: resolvedWith({ 'click Sign in': stale }), heal: { maxPerRun: 5, maxPerStep: 1 } });
    const { report } = await runTest(o);
    expect(report.steps[0].status).toBe('failed');
    expect(driver.acted.length).toBe(2);
  });

  it('re-resolves a failing assertion once, then fails if still false', async () => {
    const driver = new FakeDriver();
    let resolverCalls = 0;
    const resolver = createFakeResolver(() => { resolverCalls++; return { kind: 'textVisible', text: 'Welcome back' }; });
    const o = await opts({ test: test([{ kind: 'expect', text: 'shows welcome' }]), driver, resolver, resolved: resolvedWith({ 'shows welcome': welcome }) });
    const { report } = await runTest(o);
    expect(resolverCalls).toBe(1);
    expect(driver.checked.length).toBe(2);
    expect(driver.acted.length).toBe(0);
    expect(report.steps[0].status).toBe('failed');
    expect(report.steps[0].error).toMatch(/assertion/i);
  });

  it('passes a re-resolved assertion that then holds', async () => {
    const driver = new FakeDriver();
    driver.visibleTexts.add('Welcome back');
    const resolver = createFakeResolver(() => ({ kind: 'textVisible', text: 'Welcome back' }));
    const o = await opts({ test: test([{ kind: 'expect', text: 'shows welcome' }]), driver, resolver, resolved: resolvedWith({ 'shows welcome': welcome }) });
    const { report } = await runTest(o);
    expect(report.steps[0].status).toBe('healed');
  });

  it('takes a numbered screenshot after each executed step and stops the driver', async () => {
    const driver = new FakeDriver();
    driver.visibleTexts.add('Welcome');
    const o = await opts({
      test: test([{ kind: 'action', text: 'click Sign in' }, { kind: 'expect', text: 'shows welcome' }]),
      driver, resolved: resolvedWith({ 'click Sign in': clickSignIn, 'shows welcome': welcome }),
    });
    const { report } = await runTest(o);
    expect(driver.screenshots).toEqual([join(o.resultsDir, 'steps', '01.png'), join(o.resultsDir, 'steps', '02.png')]);
    expect(report.steps.map((s) => s.screenshot)).toEqual(['steps/01.png', 'steps/02.png']);
    expect(driver.stopped).toBe(true);
    expect(report.recording).toEqual({ videoPath: 'video.webm', tracePath: 'trace.zip' });
    expect(driver.startOpts).toMatchObject({ baseUrl: 'http://fake', resultsDir: o.resultsDir });
  });

  it('marks remaining steps skipped and still stops the driver when it crashes', async () => {
    const driver = new FakeDriver();
    driver.crash = new Error('browser closed');
    const o = await opts({
      test: test([{ kind: 'action', text: 'click Sign in' }, { kind: 'action', text: 'next' }]),
      driver, resolved: resolvedWith({ 'click Sign in': clickSignIn, next: clickSignIn }), heal: { maxPerRun: 0, maxPerStep: 0 },
    });
    const { report } = await runTest(o);
    expect(report.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(driver.stopped).toBe(true);
  });

  it('fails the step with the resolver error when resolution itself throws', async () => {
    const driver = new FakeDriver();
    const resolver = createFakeResolver(() => { throw new Error('Missing ANTHROPIC_API_KEY'); });
    const o = await opts({ test: test([{ kind: 'action', text: 'click Sign in' }]), driver, resolver });
    const { report } = await runTest(o);
    expect(report.steps[0].status).toBe('failed');
    expect(report.steps[0].error).toMatch(/ANTHROPIC_API_KEY/);
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
      driver, resolved: resolvedWith({ 'click Sign in': clickSignIn, 'then fail': stale, never: clickSignIn }), heal: { maxPerRun: 0, maxPerStep: 0 },
    });
    const { report } = await runTest(o);
    expect(driver.stepLabels).toEqual(['click Sign in', 'then fail']);
    expect(report.steps[0]).toMatchObject({ status: 'passed', startMs: 10, endMs: 110, anomalies: [{ kind: 'console-error', message: 'boom', t: 5 }] });
    expect(report.steps[1]).toMatchObject({ status: 'failed', startMs: 120, endMs: 220, anomalies: [] });
    expect(report.steps[2].startMs).toBeUndefined();
    expect(report.steps[2].anomalies).toEqual([]);
    expect(report.anomalyCount).toBe(1);
    expect(report.mode).toBe('replay');
    expect(report.flow).toBe('General');
  });
  it('derives the flow from the path or the declared field', async () => {
    const driver = new FakeDriver();
    const o = await opts({ testPath: 'e2e/checkout/pay.yaml', test: test([{ kind: 'action', text: 'click Sign in' }]), driver, resolved: resolvedWith({ 'click Sign in': clickSignIn }) });
    expect((await runTest(o)).report.flow).toBe('Checkout');
    const o2 = await opts({ testPath: 'e2e/checkout/pay.yaml', test: { ...test([{ kind: 'action', text: 'click Sign in' }]), flow: 'Buying' }, driver: new FakeDriver(), resolved: resolvedWith({ 'click Sign in': clickSignIn }) });
    expect((await runTest(o2)).report.flow).toBe('Buying');
  });
});
