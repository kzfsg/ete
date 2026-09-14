import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedAction, ResolvedAssertion, StepReport, Target } from '@ete/core';
import { call, listSessions, readServerInfo } from '../session/client.js';
import { DEFAULT_SESSION_ID, sessionDirFor, startSessionServer, type Observation } from '../session/server.js';

// ---- argv parsing ----------------------------------------------------------

function target(s: string): Target {
  const m = /^(\d+),(\d+)$/.exec(s);
  return m ? { point: { x: Number(m[1]), y: Number(m[2]) } } : { selector: s };
}

export function parseAct(argv: string[]): ResolvedAction {
  const [verb, ...rest] = argv;
  const usage = (u: string) => new Error(`usage: ete session act ${u}`);
  switch (verb) {
    case 'goto': case 'navigate': case 'open':
      if (rest.length !== 1) throw usage('goto <path-or-url>');
      return { kind: 'navigate', url: rest[0]! };
    case 'click':
      if (rest.length !== 1) throw usage('click <selector|x,y>');
      return { kind: 'click', target: target(rest[0]!) };
    case 'type': case 'fill':
      if (rest.length !== 2) throw usage('type <selector|x,y> <text>');
      return { kind: 'type', target: target(rest[0]!), text: rest[1]! };
    case 'press':
      if (rest.length !== 1) throw usage('press <key>');
      return { kind: 'press', key: rest[0]! };
    case 'scroll': {
      if (rest.length < 1 || rest.length > 2 || Number.isNaN(Number(rest[0]))) throw usage('scroll <dy> [selector]');
      const a: ResolvedAction = { kind: 'scroll', dy: Number(rest[0]) };
      if (rest[1]) a.target = target(rest[1]);
      return a;
    }
    case 'wait':
      if (rest.length !== 1 || Number.isNaN(Number(rest[0]))) throw usage('wait <ms>');
      return { kind: 'wait', ms: Number(rest[0]) };
    default:
      throw new Error(`Unknown action "${verb ?? ''}". Actions: goto, click, type, press, scroll, wait.`);
  }
}

export function parseExpect(argv: string[]): ResolvedAssertion {
  const [what, ...rest] = argv;
  const usage = (u: string) => new Error(`usage: ete session expect ${u}`);
  switch (what) {
    case 'text':
      if (rest.length !== 1) throw usage('text <visible text>');
      return { kind: 'textVisible', text: rest[0]! };
    case 'visible':
      if (rest.length !== 1) throw usage('visible <selector>');
      return { kind: 'elementVisible', target: target(rest[0]!) };
    case 'url':
      if (rest.length !== 1) throw usage('url <regex>');
      return { kind: 'urlMatches', pattern: rest[0]! };
    default:
      throw new Error(`Unknown assertion "${what ?? ''}". Assertions: text, visible, url.`);
  }
}

// ---- output ----------------------------------------------------------------

export function formatObservation(o: Observation): string {
  const lines = [`URL: ${o.url ?? 'unknown'}`, `Screenshot: ${o.screenshot}`];
  if (o.a11yTree) lines.push('Accessibility tree:', o.a11yTree);
  return lines.join('\n');
}

export function formatSteps(steps: StepReport[]): string {
  if (!steps.length) return '(no steps recorded yet)';
  return steps.map((s) => `${s.status === 'failed' ? '✗' : '✓'} ${s.index}. ${s.kind === 'expect' ? 'expect: ' : ''}${s.text}${s.error ? ` — ${s.error.split('\n')[0]}` : ''}`).join('\n');
}

function formatResult(r: { ok: boolean; recorded: boolean; error?: string; step?: StepReport; telemetry?: { anomalies: { kind: string; message: string }[] } }): string {
  const lines: string[] = [];
  if (r.recorded && r.step) lines.push(`${r.ok ? '✓' : '✗'} recorded step ${r.step.index}: ${r.step.kind === 'expect' ? 'expect: ' : ''}${r.step.text}`);
  else lines.push(`✗ not recorded${r.error ? `: ${r.error.split('\n')[0]}` : ''}`);
  for (const a of r.telemetry?.anomalies ?? []) lines.push(`  ⚠️ ${a.kind}: ${a.message}`);
  return lines.join('\n');
}

// ---- commands --------------------------------------------------------------

export type StartOptions = { cwd: string; id?: string; port?: number; name?: string; flow?: string; out?: string; from?: string; at?: number; config?: string; url?: string; headed?: boolean; bin: string };

