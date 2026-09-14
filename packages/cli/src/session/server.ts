import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import YAML from 'yaml';
import {
  Recorder,
  ResolvedActionSchema,
  ResolvedAssertionSchema,
  flowFor,
  hashStep,
  loadResolved,
  parseTestFile,
  resolvedPathFor,
  resultsDirName,
  saveResolved,
  writeReport,
  type Driver,
  type ResolvedEntry,
  type Step,
  type StepReport,
  type TestFile,
} from '@ete/core';
import { createBrowserDriver } from '@ete/driver-browser';
import { startApp, type AppHandle } from '../app.js';
import { loadConfig } from '../config.js';
import { RESULTS_DIR, writeFilmstrip } from '../commands/run.js';

export const SESSION_DIR = join(RESULTS_DIR, '.session');

export type SessionServerOptions = {
  cwd: string;
  name?: string;
  flow?: string;
  out?: string;
  /** Resume: replay steps 1..at-1 of this test, then record from `at`. */
  from?: string;
  at?: number;
  config?: string;
  url?: string;
  headed?: boolean;
  createDriver?: () => Driver;
  log?: (line: string) => void;
};

export type SessionServer = { port: number; token: string; close: () => Promise<void> };

export type Observation = { url?: string; a11yTree?: string; screenshot: string };

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'test';
}

export function toYaml(test: TestFile): string {
  return YAML.stringify({
    name: test.name,
    ...(test.flow ? { flow: test.flow } : {}),
    steps: test.steps.map((s) => (s.kind === 'action' ? s.text : { expect: s.text })),
  });
}

type Json = Record<string, unknown>;

async function readJson(req: IncomingMessage): Promise<Json> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? (JSON.parse(body) as Json) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startSessionServer(o: SessionServerOptions): Promise<SessionServer> {
  const log = o.log ?? (() => {});
  const cfg = await loadConfig(resolve(o.cwd, o.config ?? 'ete.yaml'));
  const baseUrl = o.url ?? cfg.url;

  // Resolve what we are recording: a new test, or a resume of an existing one.
  let name: string;
  let flow: string | undefined;
  let testPath: string;
  let prefix: { steps: Step[]; entries: ResolvedEntry[] } | undefined;
  if (o.from) {
    const at = o.at ?? 1;
    const test = parseTestFile(await readFile(join(o.cwd, o.from), 'utf8'));
    const resolved = await loadResolved(join(o.cwd, resolvedPathFor(o.from)));
    if (at < 1 || at > test.steps.length + 1) throw new Error(`--at must be between 1 and ${test.steps.length + 1} for ${o.from}`);
    const steps = test.steps.slice(0, at - 1);
    const entries = steps.map((s) => {
      const e = resolved.steps[hashStep(s.text)];
      if (!e) throw new Error(`Cannot resume: step "${s.text}" has no recorded action. Use --at ${test.steps.indexOf(s) + 1}.`);
      return e;
    });
    name = test.name;
    flow = test.flow;
    testPath = o.from;
    prefix = { steps, entries };
  } else {
    if (!o.name) throw new Error('--name is required for a new session (or use --from <test> --at <step>)');
    name = o.name;
    flow = o.flow;
    testPath = o.out ?? (flow ? join('e2e', slugify(flow), `${slugify(name)}.yaml`) : join('e2e', `${slugify(name)}.yaml`));
  }

  const sessionDir = join(o.cwd, SESSION_DIR);
  await mkdir(sessionDir, { recursive: true });
  const resultsDir = join(sessionDir, 'recording');
  // Only clear our own artefacts; the client owns daemon.log.
  await Promise.all([rm(resultsDir, { recursive: true, force: true }), rm(join(sessionDir, 'server.json'), { force: true }), rm(join(sessionDir, 'observe.png'), { force: true })]);

  const app: AppHandle = await startApp({ start: cfg.start, url: baseUrl, readyTimeout: cfg.readyTimeout, log });
  const driver = (o.createDriver ?? (() => createBrowserDriver()))();
  const recorder = new Recorder({ driver, name, flow, testPath, baseUrl, resultsDir, headed: o.headed, prefix, log });
  try {
    await recorder.start();
    // A new session opens the app at "/" and records that as step 1 so the saved test is self-contained.
    if (!prefix) {
      const first = await recorder.act({ kind: 'navigate', url: '/' });
      if (!first.ok) throw new Error(`Could not open ${baseUrl}: ${first.error}`);
    }
  } catch (err) {
    await recorder.abort().catch(() => {});
    await app.stop();
    throw err;
  }

  const token = randomBytes(16).toString('hex');
  let closed = false;

  async function observe(): Promise<Observation> {
    const obs = await driver.observe();
    const screenshot = join(sessionDir, 'observe.png');
    await writeFile(screenshot, obs.screenshotPng);
    return { url: obs.url, a11yTree: obs.a11yTree, screenshot };
  }

  async function shutdown(): Promise<void> {
    if (closed) return;
    closed = true;
    await app.stop();
    await rm(join(sessionDir, 'server.json'), { force: true });
    // Close after the current response has been flushed; closing inside the handler would
    // wait for this very connection and deadlock.
    setImmediate(() => {
      http.closeAllConnections();
      http.close();
    });
  }

  async function save(): Promise<Json> {
    const { report, test, resolved } = await recorder.finish();
    const finalDir = join(o.cwd, RESULTS_DIR, resultsDirName(testPath));
    await rm(finalDir, { recursive: true, force: true });
    await mkdir(dirname(finalDir), { recursive: true });
    const { rename } = await import('node:fs/promises');
    await rename(resultsDir, finalDir);
    await writeFilmstrip(finalDir, report);
    await writeReport(finalDir, report);
    const testAbs = join(o.cwd, testPath);
    await mkdir(dirname(testAbs), { recursive: true });
    await writeFile(testAbs, toYaml(test));
    await saveResolved(join(o.cwd, resolvedPathFor(testPath)), resolved);
    await shutdown();
    return { testPath, resolvedPath: resolvedPathFor(testPath), resultsDir: join(RESULTS_DIR, resultsDirName(testPath)), report };
  }

  const http: Server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' });
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method === 'GET' && path === '/status') {
        return send(res, 200, { name, flow: flowFor(testPath, flow), testPath, steps: recorder.steps(), observation: await observe() });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const body = await readJson(req);
      switch (path) {
        case '/observe':
          return send(res, 200, { observation: await observe() });
        case '/act': {
          const entry = ResolvedActionSchema.parse(body.entry);
          const result = await recorder.act(entry, { as: typeof body.as === 'string' ? body.as : undefined });
          return send(res, 200, { result, observation: await observe() });
        }
        case '/expect': {
          const assertion = ResolvedAssertionSchema.parse(body.assertion);
          const result = await recorder.expect(assertion, { as: typeof body.as === 'string' ? body.as : undefined, record: body.record === true });
          return send(res, 200, { result, observation: await observe() });
        }
        case '/undo': {
          const dropped: StepReport | undefined = recorder.undo();
          return send(res, 200, { dropped, steps: recorder.steps() });
        }
        case '/save':
          return send(res, 200, await save());
        case '/abort':
          await recorder.abort();
          await shutdown();
          return send(res, 200, { aborted: true });
        default:
          return send(res, 404, { error: `unknown route ${path}` });
      }
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  await writeFile(join(sessionDir, 'server.json'), JSON.stringify({ port, token, pid: process.pid, name, testPath }));

  return {
    port,
    token,
    close: async () => {
      if (!closed) {
        await recorder.abort();
        await shutdown();
      }
    },
  };
}
