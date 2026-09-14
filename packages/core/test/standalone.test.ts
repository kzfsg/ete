import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStandaloneHtml } from '../src/report.js';
import type { Report } from '../src/schema.js';

async function results(): Promise<{ root: string; report: Report }> {
  const root = await mkdtemp(join(tmpdir(), 'ete-sa-'));
  await mkdir(join(root, 'login', 'steps'), { recursive: true });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  await writeFile(join(root, 'login', 'steps', '01.png'), png);
  await writeFile(join(root, 'login', 'filmstrip.png'), png);
  await writeFile(join(root, 'login', 'video.webm'), Buffer.from('1a45dfa3', 'hex'));
  const report: Report = {
    name: 'Login', file: 'e2e/login.yaml', flow: 'Auth', mode: 'replay', status: 'passed', durationMs: 900, anomalyCount: 0,
    recording: { videoPath: 'video.webm', tracePath: 'trace.zip', filmstripPath: 'filmstrip.png' },
    steps: [{ index: 1, text: 'go to /login', kind: 'action', status: 'passed', durationMs: 300, screenshot: 'steps/01.png', startMs: 0, endMs: 300, anomalies: [] }],
  };
  await writeFile(join(root, 'login', 'report.json'), JSON.stringify(report));
  return { root, report };
}

describe('renderStandaloneHtml', () => {
  it('inlines video, screenshots, and filmstrip as data URIs and references no local files', async () => {
    const { root, report } = await results();
    const html = await renderStandaloneHtml([report], root, { title: 'PR #5 · run 42' });
    expect(html).toContain('PR #5 · run 42');
    expect(html).toMatch(/<video[^>]*src="data:video\/webm;base64,GkXfow=="/);
    expect(html).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="step 1"/);
    expect(html).toMatch(/class="filmstrip" src="data:image\/png;base64,/);
    expect(html).not.toMatch(/src="login\//);
    expect(html).not.toMatch(/src="[^"]*\.(png|webm)"/);
  });
  it('degrades gracefully when a referenced file is missing', async () => {
    const { root, report } = await results();
    const broken = { ...report, recording: { ...report.recording, videoPath: 'nope.webm' } };
    const html = await renderStandaloneHtml([broken], root);
    expect(html).toContain('No video recorded');
    expect(html).toMatch(/alt="step 1"/);
  });
});
