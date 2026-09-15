import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { crawl, layoutScreens, type AppMap } from '@ete/core';
import { createBrowserDriver } from '@ete/driver-browser';
import { startApp } from '../app.js';
import { loadConfig } from '../config.js';
import { driverOptions } from './run.js';
import { detectAgents, runnerFor, type AgentName } from '../map/agents.js';
import { MAP_PATH, startMapServer } from '../map/server.js';

export type SetupOptions = {
  cwd: string;
  config?: string;
  url?: string;
  port?: number;
  agent?: AgentName;
  crawl?: boolean;        // default: true unless a map already exists
  maxScreens?: number;
  maxDepth?: number;
  open?: boolean;
  log?: (line: string) => void;
};

async function exists(p: string): Promise<boolean> { try { await access(p); return true; } catch { return false; } }

/**
 * A re-crawl must not throw away what the user did: positions, renames, notes, and every case
 * carry over (matched by screen signature); newly proposed cases are added only if their title is new.
 */
export function mergeMaps(prev: AppMap, fresh: AppMap): AppMap {
  const prevBySig = new Map(prev.screens.map((s) => [s.signature, s]));
  const screens = fresh.screens.map((s) => {
    const p = prevBySig.get(s.signature);
    return p ? { ...s, x: p.x, y: p.y, name: p.name, ...(p.notes ? { notes: p.notes } : {}) } : s;
  });
  const titles = new Set(prev.cases.map((c) => c.title));
  const cases = [...prev.cases, ...fresh.cases.filter((c) => !titles.has(c.title))];
  return { ...fresh, screens, cases };
}

export async function setupCommand(o: SetupOptions): Promise<{ url: string; map: AppMap; close: () => Promise<void> }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const cfg = await loadConfig(resolve(o.cwd, o.config ?? 'ete.yaml'));
  const mapAbs = join(o.cwd, MAP_PATH);
  const haveMap = await exists(mapAbs);
  const doCrawl = o.crawl ?? !haveMap;

  let map: AppMap;
  if (doCrawl) {
    const app = await startApp({ start: cfg.start, url: o.url ?? cfg.url, readyTimeout: cfg.readyTimeout, log });
    try {
      log(`Mapping ${app.url} …`);
      await mkdir(join(o.cwd, 'e2e'), { recursive: true });
      map = await crawl({
        driver: createBrowserDriver(driverOptions(cfg)), baseUrl: app.url, outDir: join(o.cwd, 'e2e'),
        limits: { maxScreens: o.maxScreens ?? 40, maxDepth: o.maxDepth ?? 4 }, log: (l) => log(`  ${l}`),
      });
    } finally { await app.stop(); }
    layoutScreens(map);
    if (haveMap) {
      const prev = JSON.parse(await (await import('node:fs/promises')).readFile(mapAbs, 'utf8')) as AppMap;
      map = mergeMaps(prev, map);
      log(`Merged with the existing map: kept ${prev.cases.length} case(s) and your positions.`);
    }
    await writeFile(mapAbs, JSON.stringify(map, null, 2) + '\n');
    log(`Wrote ${MAP_PATH}: ${map.screens.length} screens, ${map.edges.length} transitions, ${map.cases.length} proposed cases.`);
  } else {
    map = JSON.parse(await (await import('node:fs/promises')).readFile(mapAbs, 'utf8')) as AppMap;
    log(`Using existing ${MAP_PATH} (${map.screens.length} screens). Pass --crawl to map again.`);
  }

  const agents = await detectAgents();
  const agent = o.agent ?? agents[0];
  if (!agent) log('No agent CLI found (claude or codex); the canvas will work but "Ask agent" and "Run" need one on PATH.');
  else log(`Agent: ${agent}`);
  const server = await startMapServer({ cwd: o.cwd, agent: runnerFor(agent ?? 'claude'), port: o.port ?? 4747, log });
  log(`\nApp map: ${server.url}`);
  if (o.open ?? true) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [server.url], { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).unref();
  }
  return { url: server.url, map, close: server.close };
}
