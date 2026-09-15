import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, writeFile, watch } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { AppMap } from '@ete/core';
import { buildPrompt, recordCasePrompt } from './prompt.js';
import type { AgentRunner } from './agents.js';
export type { AgentRunner } from './agents.js';

export const MAP_PATH = join('e2e', 'map.json');

export type MapServerOptions = {
  cwd: string;
  agent: AgentRunner;
  port?: number;
  /** Runs the replay after recording; default calls `ete run`. Returns the exit code. */
  runTests?: (o: { cwd: string; onLine: (l: string) => void }) => Promise<number>;
  /** Opens the report after a run; default `ete report`. */
  openReport?: (cwd: string) => Promise<void>;
  log?: (line: string) => void;
};

export type MapServer = { port: number; url: string; close: () => Promise<void> };

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const c of req) body += c;
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function sseStart(res: ServerResponse): (event: Record<string, unknown>) => void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  return (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export async function startMapServer(o: MapServerOptions): Promise<MapServer> {
  const log = o.log ?? (() => {});
  const mapAbs = join(o.cwd, MAP_PATH);
  const canvasHtml = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'canvas.html'), 'utf8');
  const loadMap = async (): Promise<AppMap> => JSON.parse(await readFile(mapAbs, 'utf8')) as AppMap;
  const saveMap = async (m: AppMap) => writeFile(mapAbs, JSON.stringify(m, null, 2) + '\n');

  // Live updates: any change to map.json (by the canvas or the agent) is pushed to open canvases.
  const listeners = new Set<(ev: Record<string, unknown>) => void>();
  const broadcast = (ev: Record<string, unknown>) => { for (const l of listeners) l(ev); };
  const ac = new AbortController();
  (async () => {
    try {
      for await (const _ of watch(mapAbs, { signal: ac.signal })) broadcast({ type: 'map-changed' });
    } catch { /* closed */ }
  })();

  const runTests = o.runTests ?? (async ({ cwd, onLine }) => {
    const { runCommand } = await import('../commands/run.js');
    return runCommand({ cwd, files: [], workers: 2, log: onLine });
  });
  const openReport = o.openReport ?? (async (cwd) => {
    const { reportCommand } = await import('../commands/report.js');
    await reportCommand({ cwd, open: true });
  });

  let busy = false;

  const http: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(canvasHtml);
      }
      if (req.method === 'GET' && path === '/api/map') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(await loadMap()));
      }
      if (req.method === 'PUT' && path === '/api/map') {
        const m = (await readJson(req)) as unknown as AppMap;
        if (m.version !== 1 || !Array.isArray(m.screens)) { res.writeHead(400); return res.end('invalid map'); }
        await saveMap(m);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      }
      if (req.method === 'GET' && path.startsWith('/shots/')) {
        const file = join(o.cwd, 'e2e', '.map', path.slice('/shots/'.length).replace(/[^a-z0-9._-]/gi, ''));
        try {
          const buf = await readFile(file);
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(buf);
        } catch { res.writeHead(404); return res.end('no such screenshot'); }
      }
      if (req.method === 'GET' && path === '/api/events') {
        const send = sseStart(res);
        listeners.add(send);
        req.on('close', () => listeners.delete(send));
        return;
      }
      if (req.method === 'POST' && path === '/api/prompt') {
        const { text } = await readJson(req);
        if (typeof text !== 'string' || !text.trim()) { res.writeHead(400); return res.end('text required'); }
        if (busy) { res.writeHead(409); return res.end('an agent task is already running'); }
        busy = true;
        const send = sseStart(res);
        try {
          const prompt = buildPrompt(await loadMap(), text.trim(), MAP_PATH);
          send({ type: 'start', task: 'prompt' });
          const r = await o.agent({ prompt, cwd: o.cwd, onLine: (line) => send({ type: 'line', line }) });
          send({ type: 'done', ok: r.ok, error: r.error });
        } finally { busy = false; res.end(); }
        return;
      }
      if (req.method === 'POST' && path === '/api/run') {
        if (busy) { res.writeHead(409); return res.end('an agent task is already running'); }
        busy = true;
        const send = sseStart(res);
        try {
          let map = await loadMap();
          const proposed = map.cases.filter((c) => c.status === 'proposed');
          send({ type: 'start', task: 'run', cases: proposed.length });
          // Record proposed cases: a few at a time, each in its own named session.
          const limit = 3;
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(limit, proposed.length) }, async () => {
            for (;;) {
              const c = proposed[next++];
              if (!c) return;
              send({ type: 'line', line: `▶ recording: ${c.title}` });
              const r = await o.agent({ prompt: recordCasePrompt(map, c, `case-${c.id.replace(/[^a-z0-9_-]/gi, '')}`), cwd: o.cwd, onLine: (line) => send({ type: 'line', line: `[${c.id}] ${line}` }) });
              send({ type: 'line', line: r.ok ? `✓ recorded: ${c.title}` : `✗ could not record: ${c.title} (${r.error ?? 'agent failed'})` });
            }
          }));
          // Mark recorded cases by matching saved test names.
          map = await loadMap();
          const { readdirSync } = await import('node:fs');
          const tests = walkYaml(join(o.cwd, 'e2e'), readdirSync).map((p) => p.slice(o.cwd.length + 1));
          for (const c of map.cases) {
            const slug = c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
            const hit = tests.find((t) => t.endsWith(`/${slug}.yaml`));
            if (hit) { c.test = hit; if (c.status === 'proposed') c.status = 'recorded'; }
          }
          await saveMap(map);
          send({ type: 'line', line: '▶ replaying all tests' });
          const code = await runTests({ cwd: o.cwd, onLine: (line) => send({ type: 'line', line }) });
          // Case statuses from the replay reports.
          const { collectReports } = await import('@ete/core');
          const reports = await collectReports(join(o.cwd, 'ete-results'));
          map = await loadMap();
          for (const c of map.cases) {
            const r = reports.find((x) => x.file === c.test);
            if (r) c.status = r.status;
          }
          await saveMap(map);
          send({ type: 'line', line: code === 0 ? '✓ all tests passed' : '✗ some tests failed' });
          await openReport(o.cwd).catch(() => {});
          send({ type: 'done', ok: code === 0 });
        } finally { busy = false; res.end(); }
        return;
      }
      res.writeHead(404); res.end('not found');
    } catch (err) {
      log(`map server error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end(err instanceof Error ? err.message : String(err));
    }
  });

  await new Promise<void>((r) => http.listen(o.port ?? 4747, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    url: `http://localhost:${port}`,
    close: async () => { ac.abort(); http.closeAllConnections(); await new Promise<void>((r) => http.close(() => r())); },
  };
}

function walkYaml(dir: string, readdirSync: typeof import('node:fs').readdirSync): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[] = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '.resolved' || e.name === '.map') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkYaml(p, readdirSync));
    else if (e.name.endsWith('.yaml')) out.push(p);
  }
  return out;
}

