import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import fg from 'fast-glob';
import {
  flowFor,
  glyph,
  loadResolved,
  parseTestFile,
  resolvedPathFor,
  resultsDirName,
  resumeHint,
  runTest,
  writeReport,
  type Driver,
  type Report,
} from '@ete/core';
import { createBrowserDriver, renderFilmstrip, renderPreview } from '@ete/driver-browser';
import { startApp } from '../app.js';
import { loadConfig, type Config } from '../config.js';

export type RunCommandOptions = {
  cwd: string;
  files: string[];
  /** Accepted for compatibility; replay never writes to e2e/ anyway. */
  ci?: boolean;
  headed?: boolean;
  config?: string;
  url?: string;
  start?: string;
  log?: (line: string) => void;
  /** Test seam. */
  createDriver?: () => Driver;
};

export const RESULTS_DIR = 'ete-results';

export function driverOptions(cfg: Config) {
  return { navigationTimeoutMs: cfg.timeouts.navigation, actionTimeoutMs: cfg.timeouts.action, checkTimeoutMs: cfg.timeouts.assertion };
}

/**
 * Renders the PR-comment media for a test and records it on the report:
 * filmstrip.png (one frame per step) and preview.png (animated PNG of the video).
 * Neither may ever fail a run.
 */
export async function writeFilmstrip(resultsDir: string, report: Report): Promise<void> {
  const frames = report.steps
    .filter((s) => s.screenshot)
    .map((s) => ({ path: join(resultsDir, s.screenshot!), index: s.index, failed: s.status === 'failed' }));
  if (frames.length > 0) {
    try {
      const { frames: n } = await renderFilmstrip({ frames, out: join(resultsDir, 'filmstrip.png') });
      if (n > 0) report.recording.filmstripPath = 'filmstrip.png';
    } catch {
      /* ignore */
    }
  }
  if (report.recording.videoPath) {
    const res = await renderPreview({ video: join(resultsDir, report.recording.videoPath), out: join(resultsDir, 'preview.png') });
    if (res.ok) report.recording.previewPath = 'preview.png';
  }
}

export async function runCommand(opts: RunCommandOptions): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const cfg = await loadConfig(resolve(opts.cwd, opts.config ?? 'ete.yaml'));
  const url = opts.url ?? cfg.url;
  const start = opts.start ?? cfg.start;

  const patterns = opts.files.length ? opts.files : ['e2e/**/*.yaml', 'e2e/**/*.yml'];
  const files = (await fg(patterns, { cwd: opts.cwd, ignore: ['**/.resolved/**'] })).sort((a, b) => flowFor(a).localeCompare(flowFor(b)) || a.localeCompare(b));
  if (files.length === 0) {
    log(`No test files matched ${patterns.join(', ')}. Write one under e2e/ or run \`ete author "<goal>"\`.`);
    return 1;
  }

  const createDriver = opts.createDriver ?? (() => createBrowserDriver(driverOptions(cfg)));

  const app = await startApp({ start, url, readyTimeout: cfg.readyTimeout, log });
  const reports: Report[] = [];
  let currentFlow: string | undefined;
  try {
    for (const file of files) {
      const testPath = join(opts.cwd, file);
      const test = parseTestFile(await readFile(testPath, 'utf8'));
      if (test.target !== 'browser') {
        log(`Skipping ${file}: target "${test.target}" is not supported yet.`);
        continue;
      }
      const resolvedPath = join(opts.cwd, resolvedPathFor(file));
      const resultsDir = join(opts.cwd, RESULTS_DIR, resultsDirName(file));
      await mkdir(resultsDir, { recursive: true });
      const flow = flowFor(file, test.flow);
      if (flow !== currentFlow) {
        currentFlow = flow;
        log(`\n## ${flow}`);
      }
      log(`${test.name} (${file})`);
      const { report } = await runTest({
        testPath: file,
        test,
        driver: createDriver(),
        resolved: await loadResolved(resolvedPath),
        baseUrl: url,
        resultsDir,
        headed: opts.headed,
        log: (l) => log(`  ${l}`),
      });
      await writeFilmstrip(resultsDir, report);
      await writeReport(resultsDir, report);
      reports.push(report);
      log(`  ${glyph(report.status === 'passed' ? 'passed' : 'failed')} ${report.status} in ${report.durationMs} ms${report.anomalyCount ? ` · ${report.anomalyCount} anomal${report.anomalyCount === 1 ? 'y' : 'ies'}` : ''}`);
    }
  } finally {
    await app.stop();
  }

  const failed = reports.filter((r) => r.status === 'failed').length;
  for (const r of reports.filter((r) => r.status === 'failed')) {
    const step = r.steps.find((s) => s.status === 'failed');
    if (step) log(`\nTo fix "${r.name}": ${resumeHint(r.file, step.index)}`);
  }
  log(`\n${reports.length - failed}/${reports.length} passed. Results in ${RESULTS_DIR}/ (run \`ete report\` to view).`);
  return failed ? 1 : 0;
}
