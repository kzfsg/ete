import type { RunManifest } from '@ete/core';

/** Minimal blob listing surface, injectable for tests. */
export type Lister = (opts: { prefix: string; mode?: 'folded' | 'expanded'; cursor?: string; limit?: number }) => Promise<{
  blobs: { pathname: string; url: string; uploadedAt: Date }[];
  folders?: string[];
  hasMore: boolean;
  cursor?: string;
}>;

export type RunSummary = RunManifest & { path: string };

const folderName = (f: string) => f.replace(/\/$/, '').split('/').pop()!;

export async function listFolders(list: Lister, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, mode: 'folded', cursor, limit: 1000 });
    out.push(...(page.folders ?? []).map(folderName));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out.sort();
}

/** Merges the manifest parts of one run (e.g. CI shards) into a single manifest. */
export function mergeParts(parts: RunManifest[]): RunManifest {
  const byDir = new Map<string, RunManifest['tests'][number]>();
  const sorted = [...parts].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  for (const p of sorted) for (const t of p.tests) byDir.set(t.dir, t);
  const tests = [...byDir.values()].sort((a, b) => a.flow.localeCompare(b.flow) || a.name.localeCompare(b.name));
  const newest = sorted[sorted.length - 1]!;
  return {
    ...newest,
    publishedAt: newest.publishedAt,
    totals: { tests: tests.length, passed: tests.filter((t) => t.status === 'passed').length, anomalies: tests.reduce((n, t) => n + t.anomalyCount, 0) },
    tests,
  };
}

/** All runs under a prefix (a repo, a ref, or a run), parts merged, newest first. */
export async function listRuns(list: Lister, prefix: string, fetchJson: (url: string) => Promise<unknown> = (u) => fetch(u).then((r) => r.json())): Promise<RunSummary[]> {
  const parts: { pathname: string; url: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    // `manifests/<part>.json` (current) or a legacy single `manifest.json`.
    parts.push(...page.blobs.filter((b) => /\/(manifests\/[^/]+|manifest)\.json$/.test(b.pathname)));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const byRun = new Map<string, RunManifest[]>();
  await Promise.all(parts.map(async (m) => {
    const path = m.pathname.replace(/\/(manifests\/[^/]+|manifest)\.json$/, '');
    const manifest = (await fetchJson(m.url)) as RunManifest;
    if (!byRun.has(path)) byRun.set(path, []);
    byRun.get(path)!.push(manifest);
  }));
  const runs = [...byRun.entries()].map(([path, ps]) => ({ ...mergeParts(ps), path }));
  return runs.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export const repoPrefix = (owner: string, repo: string) => `runs/${owner}/${repo}/`;
export const refPrefix = (owner: string, repo: string, ref: string) => `runs/${owner}/${repo}/${ref}/`;
export const runPrefixOf = (owner: string, repo: string, ref: string, run: string) => `runs/${owner}/${repo}/${ref}/${run}/`;

export function refLabel(ref: RunManifest['ref']): string {
  return ref.kind === 'pr' ? `PR #${ref.number}` : ref.name;
}
