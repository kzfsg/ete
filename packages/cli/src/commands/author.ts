import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { authorTest, type Driver, type TestFile } from '@ete/core';
import { createBrowserDriver } from '@ete/driver-browser';
import type { LanguageModel } from 'ai';
import { startApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createModel, envKeyFor } from '../model.js';

export type AuthorCommandOptions = {
  cwd: string;
  goal: string;
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

export function slugify(goal: string): string {
  return goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'test';
}

export function toYaml(test: TestFile): string {
  return YAML.stringify({
    name: test.name,
    steps: test.steps.map((s) => (s.kind === 'action' ? s.text : { expect: s.text })),
  });
}

export async function authorCommand(opts: AuthorCommandOptions): Promise<string> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const cfg = await loadConfig(resolve(opts.cwd, opts.config ?? 'ete.yaml'));
  const url = opts.url ?? cfg.url;
  let model = opts.model;
  if (!model) {
    const key = envKeyFor(cfg.llm.provider);
    if (!process.env[key]) throw new Error(`Missing ${key}: \`ete author\` needs an LLM. Set it in the environment.`);
    model = createModel(cfg.llm);
  }
  const outRel = opts.out ?? join('e2e', `${slugify(opts.goal)}.yaml`);
  const outAbs = join(opts.cwd, outRel);
  try {
    await access(outAbs);
    throw new Error(`${outRel} already exists. Pass --out to choose another path.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const app = await startApp({ start: cfg.start, url, readyTimeout: cfg.readyTimeout, log });
  let test: TestFile;
  try {
    log(`Exploring ${url} for: ${opts.goal}`);
    test = await authorTest({
      goal: opts.goal,
      driver: (opts.createDriver ?? (() => createBrowserDriver()))(),
      model,
      baseUrl: url,
      resultsDir: join(opts.cwd, 'ete-results', '.author'),
      maxActions: opts.maxActions,
      log,
    });
  } finally {
    await app.stop();
  }
  if (test.steps.length === 0) throw new Error('The model took no actions and produced no steps. Try a more specific goal.');
  await mkdir(dirname(outAbs), { recursive: true });
  await writeFile(outAbs, toYaml(test));
  log(`\nWrote ${outRel} (${test.steps.length} steps). Review it, then run \`ete run ${outRel}\` to resolve and record.`);
  return outRel;
}
