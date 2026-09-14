import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_DIR } from './server.js';

export type ServerInfo = { port: number; token: string; pid: number; name?: string; testPath?: string };

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Returns the active session, cleaning up a stale file whose daemon is gone. */
export async function readServerInfo(cwd: string): Promise<ServerInfo | undefined> {
  const path = join(cwd, SESSION_DIR, 'server.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const info = JSON.parse(raw) as ServerInfo;
  if (!isAlive(info.pid)) {
    await rm(path, { force: true });
    return undefined;
  }
  return info;
}

export async function call<T = Record<string, unknown>>(cwd: string, path: string, body?: unknown): Promise<T> {
  const info = await readServerInfo(cwd);
  if (!info) throw new Error('No active session. Start one with `ete session start --name "<test name>"`.');
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: path === '/status' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
    body: path === '/status' ? undefined : JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `session request failed (${res.status})`);
  return json;
}
