import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startApp, waitForUrl } from '../src/app.js';

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('waitForUrl', () => {
  it('resolves once the url responds', async () => {
    const s = createServer((_, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>((r) => s.listen(0, r));
    const url = `http://localhost:${(s.address() as AddressInfo).port}/`;
    await expect(waitForUrl(url, 2000)).resolves.toBeUndefined();
    await new Promise<void>((r) => s.close(() => r()));
  });
  it('rejects after the timeout', async () => {
    const port = await freePort();
    await expect(waitForUrl(`http://localhost:${port}/`, 500)).rejects.toThrow(/did not respond/);
  });
});

describe('startApp', () => {
  it('spawns the start command and waits for the url, then stops it', async () => {
    const port = await freePort();
    const app = await startApp({
      start: `node -e "setTimeout(()=>require('http').createServer((q,s)=>{s.end('hi')}).listen(${port}),300)"`,
      url: `http://localhost:${port}/`,
      readyTimeout: 5000,
    });
    const res = await fetch(`http://localhost:${port}/`);
    expect(await res.text()).toBe('hi');
    await app.stop();
    await expect(waitForUrl(`http://localhost:${port}/`, 300)).rejects.toThrow();
  });
  it('includes the command output in the timeout error', async () => {
    const port = await freePort();
    await expect(startApp({
      start: `node -e "console.log('booting'); setTimeout(()=>{}, 100000)"`,
      url: `http://localhost:${port}/`,
      readyTimeout: 800,
    })).rejects.toThrow(/did not respond[\s\S]*booting/);
  });
  it('returns a no-op when no start command is configured', async () => {
    const s = createServer((_, res) => { res.writeHead(200); res.end(); });
    await new Promise<void>((r) => s.listen(0, r));
    const url = `http://localhost:${(s.address() as AddressInfo).port}/`;
    const app = await startApp({ url, readyTimeout: 1000 });
    await app.stop();
    await new Promise<void>((r) => s.close(() => r()));
  });
});
