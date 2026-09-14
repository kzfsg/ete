import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportCommand } from '../src/commands/report.js';

describe('ete report', () => {
  it('writes index.html from the collected reports', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ete-rc-'));
    await mkdir(join(cwd, 'ete-results', 't'), { recursive: true });
    await writeFile(join(cwd, 'ete-results', 't', 'report.json'), JSON.stringify({ name: 'T1', file: 'e2e/t.yaml', status: 'passed', durationMs: 1, steps: [], recording: {} }));
    const out = await reportCommand({ cwd, open: false });
    expect(out).toBe(join(cwd, 'ete-results', 'index.html'));
    expect(await readFile(out, 'utf8')).toContain('T1');
  });
  it('throws when there are no results', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ete-rc-'));
    await expect(reportCommand({ cwd, open: false })).rejects.toThrow(/No results/);
  });
});
