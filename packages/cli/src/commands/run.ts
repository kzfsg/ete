import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import fg from 'fast-glob';
import {
  glyph,
  loadResolved,
  parseTestFile,
  resolvedPathFor,
  resultsDirName,
  runTest,
  saveResolved,
  writeReport,
  type Driver,
  type Report,
  type Resolver,
} from '@ete/core';
import { createBrowserDriver } from '@ete/driver-browser';
import { startApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createLazyResolver } from '../model.js';

export type RunCommandOptions = {
  cwd: string;
  files: string[];
  ci: boolean;
  headed?: boolean;
  config?: string;
  url?: string;
  start?: string;
  log?: (line: string) => void;
  /** Test seams. */
  resolver?: Resolver;
  createDriver?: () => Driver;
};

export const RESULTS_DIR = 'ete-results';

export async function runCommand(opts: RunCommandOptions): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const cfg = await loadConfig(resolve(opts.cwd, opts.config ?? 'ete.yaml'));
  const url = opts.url ?? cfg.url;
  const start = opts.start ?? cfg.start;

  const patterns = opts.files.length ? opts.files : ['e2e/**/*.yaml', 'e2e/**/*.yml'];
  const files = (await fg(patterns, { cwd: opts.cwd, ignore: ['**/.resolved/**'] })).sort();
  if (files.length === 0) {
    log(`No test files matched ${patterns.join(', ')}. Write one under e2e/ or run \`ete author "<goal>"\`.`);
    return 1;
  }

  const resolver = opts.resolver ?? createLazyResolver(cfg.llm);
  const createDriver = opts.createDriver ?? (() => createBrowserDriver());

  const app = await startApp({ start, url, readyTimeout: cfg.readyTimeout, log });
  const reports: Report[] = [];
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
      log(`\n${test.name} (${file})`);
      const { report, resolved, healed } = await runTest({
        testPath: file,
        test,
        driver: createDriver(),
        resolver,
        resolved: await loadResolved(resolvedPath),
        baseUrl: url,
        resultsDir,
        heal: cfg.heal,
        ci: opts.ci,
        headed: opts.headed,
        log: (l) => log(`  ${l}`),
      });
      await writeReport(resultsDir, report);
      const changed = Object.keys(healed.steps).length > 0;
      if (changed) {
        if (opts.ci) {
          await writeFile(join(resultsDir, 'resolved.healed.json'), JSON.stringify(healed, null, 2) + '\n');
          log(`  ${Object.keys(healed.steps).length} step(s) resolved/healed in CI; run \`ete run ${file}\` locally to persist them.`);
        } else {
          await saveResolved(resolvedPath, resolved);
          log(`  updated ${relative(opts.cwd, resolvedPath)}`);
        }
      }
      reports.push(report);
      log(`  ${glyph(report.status === 'passed' ? 'passed' : 'failed')} ${report.status} in ${report.durationMs} ms`);
    }
  } finally {
    await app.stop();
  }

  const failed = reports.filter((r) => r.status === 'failed').length;
  log(`\n${reports.length - failed}/${reports.length} passed. Results in ${RESULTS_DIR}/ (run \`ete report\` to view).`);
  return failed ? 1 : 0;
}