/** Spawns the detached daemon and waits until it is ready. Returns the first observation. */
export async function sessionStart(o: StartOptions): Promise<string> {
  const id = o.id ?? DEFAULT_SESSION_ID;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error(`Invalid session id "${id}": use letters, digits, dots, dashes, underscores.`);
  if ((await listSessions(o.cwd)).some((s) => s.id === id)) throw new Error(`Session "${id}" is already active. Finish it with \`ete session save --id ${id}\` or \`ete session abort --id ${id}\`.`);
  const dir = sessionDirFor(o.cwd, id);
  await mkdir(dir, { recursive: true });
  const logFile = await open(join(dir, 'daemon.log'), 'w');
  const args = [o.bin, 'session', 'serve', '--id', id];
  if (o.port !== undefined) args.push('--port', String(o.port));
  if (o.name) args.push('--name', o.name);
  if (o.flow) args.push('--flow', o.flow);
  if (o.out) args.push('--out', o.out);
  if (o.from) args.push('--from', o.from);
  if (o.at !== undefined) args.push('--at', String(o.at));
  if (o.config) args.push('--config', o.config);
  if (o.url) args.push('--url', o.url);
  if (o.headed) args.push('--headed');
  const child = spawn(process.execPath, args, { cwd: o.cwd, detached: true, stdio: ['ignore', logFile.fd, logFile.fd] });
  child.unref();
  await logFile.close();

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const log = await readFile(join(dir, 'daemon.log'), 'utf8').catch(() => '');
      throw new Error(`Session failed to start:\n${log.trim() || `daemon exited with code ${child.exitCode}`}`);
    }
    const info = await readServerInfo(o.cwd, id);
    if (info) {
      const st = await call<{ name: string; flow: string; testPath: string; steps: StepReport[]; observation: Observation }>(o.cwd, '/status', undefined, id);
      const head = [`Session started: "${st.name}" (${st.flow}) → ${st.testPath}${id !== DEFAULT_SESSION_ID ? `  [--id ${id}]` : ''}`];
      if (st.steps.length) head.push(`Replayed ${st.steps.length} step(s):`, formatSteps(st.steps));
      return [...head, '', formatObservation(st.observation)].join('\n');
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Timed out waiting for the session to start. See ete-results/.session/daemon.log');
}

/** Runs the daemon in this process (spawned by `sessionStart`). */
export async function sessionServe(o: Omit<StartOptions, 'bin'>): Promise<void> {
  const server = await startSessionServer({ ...o, log: (l) => console.log(l) });
  const stop = () => server.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Poll for shutdown: the server removes server.json when saved/aborted.
  const dir = sessionDirFor(o.cwd, o.id ?? DEFAULT_SESSION_ID);
  const tick = async () => {
    try {
      await readFile(join(dir, 'server.json'));
      setTimeout(tick, 500);
    } catch {
      process.exit(0);
    }
  };
  setTimeout(tick, 1000);
}

export async function sessionAct(cwd: string, argv: string[], as?: string, id?: string): Promise<{ ok: boolean; text: string }> {
  const entry = parseAct(argv);
  const r = await call<{ result: Parameters<typeof formatResult>[0]; observation: Observation }>(cwd, '/act', { entry, as }, id);
  return { ok: r.result.ok, text: `${formatResult(r.result)}\n\n${formatObservation(r.observation)}` };
}

export async function sessionExpect(cwd: string, argv: string[], as?: string, record?: boolean, id?: string): Promise<{ ok: boolean; text: string }> {
  const assertion = parseExpect(argv);
  const r = await call<{ result: Parameters<typeof formatResult>[0]; observation: Observation }>(cwd, '/expect', { assertion, as, record }, id);
  return { ok: r.result.ok, text: `${formatResult(r.result)}\n\n${formatObservation(r.observation)}` };
}

export async function sessionObserve(cwd: string, id?: string): Promise<string> {
  const r = await call<{ observation: Observation }>(cwd, '/observe', undefined, id);
  return formatObservation(r.observation);
}

export async function sessionStatus(cwd: string, id?: string): Promise<string> {
  const st = await call<{ id: string; name: string; flow: string; testPath: string; steps: StepReport[]; observation: Observation }>(cwd, '/status', undefined, id);
  return [`Session${st.id !== DEFAULT_SESSION_ID ? ` [${st.id}]` : ''}: "${st.name}" (${st.flow}) → ${st.testPath}`, formatSteps(st.steps), '', formatObservation(st.observation)].join('\n');
}

export async function sessionUndo(cwd: string, id?: string): Promise<string> {
  const r = await call<{ dropped?: StepReport; steps: StepReport[] }>(cwd, '/undo', undefined, id);
  return r.dropped ? `Dropped step ${r.dropped.index}: ${r.dropped.text} (browser state unchanged)\n${formatSteps(r.steps)}` : 'Nothing to undo.';
}

export async function sessionSave(cwd: string, id?: string): Promise<string> {
  const r = await call<{ testPath: string; resolvedPath: string; resultsDir: string; report: { status: string; steps: StepReport[]; anomalyCount: number } }>(cwd, '/save', undefined, id);
  return [
    `Saved ${r.testPath} and ${r.resolvedPath} (${r.report.steps.length} steps, ${r.report.status}${r.report.anomalyCount ? `, ${r.report.anomalyCount} anomalies` : ''}).`,
    `Recording in ${r.resultsDir}/. Verify the replay with: ete run ${r.testPath}`,
  ].join('\n');
}

export async function sessionAbort(cwd: string, id?: string): Promise<string> {
  await call(cwd, '/abort', undefined, id);
  return 'Session aborted; nothing was saved.';
}

export async function sessionList(cwd: string): Promise<string> {
  const all = await listSessions(cwd);
  if (!all.length) return 'No active sessions.';
  return all.map((s) => `${s.id}  "${s.name ?? ''}" → ${s.testPath ?? ''}  (pid ${s.pid})`).join('\n');
}
