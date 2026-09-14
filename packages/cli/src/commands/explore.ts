import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { exploreFlow, flowFor, resolvedPathFor, resultsDirName, saveResolved, writeReport, type Driver, type Report, type TestFile } from '@ete/core';
import { createBrowserDriver } from '@ete/driver-browser';
import type { LanguageModel } from 'ai';
import { startApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createModel, envKeyFor } from '../model.js';
import { RESULTS_DIR, writeFilmstrip } from './run.js';

export type ExploreCommandOptions = {
  cwd: string;
  goal: string;
  flow?: string;
  save: boolean;
  out?: string;
  config?: string;
  url?: string;
  headed?: boolean;
  maxActions?: number;
  log?: (line: string) => void;
  /** Test seams. */
  model?: LanguageModel;
  createDriver?: () => Driver;
};

export type ExploreCommandResult = { report: Report; savedTo?: string };

export function slugify(goal: string): string {
  return goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'test';
}

export function toYaml(test: TestFile): string {
  return YAML.stringify({
    name: test.name,
    ...(test.flow ? { flow: test.flow } : {}),
    steps: test.steps.map((s) => (s.kind === 'action' ? s.text : { expect: s.text })),
  });
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export async function exploreCommand(opts: ExploreCommandOptions): Promise<ExploreCommandResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const cfg = await loadConfig(resolve(opts.cwd, opts.config ?? 'ete.yaml'));
  const url = opts.url ?? cfg.url;
  let model = opts.model;
  if (!model) {
    const key = envKeyFor(cfg.llm.provider);
    if (!process.env[key]) throw new Error(`Missing ${key}: \`ete explore\` needs an LLM. Set it in the environment.`);
    model = createModel(cfg.llm);
  }
  const flowDir = opts.flow ? slugify(opts.flow) : undefined;
  const testPath = opts.out ?? (flowDir ? join('e2e', flowDir, `${slugify(opts.goal)}.yaml`) : join('e2e', `${slugify(opts.goal)}.yaml`));
  const testAbs = join(opts.cwd, testPath);
  if (opts.save && (await exists(testAbs))) {
    throw new Error(`${testPath} already exists. Pass --out to choose another path, or delete it first.`);
  }
  const resultsDir = join(opts.cwd, RESULTS_DIR, resultsDirName(testPath));
  await mkdir(resultsDir, { recursive: true });

  const app = await startApp({ start: cfg.start, url, readyTimeout: cfg.readyTimeout, log });
  let result;
  try {
    log(`\n## ${flowFor(testPath, opts.flow)}\nExploring ${url}: ${opts.goal}`);
    result = await exploreFlow({
      goal: opts.goal,
      flow: opts.flow,
      driver: (opts.createDriver ?? (() => createBrowserDriver()))(),
      model,
      baseUrl: url,
      resultsDir,
      testPath,
      maxActions: opts.maxActions,
      headed: opts.headed,
      log,
    });
  } finally {
    await app.stop();
  }
  const { report, test, resolved } = result;
  await writeFilmstrip(resultsDir, report);
  await writeReport(resultsDir, report);
  log(`  ${report.status === 'passed' ? '✓' : '✗'} ${report.status} in ${report.durationMs} ms${report.anomalyCount ? ` · ${report.anomalyCount} anomalies` : ''}`);

  if (!opts.save) {
    log(`\nNot saved (pass --save to write ${testPath}). Results in ${RESULTS_DIR}/${resultsDirName(testPath)}/.`);
    return { report };
  }
  if (test.steps.length === 0) throw new Error('The model took no actions and produced no steps, so there is nothing to save. Try a more specific goal.');
  await mkdir(dirname(testAbs), { recursive: true });
  await writeFile(testAbs, toYaml(test));
  const resolvedPath = join(opts.cwd, resolvedPathFor(testPath));
  await saveResolved(resolvedPath, resolved);
  log(`\nSaved ${testPath} and ${resolvedPathFor(testPath)} (${test.steps.length} steps). Replay with \`ete run ${testPath}\`.`);
  return { report, savedTo: testPath };
}
