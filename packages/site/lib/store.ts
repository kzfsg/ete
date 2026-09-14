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

/** All manifests under a prefix (a repo, a ref, or a run), newest first. */
export async function listRuns(list: Lister, prefix: string, fetchJson: (url: string) => Promise<unknown> = (u) => fetch(u).then((r) => r.json())): Promise<RunSummary[]> {
  const manifests: { pathname: string; url: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    manifests.push(...page.blobs.filter((b) => b.pathname.endsWith('/manifest.json')));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const runs = await Promise.all(manifests.map(async (m) => ({ ...((await fetchJson(m.url)) as RunManifest), path: m.pathname.slice(0, -'/manifest.json'.length) })));
  return runs.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export const repoPrefix = (owner: string, repo: string) => `runs/${owner}/${repo}/`;
export const refPrefix = (owner: string, repo: string, ref: string) => `runs/${owner}/${repo}/${ref}/`;
export const runPrefixOf = (owner: string, repo: string, ref: string, run: string) => `runs/${owner}/${repo}/${ref}/${run}/`;

export function refLabel(ref: RunManifest['ref']): string {
  return ref.kind === 'pr' ? `PR #${ref.number}` : ref.name;
}
