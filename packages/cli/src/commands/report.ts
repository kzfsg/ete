import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { collectReports, renderHtml, renderStandaloneHtml } from '@ete/core';
import { RESULTS_DIR } from './run.js';

export type ReportOptions = {
  cwd: string;
  open: boolean;
  /** Also write a single self-contained file (videos and screenshots inlined). */
  standalone?: boolean | string;
  title?: string;
};

export type ReportResult = { index: string; standalone?: string };

export async function reportCommand(opts: ReportOptions): Promise<ReportResult> {
  const root = join(opts.cwd, RESULTS_DIR);
  const reports = await collectReports(root);
  if (reports.length === 0) throw new Error(`No results found in ${root}. Run \`ete run\` first.`);
  const index = join(root, 'index.html');
  await writeFile(index, renderHtml(reports, opts.title));
  const result: ReportResult = { index };
  if (opts.standalone) {
    const out = typeof opts.standalone === 'string' ? join(opts.cwd, opts.standalone) : join(root, 'ete-report.html');
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, await renderStandaloneHtml(reports, root, { title: opts.title }));
    result.standalone = out;
  }
  if (opts.open) {
    const target = result.standalone ?? index;
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [target], { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).unref();
  }
  return result;
}
