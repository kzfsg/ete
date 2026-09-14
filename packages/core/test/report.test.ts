import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReport, renderHtml, collectReports } from '../src/report.js';
import type { Report } from '../src/schema.js';

const passed: Report = {
  name: 'Login flow', file: 'e2e/login.yaml', flow: 'Login', mode: 'replay', status: 'passed', durationMs: 1200, anomalyCount: 0,
  recording: { videoPath: 'video.webm', tracePath: 'trace.zip' },
  steps: [
    { index: 1, text: 'go to /login', kind: 'action', status: 'passed', durationMs: 300, screenshot: 'steps/01.png', anomalies: [] },
    { index: 2, text: 'click Sign in', kind: 'action', status: 'healed', durationMs: 900, screenshot: 'steps/02.png', anomalies: [] },
  ],
};
const failed: Report = {
  name: 'Checkout', file: 'e2e/checkout.yaml', flow: 'Checkout', mode: 'replay', status: 'failed', durationMs: 500, anomalyCount: 0, recording: {},
  steps: [
    { index: 1, text: 'click Buy <now>', kind: 'action', status: 'failed', durationMs: 500, screenshot: 'steps/01.png', error: 'Timeout 5000ms', anomalies: [] },
    { index: 2, text: 'expect receipt', kind: 'expect', status: 'skipped', durationMs: 0, anomalies: [] },
  ],
};

describe('writeReport / collectReports', () => {
  it('round-trips through report.json files under the results root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ete-rep-'));
    await mkdir(join(root, 'login'), { recursive: true });
    await mkdir(join(root, 'checkout'), { recursive: true });
    await writeReport(join(root, 'login'), passed);
    await writeReport(join(root, 'checkout'), failed);
    const reports = await collectReports(root);
    expect(reports.map((r) => r.name).sort()).toEqual(['Checkout', 'Login flow']);
    expect(JSON.parse(await readFile(join(root, 'login', 'report.json'), 'utf8'))).toEqual(passed);
  });
  it('normalises phase-1 reports that lack flow, mode, anomalies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ete-rep-'));
    await mkdir(join(root, 'old'), { recursive: true });
    await writeFile(join(root, 'old', 'report.json'), JSON.stringify({ name: 'Old', file: 'e2e/old.yaml', status: 'passed', durationMs: 1, recording: {}, steps: [{ index: 1, text: 'x', kind: 'action', status: 'passed', durationMs: 1 }] }));
    const [r] = await collectReports(root);
    expect(r).toMatchObject({ flow: 'General', mode: 'replay', anomalyCount: 0 });
    expect(r.steps[0].anomalies).toEqual([]);
  });
  it('returns an empty list when the root does not exist', async () => {
    expect(await collectReports(join(tmpdir(), 'ete-does-not-exist'))).toEqual([]);
  });
});

describe('renderHtml', () => {
  const html = renderHtml([passed, failed]);
  it('names every test', () => {
    expect(html).toContain('Login flow');
    expect(html).toContain('Checkout');
  });
  it('embeds the video when present', () => {
    expect(html).toMatch(/<video[^>]*src="login\/video\.webm"/);
  });
  it('shows one image per step screenshot, relative to the results root', () => {
    expect(html.match(/<img /g)?.length).toBe(3);
    expect(html).toContain('src="checkout/steps/01.png"');
  });
  it('marks step status with a class and escapes html in step text', () => {
    expect(html).toContain('status-failed');
    expect(html).toContain('status-healed');
    expect(html).toContain('click Buy &lt;now&gt;');
    expect(html).toContain('Timeout 5000ms');
  });
});
