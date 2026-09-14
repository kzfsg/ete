#!/usr/bin/env node
import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { reportCommand } from './commands/report.js';
import { initCommand } from './commands/init.js';
import { sessionAbort, sessionAct, sessionExpect, sessionObserve, sessionSave, sessionServe, sessionStart, sessionStatus, sessionUndo } from './commands/session.js';
import { fileURLToPath } from 'node:url';

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

const session = program.command('session').description('Drive a recorded browser session yourself (for agents); no model involved');
const cwd = () => process.cwd();
const out = (text: string) => console.log(text);

session
  .command('start')
  .description('Start a session: a new test, or resume an existing one at a step')
  .option('--name <name>', 'name of the new test')
  .option('--flow <flow>', 'user flow the test belongs to')
  .option('-o, --out <path>', 'test file path (default: e2e/<flow>/<slug>.yaml)')
  .option('--from <test>', 'existing test file to resume')
  .option('--at <n>', 'step to resume at (steps before it are replayed)', (v) => Number(v))
  .option('-c, --config <path>', 'path to ete.yaml', 'ete.yaml')
  .option('--url <url>', 'override the base URL from ete.yaml')
  .option('--headed', 'show the browser', false)
  .action(async (o) => out(await sessionStart({ cwd: cwd(), bin: fileURLToPath(import.meta.url), ...o })));

session
  .command('serve', { hidden: true })
  .option('--name <name>').option('--flow <flow>').option('-o, --out <path>').option('--from <test>').option('--at <n>', '', (v) => Number(v))
  .option('-c, --config <path>', '', 'ete.yaml').option('--url <url>').option('--headed', '', false)
  .action(async (o) => sessionServe({ cwd: cwd(), ...o }));

session
  .command('observe')
  .description('Print the current URL, accessibility tree, and screenshot path')
  .action(async () => out(await sessionObserve(cwd())));

session
  .command('act')
  .description('Perform one action and record it if it succeeds: goto <url> | click <sel> | type <sel> <text> | press <key> | scroll <dy> [sel] | wait <ms>')
  .argument('<args...>')
  .option('--as <text>', 'natural-language step text to record instead of the default')
  .action(async (args: string[], o) => {
    const r = await sessionAct(cwd(), args, o.as);
    out(r.text);
    if (!r.ok) process.exitCode = 1;
  });

session
  .command('expect')
  .description('Check an assertion and record it if it holds: text <text> | visible <sel> | url <regex>')
  .argument('<args...>')
  .option('--as <text>', 'natural-language step text to record instead of the default')
  .option('--record', 'record the assertion even if it fails', false)
  .action(async (args: string[], o) => {
    const r = await sessionExpect(cwd(), args, o.as, o.record);
    out(r.text);
    if (!r.ok) process.exitCode = 1;
  });

session.command('status').description('Show recorded steps and the current page').action(async () => out(await sessionStatus(cwd())));
session.command('undo').description('Drop the last recorded step (browser state is not rewound)').action(async () => out(await sessionUndo(cwd())));
session.command('save').description('Write the test + recorded actions, finish the recording, stop').action(async () => out(await sessionSave(cwd())));
session.command('abort').description('Discard the session and stop').action(async () => out(await sessionAbort(cwd())));

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
