import { spawn, type ChildProcess } from 'node:child_process';

export type AppHandle = { stop(): Promise<void> };

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

export async function startApp(opts: { start?: string; url: string; readyTimeout: number; log?: (line: string) => void }): Promise<AppHandle> {
  if (!opts.start) {
    await waitForUrl(opts.url, opts.readyTimeout);
    return { stop: async () => {} };
  }
  const chunks: string[] = [];
  const child: ChildProcess = spawn(opts.start, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
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
    await waitForUrl(opts.url, opts.readyTimeout, () => chunks.join('').slice(-4000));
  } catch (err) {
    await stop();
    throw err;
  }
  return { stop };
}
