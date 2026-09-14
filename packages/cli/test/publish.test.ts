import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishRun, runPrefix, type BlobClient } from '../src/commands/publish.js';

function fakeBlob(existing: Record<string, string> = {}) {
  const store = new Map<string, Buffer>(Object.entries(existing).map(([k, v]) => [k, Buffer.from(v)]));
  const deleted: string[] = [];
  const client: BlobClient = {
    async put(pathname, body) { store.set(pathname, Buffer.isBuffer(body) ? body : Buffer.from(body)); return { url: `https://blob.test/${pathname}` }; },
    async list({ prefix, mode }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix ?? ''));
      if (mode === 'folded') {
        const folders = new Set(keys.map((k) => k.slice(0, k.indexOf('/', (prefix ?? '').length) + 1)).filter(Boolean));
        return { blobs: [], folders: [...folders], hasMore: false };
      }
      return { blobs: keys.map((k) => ({ pathname: k, url: `https://blob.test/${k}`, uploadedAt: new Date() })), folders: [], hasMore: false };
    },
    async del(urls) { for (const u of urls) { const k = u.replace('https://blob.test/', ''); store.delete(k); deleted.push(k); } },
    async getJson(url) { return JSON.parse(store.get(url.replace('https://blob.test/', ''))!.toString()); },
  };
  return { client, store, deleted };
}

async function results(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'ete-pub-'));
  const dir = join(cwd, 'ete-results', 'sign-in');
  await mkdir(join(dir, 'steps'), { recursive: true });
  await writeFile(join(dir, 'video.webm'), 'v');
  await writeFile(join(dir, 'trace.zip'), 'z');
  await writeFile(join(dir, 'filmstrip.png'), 'f');
  await writeFile(join(dir, 'steps', '01.png'), 'p1');
  await writeFile(join(dir, 'steps', '02.png'), 'p2');
  await writeFile(join(dir, 'report.json'), JSON.stringify({
    name: 'Sign in', file: 'e2e/login/sign-in.yaml', flow: 'Login', mode: 'replay', status: 'failed', durationMs: 1200, anomalyCount: 1,
    recording: { videoPath: 'video.webm', tracePath: 'trace.zip', filmstripPath: 'filmstrip.png' },
    steps: [
      { index: 1, text: 'go to /', kind: 'action', status: 'passed', durationMs: 100, screenshot: 'steps/01.png', anomalies: [{ t: 1, kind: 'console-error', message: 'x' }] },
      { index: 2, text: 'click Sign in', kind: 'action', status: 'failed', durationMs: 100, screenshot: 'steps/02.png', error: 'Timeout', anomalies: [] },
    ],
  }));
  await mkdir(join(cwd, 'ete-results', '.session'), { recursive: true });
  await writeFile(join(cwd, 'ete-results', 'index.html'), '<html>');
  return cwd;
}

describe('runPrefix', () => {
  it('builds the blob prefix for a pr or a branch', () => {
    expect(runPrefix({ owner: 'acme', repo: 'shop', ref: { kind: 'pr', number: 5 }, runId: '42' })).toBe('runs/acme/shop/pr-5/42/');
    expect(runPrefix({ owner: 'acme', repo: 'shop', ref: { kind: 'branch', name: 'feat/x' }, runId: 'local-1' })).toBe('runs/acme/shop/branch-feat-x/local-1/');
  });
});

