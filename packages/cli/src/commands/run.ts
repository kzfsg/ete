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
import { createBrowserDriver, renderFilmstrip } from '@ete/driver-browser';
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
  /** Replay this many tests at once, each in its own browser. Default 1. */
  workers?: number;
  /** Run only the i-th of n deterministic slices of the file list. */
  shard?: { index: number; total: number };
  log?: (line: string) => void;
  /** Test seam. */
  createDriver?: () => Driver;
};

/** Deterministic round-robin slice of a sorted file list. */
export function shardFiles<T>(files: T[], shard?: { index: number; total: number }): T[] {
  if (!shard) return files;
  if (shard.total < 1 || shard.index < 1 || shard.index > shard.total) throw new Error(`Invalid shard ${shard.index}/${shard.total}`);
  return files.filter((_, i) => i % shard.total === shard.index - 1);
}

/** Runs tasks with at most `limit` in flight, preserving result order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }));
  return results;
}

export const RESULTS_DIR = 'ete-results';

export function driverOptions(cfg: Config) {
  return { navigationTimeoutMs: cfg.timeouts.navigation, actionTimeoutMs: cfg.timeouts.action, checkTimeoutMs: cfg.timeouts.assertion };
}

/** Renders filmstrip.png (one frame per step) and records it on the report. Never fails a run. */
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
}

export async function runCommand(opts: RunCommandOptions): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const cfg = await loadConfig(resolve(opts.cwd, opts.config ?? 'ete.yaml'));
  const url = opts.url ?? cfg.url;
  const start = opts.start ?? cfg.start;

  const patterns = opts.files.length ? opts.files : ['e2e/**/*.yaml', 'e2e/**/*.yml'];
  const all = (await fg(patterns, { cwd: opts.cwd, ignore: ['**/.resolved/**'] })).sort((a, b) => flowFor(a).localeCompare(flowFor(b)) || a.localeCompare(b));
  const files = shardFiles(all, opts.shard);
  if (all.length === 0) {
    log(`No test files matched ${patterns.join(', ')}. Write one under e2e/ or record one with \`ete session start\`.`);
    return 1;
  }
  if (opts.shard) log(`Shard ${opts.shard.index}/${opts.shard.total}: ${files.length} of ${all.length} tests`);
  if (files.length === 0) return 0;

  const createDriver = opts.createDriver ?? (() => createBrowserDriver(driverOptions(cfg)));
  const workers = Math.max(1, opts.workers ?? 1);

  const app = await startApp({ start, url, readyTimeout: cfg.readyTimeout, log });
  const reports: Report[] = [];
  try {
    // Each test buffers its own lines so concurrent runs stay readable; flows are printed as they first appear.
    const printedFlows = new Set<string>();
    const results = await mapLimit(files, workers, async (file) => {
      const buf: string[] = [];
      const testPath = join(opts.cwd, file);
      const test = parseTestFile(await readFile(testPath, 'utf8'));
      if (test.target !== 'browser') {
        buf.push(`Skipping ${file}: target "${test.target}" is not supported yet.`);
        return { file, flow: flowFor(file, test.flow), buf, report: undefined };
      }
      const resolvedPath = join(opts.cwd, resolvedPathFor(file));
      const resultsDir = join(opts.cwd, RESULTS_DIR, resultsDirName(file));
      await mkdir(resultsDir, { recursive: true });
      buf.push(`${test.name} (${file})`);
      const { report } = await runTest({
        testPath: file,
        test,
        driver: createDriver(),
        resolved: await loadResolved(resolvedPath),
        baseUrl: app.url,
        resultsDir,
        headed: opts.headed,
        log: (l) => buf.push(`  ${l}`),
      });
      await writeFilmstrip(resultsDir, report);
      await writeReport(resultsDir, report);
      buf.push(`  ${glyph(report.status === 'passed' ? 'passed' : 'failed')} ${report.status} in ${report.durationMs} ms${report.anomalyCount ? ` · ${report.anomalyCount} anomal${report.anomalyCount === 1 ? 'y' : 'ies'}` : ''}`);
      return { file, flow: flowFor(file, test.flow), buf, report };
    }).then((rs) => {
      // Sequential mode prints as it goes; concurrent mode prints in file order when done.
      return rs;
    });
    for (const r of results) {
      if (!printedFlows.has(r.flow)) {
        printedFlows.add(r.flow);
        log(`\n## ${r.flow}`);
      }
      for (const l of r.buf) log(l);
      if (r.report) reports.push(r.report);
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
