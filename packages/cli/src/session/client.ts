import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_ROOT, sessionDirFor } from './server.js';

export type ServerInfo = { id: string; port: number; token: string; pid: number; name?: string; testPath?: string };

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readInfo(cwd: string, id: string): Promise<ServerInfo | undefined> {
  const path = join(sessionDirFor(cwd, id), 'server.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const info = { id, ...(JSON.parse(raw) as Omit<ServerInfo, 'id'>) };
  if (!isAlive(info.pid)) {
    await rm(path, { force: true });
    return undefined;
  }
  return info;
}

/** All live sessions in this project (stale server.json files are cleaned up). */
export async function listSessions(cwd: string): Promise<ServerInfo[]> {
  let ids: string[] = [];
  try {
    ids = (await readdir(join(cwd, SESSION_ROOT), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const infos = await Promise.all(ids.sort().map((id) => readInfo(cwd, id)));
  return infos.filter((i): i is ServerInfo => Boolean(i));
}

/**
 * Resolves the session to talk to: the given id, or the only live session when none is given.
 * With several live sessions and no id, refuses rather than guessing.
 */
export async function readServerInfo(cwd: string, id?: string): Promise<ServerInfo | undefined> {
  if (id) return readInfo(cwd, id);
  const all = await listSessions(cwd);
  if (all.length > 1) throw new Error(`${all.length} sessions are active (${all.map((s) => s.id).join(', ')}); pass --id <session>.`);
  return all[0];
}

export async function call<T = Record<string, unknown>>(cwd: string, path: string, body?: unknown, id?: string): Promise<T> {
  const info = await readServerInfo(cwd, id);
  if (!info) throw new Error(`No active session${id ? ` "${id}"` : ''}. Start one with \`ete session start --name "<test name>"\`.`);
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: path === '/status' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
    body: path === '/status' ? undefined : JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `session request failed (${res.status})`);
  return json;
}
