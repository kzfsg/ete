import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { unzipSync, strFromU8 } from 'fflate';
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

describe('BrowserDriver telemetry', () => {
  it('collects anomalies per step, timestamps steps, and groups the trace', async () => {
    const resultsDir = await mkdtemp(join(tmpdir(), 'ete-tel-'));
    const d = createBrowserDriver();
    await d.start({ baseUrl, resultsDir });

    await d.beginStep('go to /noisy.html');
    await d.act({ kind: 'navigate', url: '/noisy.html' });
    await d.act({ kind: 'wait', ms: 500 });
    const t1 = await d.endStep();
    const kinds = new Set(t1.anomalies.map((a) => a.kind));
    expect(kinds).toEqual(new Set(['console-error', 'page-error', 'http-error', 'request-failed']));
    expect(t1.anomalies.find((a) => a.kind === 'console-error')?.message).toContain('boom');
    expect(t1.anomalies.find((a) => a.kind === 'page-error')?.message).toContain('kaboom');
    expect(t1.anomalies.find((a) => a.kind === 'http-error')?.message).toMatch(/500.*\/api\/fail/);
    expect(t1.startMs).toBeGreaterThanOrEqual(0);
    expect(t1.endMs).toBeGreaterThan(t1.startMs);
    for (const a of t1.anomalies) expect(a.t).toBeGreaterThanOrEqual(t1.startMs);

    await d.beginStep('click "Open dialog"');
    await d.act({ kind: 'click', target: { selector: 'role=button[name="Open dialog"]' } });
    const t2 = await d.endStep();
    expect(t2.anomalies.map((a) => a.kind)).toEqual(['dialog']);
    expect(t2.anomalies[0].message).toContain('hi there');
    expect(t2.startMs).toBeGreaterThanOrEqual(t1.endMs);

    await d.beginStep('quiet step');
    await d.act({ kind: 'wait', ms: 50 });
    expect((await d.endStep()).anomalies).toEqual([]);

    const rec = await d.stop();
    const zip = unzipSync(new Uint8Array(await readFile(join(resultsDir, rec.tracePath!))));
    const traceText = Object.entries(zip).filter(([n]) => n.endsWith('.trace')).map(([, b]) => strFromU8(b)).join('\n');
    expect(traceText).toContain('go to /noisy.html');
    expect(traceText).toContain('click \\"Open dialog\\"');
  });
});
