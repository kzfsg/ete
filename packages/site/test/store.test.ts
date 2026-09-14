import { describe, it, expect } from 'vitest';
import { listFolders, listRuns, refLabel, type Lister } from '../lib/store';

const t = (dir: string, status: 'passed' | 'failed', anomalyCount = 0) => ({ dir, name: dir, flow: 'F', status, durationMs: 1, anomalyCount, steps: 1, blobs: { report: 'r', screenshots: {} } });
const files: Record<string, unknown> = {
  'runs/acme/shop/pr-5/42/manifests/1-2.json': { owner: 'acme', repo: 'shop', ref: { kind: 'pr', number: 5 }, runId: '42', publishedAt: '2026-09-14T10:00:00Z', totals: { tests: 1, passed: 1, anomalies: 0 }, tests: [t('a', 'passed')] },
  'runs/acme/shop/pr-5/42/manifests/2-2.json': { owner: 'acme', repo: 'shop', ref: { kind: 'pr', number: 5 }, runId: '42', publishedAt: '2026-09-14T10:05:00Z', totals: { tests: 2, passed: 1, anomalies: 3 }, tests: [t('b', 'failed', 3), t('c', 'passed')] },
  'runs/acme/shop/pr-5/41/manifests/all.json': { owner: 'acme', repo: 'shop', ref: { kind: 'pr', number: 5 }, runId: '41', publishedAt: '2026-09-13T10:00:00Z', totals: { tests: 1, passed: 0, anomalies: 2 }, tests: [t('a', 'failed', 2)] },
  'runs/acme/shop/pr-5/41/login/report.json': {},
  'runs/acme/shop/branch-main/7/manifests/all.json': { owner: 'acme', repo: 'shop', ref: { kind: 'branch', name: 'main' }, runId: '7', publishedAt: '2026-09-12T10:00:00Z', totals: { tests: 2, passed: 2, anomalies: 0 }, tests: [] },
  'runs/acme/other/pr-1/1/manifests/all.json': { owner: 'acme', repo: 'other', ref: { kind: 'pr', number: 1 }, runId: '1', publishedAt: '2026-09-01T10:00:00Z', totals: { tests: 1, passed: 1, anomalies: 0 }, tests: [] },
};
const list: Lister = async ({ prefix, mode }) => {
  const keys = Object.keys(files).filter((k) => k.startsWith(prefix));
  if (mode === 'folded') return { blobs: [], folders: [...new Set(keys.map((k) => k.slice(0, k.indexOf('/', prefix.length) + 1)))], hasMore: false };
  return { blobs: keys.map((k) => ({ pathname: k, url: `blob:${k}`, uploadedAt: new Date() })), hasMore: false };
};
const fetchJson = async (u: string) => files[u.replace('blob:', '')];

describe('store', () => {
  it('lists folders one level deep', async () => {
    expect(await listFolders(list, 'runs/')).toEqual(['acme']);
    expect(await listFolders(list, 'runs/acme/')).toEqual(['other', 'shop']);
    expect(await listFolders(list, 'runs/acme/shop/')).toEqual(['branch-main', 'pr-5']);
  });
  it('lists runs under a prefix newest first, ignoring non-manifest files', async () => {
    const runs = await listRuns(list, 'runs/acme/shop/', fetchJson);
    expect(runs.map((r) => r.runId)).toEqual(['42', '41', '7']);
    expect(runs[0].path).toBe('runs/acme/shop/pr-5/42');
    expect((await listRuns(list, 'runs/acme/shop/pr-5/', fetchJson)).length).toBe(2);
  });
  it('merges the parts of a sharded run: union of tests, recomputed totals, newest timestamp', async () => {
    const [run] = await listRuns(list, 'runs/acme/shop/pr-5/42/', fetchJson);
    expect(run.tests.map((x) => x.dir)).toEqual(['a', 'b', 'c']);
    expect(run.totals).toEqual({ tests: 3, passed: 2, anomalies: 3 });
    expect(run.publishedAt).toBe('2026-09-14T10:05:00Z');
  });
  it('labels refs', () => {
    expect(refLabel({ kind: 'pr', number: 5 })).toBe('PR #5');
    expect(refLabel({ kind: 'branch', name: 'main' })).toBe('main');
  });
});
