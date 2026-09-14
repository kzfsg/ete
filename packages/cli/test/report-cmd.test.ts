import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportCommand } from '../src/commands/report.js';

async function results(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'ete-rc-'));
  await mkdir(join(cwd, 'ete-results', 't', 'steps'), { recursive: true });
  await writeFile(join(cwd, 'ete-results', 't', 'steps', '01.png'), Buffer.from('89504e47', 'hex'));
  await writeFile(join(cwd, 'ete-results', 't', 'video.webm'), Buffer.from('1a45dfa3', 'hex'));
  await writeFile(join(cwd, 'ete-results', 't', 'report.json'), JSON.stringify({
    name: 'T1', file: 'e2e/t.yaml', flow: 'General', mode: 'replay', status: 'passed', durationMs: 1, anomalyCount: 0,
    recording: { videoPath: 'video.webm' },
    steps: [{ index: 1, text: 'x', kind: 'action', status: 'passed', durationMs: 1, screenshot: 'steps/01.png', anomalies: [] }],
  }));
  return cwd;
}

describe('ete report', () => {
  it('writes index.html from the collected reports', async () => {
    const cwd = await results();
    const out = await reportCommand({ cwd, open: false });
    expect(out.index).toBe(join(cwd, 'ete-results', 'index.html'));
    expect(out.standalone).toBeUndefined();
    expect(await readFile(out.index, 'utf8')).toContain('T1');
  });
  it('writes a self-contained ete-report.html when asked, with a title', async () => {
    const cwd = await results();
    const out = await reportCommand({ cwd, open: false, standalone: true, title: 'PR #5 · run 42' });
    expect(out.standalone).toBe(join(cwd, 'ete-results', 'ete-report.html'));
    const html = await readFile(out.standalone!, 'utf8');
    expect(html).toContain('PR #5 · run 42');
    expect(html).toContain('data:video/webm;base64,');
    expect(html).not.toMatch(/src="t\//);
    const custom = await reportCommand({ cwd, open: false, standalone: 'out/report.html' });
    expect((await stat(join(cwd, 'out', 'report.html'))).size).toBeGreaterThan(0);
    expect(custom.standalone).toBe(join(cwd, 'out', 'report.html'));
  });
  it('throws when there are no results', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ete-rc-'));
    await expect(reportCommand({ cwd, open: false })).rejects.toThrow(/No results/);
  });
});
