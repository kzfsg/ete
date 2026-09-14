import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { collectReports, renderHtml } from '@ete/core';
import { RESULTS_DIR } from './run.js';

export async function reportCommand(opts: { cwd: string; open: boolean }): Promise<string> {
  const root = join(opts.cwd, RESULTS_DIR);
  const reports = await collectReports(root);
  if (reports.length === 0) throw new Error(`No results found in ${root}. Run \`ete run\` first.`);
  const out = join(root, 'index.html');
  await writeFile(out, renderHtml(reports));
  if (opts.open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [out], { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).unref();
  }
  return out;
}