describe('publishRun', () => {
  it('uploads every result file, writes a manifest, and returns the run url', async () => {
    const cwd = await results();
    const { client, store } = fakeBlob();
    const out = await publishRun({
      cwd, blob: client, owner: 'acme', repo: 'shop', ref: { kind: 'pr', number: 5 }, runId: '42', attempt: '1', commit: 'abc', branch: 'feat',
      source: 'ci', siteUrl: 'https://ete-reports.vercel.app', now: new Date('2026-09-14T22:00:00Z'),
    });
    expect(out.url).toBe('https://ete-reports.vercel.app/acme/shop/pr-5/42');
    const keys = [...store.keys()].sort();
    expect(keys).toEqual([
      'runs/acme/shop/pr-5/42/manifests/all.json',
      'runs/acme/shop/pr-5/42/sign-in/filmstrip.png',
      'runs/acme/shop/pr-5/42/sign-in/report.json',
      'runs/acme/shop/pr-5/42/sign-in/steps/01.png',
      'runs/acme/shop/pr-5/42/sign-in/steps/02.png',
      'runs/acme/shop/pr-5/42/sign-in/trace.zip',
      'runs/acme/shop/pr-5/42/sign-in/video.webm',
    ]);
    const manifest = JSON.parse(store.get('runs/acme/shop/pr-5/42/manifests/all.json')!.toString());
    expect(manifest).toMatchObject({
      version: 1, owner: 'acme', repo: 'shop', ref: { kind: 'pr', number: 5 }, runId: '42', attempt: '1', commit: 'abc', branch: 'feat',
      publishedAt: '2026-09-14T22:00:00.000Z', source: 'ci', totals: { tests: 1, passed: 0, anomalies: 1 },
    });
    expect(manifest.tests[0]).toMatchObject({
      dir: 'sign-in', name: 'Sign in', flow: 'Login', status: 'failed', durationMs: 1200, anomalyCount: 1, steps: 2,
      failedStep: { index: 2, text: 'click Sign in', error: 'Timeout', screenshot: 'https://blob.test/runs/acme/shop/pr-5/42/sign-in/steps/02.png' },
      blobs: { report: 'https://blob.test/runs/acme/shop/pr-5/42/sign-in/report.json', video: 'https://blob.test/runs/acme/shop/pr-5/42/sign-in/video.webm', trace: 'https://blob.test/runs/acme/shop/pr-5/42/sign-in/trace.zip' },
    });
    expect(manifest.tests[0].blobs.screenshots['steps/01.png']).toBe('https://blob.test/runs/acme/shop/pr-5/42/sign-in/steps/01.png');
    expect(out.manifest).toEqual(manifest);
    expect(out.manifestUrl).toBe('https://ete-reports.vercel.app/acme/shop/pr-5/42/manifest.json');
  });

  it('prunes runs older than the retention window for the same repo only', async () => {
    const cwd = await results();
    const old = new Date('2026-07-01T00:00:00Z').toISOString();
    const recent = new Date('2026-09-10T00:00:00Z').toISOString();
    const { client, deleted } = fakeBlob({
      'runs/acme/shop/pr-1/old/manifests/all.json': JSON.stringify({ publishedAt: old }),
      'runs/acme/shop/pr-1/old/t/video.webm': 'v',
      'runs/acme/shop/pr-2/recent/manifests/1-2.json': JSON.stringify({ publishedAt: old }),
      'runs/acme/shop/pr-2/recent/manifests/2-2.json': JSON.stringify({ publishedAt: recent }),
      'runs/acme/other/pr-9/ancient/manifests/all.json': JSON.stringify({ publishedAt: old }),
    });
    const out = await publishRun({ cwd, blob: client, owner: 'acme', repo: 'shop', ref: { kind: 'pr', number: 5 }, runId: '42', source: 'ci', siteUrl: 'https://s', retentionDays: 30, now: new Date('2026-09-14T00:00:00Z') });
    expect(out.pruned).toBe(1);
    expect(deleted.sort()).toEqual(['runs/acme/shop/pr-1/old/manifests/all.json', 'runs/acme/shop/pr-1/old/t/video.webm']);
  });
});

describe('publishRun parts (sharded runs)', () => {
  it('writes its own manifest part and never touches other parts', async () => {
    const cwd = await results();
    const { client, store } = fakeBlob({ 'runs/acme/shop/pr-5/42/manifests/1-2.json': JSON.stringify({ tests: [{ dir: 'checkout' }] }) });
    const out = await publishRun({ cwd, blob: client, owner: 'acme', repo: 'shop', ref: { kind: 'pr', number: 5 }, runId: '42', source: 'ci', siteUrl: 'https://s', part: '2/2', now: new Date('2026-09-14T22:00:00Z') });
    expect([...store.keys()].filter((k) => k.includes('/manifests/')).sort()).toEqual(['runs/acme/shop/pr-5/42/manifests/1-2.json', 'runs/acme/shop/pr-5/42/manifests/2-2.json']);
    expect(JSON.parse(store.get('runs/acme/shop/pr-5/42/manifests/1-2.json')!.toString())).toEqual({ tests: [{ dir: 'checkout' }] });
    expect(out.manifest.tests.map((t) => t.dir)).toEqual(['sign-in']);
    expect(out.manifestUrl).toBe('https://s/acme/shop/pr-5/42/manifest.json');
  });
});

describe('publishRun keeps only the newest N runs per ref', () => {
  it('prunes older runs of the same ref beyond keepPerRef, regardless of age', async () => {
    const cwd = await results();
    const day = (n: number) => new Date(Date.UTC(2026, 8, n)).toISOString();
    const { client, deleted } = fakeBlob({
      'runs/acme/shop/pr-5/r1/manifests/all.json': JSON.stringify({ publishedAt: day(10) }),
      'runs/acme/shop/pr-5/r1/t/video.webm': 'v',
      'runs/acme/shop/pr-5/r2/manifests/all.json': JSON.stringify({ publishedAt: day(11) }),
      'runs/acme/shop/pr-5/r3/manifests/all.json': JSON.stringify({ publishedAt: day(12) }),
      'runs/acme/shop/pr-6/other/manifests/all.json': JSON.stringify({ publishedAt: day(1) }),
    });
    const out = await publishRun({ cwd, blob: client, owner: 'acme', repo: 'shop', ref: { kind: 'pr', number: 5 }, runId: 'r4', source: 'ci', siteUrl: 'https://s', retentionDays: 365, keepPerRef: 2, now: new Date(day(14)) });
    // r4 (new) + r3 kept; r1 and r2 pruned; pr-6 untouched by the per-ref rule
    expect(out.pruned).toBe(2);
    expect(deleted.some((k) => k.startsWith('runs/acme/shop/pr-5/r1/'))).toBe(true);
    expect(deleted.some((k) => k.startsWith('runs/acme/shop/pr-5/r2/'))).toBe(true);
    expect(deleted.some((k) => k.startsWith('runs/acme/shop/pr-5/r3/'))).toBe(false);
    expect(deleted.some((k) => k.startsWith('runs/acme/shop/pr-6/'))).toBe(false);
  });
});
