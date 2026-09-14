import { spawn, type ChildProcess } from 'node:child_process';

export type AppHandle = {
  stop(): Promise<void>;
  /** The URL actually used (after {port} substitution). */
  url: string;
  /** True when this handle started the app and will stop it; false when it was already running. */
  owned: boolean;
};

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function waitForUrl(url: string, timeoutMs: number, output?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const tail = output?.();
  throw new Error(
    `App at ${url} did not respond within ${timeoutMs} ms (last error: ${lastError})` +
      (tail ? `\n--- start command output ---\n${tail}` : ''),
  );
}

export type StartAppOptions = {
  start?: string;
  url: string;
  readyTimeout: number;
  /** When set, `{port}` in start/url is replaced and PORT is exported to the start command. */
  port?: number;
  log?: (line: string) => void;
};

export async function startApp(opts: StartAppOptions): Promise<AppHandle> {
  const sub = (v: string) => (opts.port !== undefined ? v.replace(/\{port\}/g, String(opts.port)) : v);
  const url = sub(opts.url);
  const start = opts.start ? sub(opts.start) : undefined;
  if (!start) {
    await waitForUrl(url, opts.readyTimeout);
    return { stop: async () => {}, url, owned: false };
  }
  // Another session or a dev server may already serve this URL: use it, and never stop it.
  if (await isUp(url)) {
    opts.log?.(`App already running at ${url}; not starting "${start}".`);
    return { stop: async () => {}, url, owned: false };
  }
  const chunks: string[] = [];
  const child: ChildProcess = spawn(start, {
    shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    env: opts.port !== undefined ? { ...process.env, PORT: String(opts.port) } : process.env,
  });
  const collect = (buf: Buffer) => {
    chunks.push(buf.toString());
    if (chunks.length > 200) chunks.shift();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise<void>((r) => child.once('exit', () => r()));
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  };
  try {
    await waitForUrl(url, opts.readyTimeout, () => chunks.join('').slice(-4000));
  } catch (err) {
    await stop();
    throw err;
  }
  return { stop, url, owned: true };
}
