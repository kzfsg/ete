#!/usr/bin/env node
import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { reportCommand } from './commands/report.js';
import { publishCommand } from './commands/publish.js';
import { initCommand } from './commands/init.js';
import { sessionAbort, sessionAct, sessionExpect, sessionList, sessionObserve, sessionSave, sessionServe, sessionStart, sessionStatus, sessionUndo } from './commands/session.js';
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
  .option('-w, --workers <n>', 'replay this many tests at once (tests must not share state)', (v) => Number(v), 1)
  .option('--shard <i/n>', 'run only the i-th of n slices of the test list (for CI matrices)')
  .action(async (files: string[], o) => {
    const shard = o.shard ? (() => { const m = /^(\d+)\/(\d+)$/.exec(o.shard); if (!m) throw new Error('--shard must look like 1/3'); return { index: Number(m[1]), total: Number(m[2]) }; })() : undefined;
    process.exitCode = await runCommand({ cwd: process.cwd(), files, ci: o.ci, headed: o.headed, config: o.config, url: o.url, start: o.start, workers: o.workers, shard });
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

const withId = (cmd: Command) => cmd.option('--id <session>', 'session id, when several sessions run side by side');

withId(session.command('start'))
  .description('Start a session: a new test, or resume an existing one at a step')
  .option('--port <n>', 'start the app on this port for this session ({port} in start/url is substituted)', (v) => Number(v))
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
  .option('--id <session>').option('--port <n>', '', (v) => Number(v))
  .option('--name <name>').option('--flow <flow>').option('-o, --out <path>').option('--from <test>').option('--at <n>', '', (v) => Number(v))
  .option('-c, --config <path>', '', 'ete.yaml').option('--url <url>').option('--headed', '', false)
  .action(async (o) => sessionServe({ cwd: cwd(), ...o }));

withId(session.command('observe'))
  .description('Print the current URL, accessibility tree, and screenshot path')
  .action(async (o) => out(await sessionObserve(cwd(), o.id)));

withId(session.command('act'))
  .description('Perform one action and record it if it succeeds: goto <url> | click <sel> | type <sel> <text> | press <key> | scroll <dy> [sel] | wait <ms>')
  .argument('<args...>')
  .option('--as <text>', 'natural-language step text to record instead of the default')
  .action(async (args: string[], o) => {
    const r = await sessionAct(cwd(), args, o.as, o.id);
    out(r.text);
    if (!r.ok) process.exitCode = 1;
  });

withId(session.command('expect'))
  .description('Check an assertion and record it if it holds: text <text> | visible <sel> | url <regex>')
  .argument('<args...>')
  .option('--as <text>', 'natural-language step text to record instead of the default')
  .option('--record', 'record the assertion even if it fails', false)
  .action(async (args: string[], o) => {
    const r = await sessionExpect(cwd(), args, o.as, o.record, o.id);
    out(r.text);
    if (!r.ok) process.exitCode = 1;
  });

withId(session.command('status')).description('Show recorded steps and the current page').action(async (o) => out(await sessionStatus(cwd(), o.id)));
withId(session.command('undo')).description('Drop the last recorded step (browser state is not rewound)').action(async (o) => out(await sessionUndo(cwd(), o.id)));
withId(session.command('save')).description('Write the test + recorded actions, finish the recording, stop').action(async (o) => out(await sessionSave(cwd(), o.id)));
withId(session.command('abort')).description('Discard the session and stop').action(async (o) => out(await sessionAbort(cwd(), o.id)));
session.command('list').description('List active sessions in this project').action(async () => out(await sessionList(cwd())));

program
  .command('report')
  .description('Render ete-results/ to a timeline page and open it')
  .option('--no-open', 'do not open the browser')
  .option('-s, --standalone [path]', 'also write one self-contained HTML file with videos and screenshots inlined (default: ete-results/ete-report.html)')
  .option('-t, --title <title>', 'title shown in the report')
  .action(async (o) => {
    const out = await reportCommand({ cwd: process.cwd(), open: o.open, standalone: o.standalone, title: o.title });
    console.log(out.standalone ?? out.index);
  });

program
  .command('publish')
  .description('Upload ete-results/ to the central reports site (needs BLOB_READ_WRITE_TOKEN and --site or ETE_SITE_URL)')
  .option('--site <url>', 'reports site URL')
  .option('--repo <owner/name>', 'repository (default: from GitHub env or git remote)')
  .option('--pr <n>', 'pull request number', (v) => Number(v))
  .option('--branch <name>', 'branch name when not a PR')
  .option('--run <id>', 'run id (default: GitHub run id or local-<timestamp>)')
  .option('--part <name>', 'name of this slice of the run, e.g. a CI shard; parts of one run are merged by the site')
  .option('--retention-days <n>', 'prune this repo\'s runs older than this', (v) => Number(v), 30)
  .action(async (o) => {
    const r = await publishCommand({ cwd: process.cwd(), site: o.site, repo: o.repo, pr: o.pr, branch: o.branch, run: o.run, part: o.part, retentionDays: o.retentionDays, log: (l) => console.log(l) });
    console.log(`\nPublished ${r.uploaded} files${r.pruned ? `, pruned ${r.pruned} old run(s)` : ''}.\n${r.url}`);
    if (process.env.GITHUB_ENV) await (await import('node:fs/promises')).appendFile(process.env.GITHUB_ENV, `REPORT_URL=${r.url}\nMANIFEST_URL=${r.manifestUrl}\n`);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
