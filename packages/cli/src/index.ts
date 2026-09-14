#!/usr/bin/env node
import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { reportCommand } from './commands/report.js';

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
