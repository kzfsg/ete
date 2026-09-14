#!/usr/bin/env node
import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { reportCommand } from './commands/report.js';
import { initCommand } from './commands/init.js';
import { exploreCommand } from './commands/explore.js';

const program = new Command();
program.name('ete').description('LLM-authored, deterministically replayed E2E tests for CI').version('0.0.1');

program
  .command('run')
  .description('Run tests: replay resolved steps, resolve new ones, heal broken ones')
  .argument('[files...]', 'test files or globs (default: e2e/**/*.yaml)')
  .option('--ci', 'never write to e2e/.resolved; write resolved.healed.json to results instead', false)
  .option('--headed', 'show the browser', false)
  .option('-c, --config <path>', 'path to ete.yaml', 'ete.yaml')
  .option('--url <url>', 'override the base URL from ete.yaml')
  .option('--start <command>', 'override the start command from ete.yaml')
  .action(async (files: string[], o) => {
    process.exitCode = await runCommand({ cwd: process.cwd(), files, ci: o.ci, headed: o.headed, config: o.config, url: o.url, start: o.start });
  });

program
  .command('init')
  .description('Scaffold ete.yaml, e2e/, and a GitHub workflow in the current project')
  .option('--url <url>', 'base URL of the app under test', 'http://localhost:3000')
  .option('--start <command>', 'command that serves the app')
  .option('-f, --force', 'overwrite existing files', false)
  .action(async (o) => {
    const files = await initCommand({ cwd: process.cwd(), url: o.url, start: o.start, force: o.force });
    console.log(files.length ? `Created/updated:\n  ${files.join('\n  ')}` : 'Nothing to do; files already exist (use --force to overwrite).');
    console.log('\nNext: `ete author "<what a user should be able to do>"` then `ete run`.');
  });

const exploreOpts = (cmd: Command) =>
  cmd
    .argument('<goal>', 'what a user should be able to do, e.g. "a user can log in"')
    .option('--flow <name>', 'group this test under a user flow (also sets the e2e/ subfolder)')
    .option('-o, --out <path>', 'where to write the test (default: e2e/<flow>/<slug>.yaml)')
    .option('-c, --config <path>', 'path to ete.yaml', 'ete.yaml')
    .option('--url <url>', 'override the base URL from ete.yaml')
    .option('--headed', 'show the browser', false)
    .option('--max-actions <n>', 'exploration budget', (v) => Number(v), 30);

exploreOpts(program.command('explore'))
  .description('Let the LLM drive the browser through a flow, recording it; --save writes a replayable test')
  .option('--save', 'write e2e/<flow>/<slug>.yaml and its resolved actions', false)
  .action(async (goal: string, o) => {
    const { report } = await exploreCommand({ cwd: process.cwd(), goal, flow: o.flow, save: o.save, out: o.out, config: o.config, url: o.url, headed: o.headed, maxActions: o.maxActions });
    process.exitCode = report.status === 'passed' ? 0 : 1;
  });

exploreOpts(program.command('author'))
  .description('Alias for `explore --save`')
  .action(async (goal: string, o) => {
    const { report } = await exploreCommand({ cwd: process.cwd(), goal, flow: o.flow, save: true, out: o.out, config: o.config, url: o.url, headed: o.headed, maxActions: o.maxActions });
    process.exitCode = report.status === 'passed' ? 0 : 1;
  });

program
  .command('report')
  .description('Render ete-results/ to a single HTML page and open it')
  .option('--no-open', 'do not open the browser')
  .action(async (o) => {
    const out = await reportCommand({ cwd: process.cwd(), open: o.open });
    console.log(out);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
