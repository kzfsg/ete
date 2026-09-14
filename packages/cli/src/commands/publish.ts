import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { put as blobPut, list as blobList, del as blobDel } from '@vercel/blob';
import { collectReports, resultsDirName, type Report, type RunManifest } from '@ete/core';
import { RESULTS_DIR } from './run.js';

/** The subset of @vercel/blob we use, injectable for tests. */
export type BlobClient = {
  put(pathname: string, body: Buffer | string, opts?: { contentType?: string }): Promise<{ url: string }>;
  list(opts: { prefix?: string; mode?: 'folded' | 'expanded'; cursor?: string; limit?: number }): Promise<{ blobs: { pathname: string; url: string; uploadedAt: Date }[]; folders?: string[]; hasMore: boolean; cursor?: string }>;
  del(urls: string[]): Promise<void>;
  /** Fetches a blob's JSON body (manifests). */
  getJson(url: string): Promise<unknown>;
};

export function createBlobClient(token: string): BlobClient {
  return {
    put: (pathname, body, opts) => blobPut(pathname, body, { access: 'public', addRandomSuffix: false, allowOverwrite: true, token, contentType: opts?.contentType }),
    list: async (opts) => {
      const r = await blobList({ ...opts, token } as Parameters<typeof blobList>[0]);
      return { blobs: r.blobs, folders: (r as { folders?: string[] }).folders, hasMore: r.hasMore, cursor: r.cursor };
    },
    del: (urls) => blobDel(urls, { token }),
    getJson: (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json()),
  };
}

export type RunRef = { kind: 'pr'; number: number } | { kind: 'branch'; name: string };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
export const refSlug = (ref: RunRef) => (ref.kind === 'pr' ? `pr-${ref.number}` : `branch-${slug(ref.name)}`);

export function runPrefix(o: { owner: string; repo: string; ref: RunRef; runId: string }): string {
  return `runs/${slug(o.owner)}/${slug(o.repo)}/${refSlug(o.ref)}/${slug(o.runId)}/`;
}

export function runUrl(siteUrl: string, o: { owner: string; repo: string; ref: RunRef; runId: string }): string {
  return `${siteUrl.replace(/\/$/, '')}/${slug(o.owner)}/${slug(o.repo)}/${refSlug(o.ref)}/${slug(o.runId)}`;
}

const MIME: Record<string, string> = { '.png': 'image/png', '.webm': 'video/webm', '.zip': 'application/zip', '.json': 'application/json', '.html': 'text/html' };

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

export type PublishOptions = {
  cwd: string;
  blob: BlobClient;
  owner: string;
  repo: string;
  ref: RunRef;
  runId: string;
  attempt?: string;
  commit?: string;
  branch?: string;
  source: 'ci' | 'local';
  siteUrl: string;
  /** Name of this publisher's slice of the run (e.g. a CI shard). Parts never overwrite each other. */
  part?: string;
  retentionDays?: number;
  /** Keep at most this many runs per ref (PR/branch); older ones are pruned regardless of age. Default 5. */
  keepPerRef?: number;
  now?: Date;
  log?: (line: string) => void;
};

export type PublishResult = { url: string; prefix: string; manifest: RunManifest; manifestUrl: string; uploaded: number; pruned: number };

export async function publishRun(o: PublishOptions): Promise<PublishResult> {
  const log = o.log ?? (() => {});
  const now = o.now ?? new Date();
  const root = join(o.cwd, RESULTS_DIR);
  const reports = await collectReports(root);
  if (reports.length === 0) throw new Error(`No results found in ${root}. Run \`ete run\` first.`);
  const prefix = runPrefix(o);

  let uploaded = 0;
  const tests: RunManifest['tests'] = [];
  for (const r of reports) {
    const dir = resultsDirName(r.file);
    const dirAbs = join(root, dir);
    const urls = new Map<string, string>();
    for (const file of await walk(dirAbs)) {
      const rel = relative(dirAbs, file).split('\\').join('/');
      const ext = rel.slice(rel.lastIndexOf('.'));
      const { url } = await o.blob.put(`${prefix}${dir}/${rel}`, await readFile(file), { contentType: MIME[ext] });
      urls.set(rel, url);
      uploaded++;
    }
    const failed = r.steps.find((s) => s.status === 'failed');
    const screenshots: Record<string, string> = {};
    for (const s of r.steps) if (s.screenshot && urls.has(s.screenshot)) screenshots[s.screenshot] = urls.get(s.screenshot)!;
    tests.push({
      dir, file: r.file, name: r.name, flow: r.flow, status: r.status, durationMs: r.durationMs, anomalyCount: r.anomalyCount, steps: r.steps.length,
      ...(failed ? { failedStep: { index: failed.index, text: failed.text, error: failed.error, screenshot: failed.screenshot ? urls.get(failed.screenshot) : undefined } } : {}),
      blobs: {
        report: urls.get('report.json')!,
        video: r.recording.videoPath ? urls.get(r.recording.videoPath) : undefined,
        trace: r.recording.tracePath ? urls.get(r.recording.tracePath) : undefined,
        filmstrip: r.recording.filmstripPath ? urls.get(r.recording.filmstripPath) : undefined,
        screenshots,
      },
    });
    log(`  ↑ ${r.name} (${urls.size} files)`);
  }

  const manifest: RunManifest = {
    version: 1, owner: o.owner, repo: o.repo, ref: o.ref, runId: o.runId, attempt: o.attempt, commit: o.commit, branch: o.branch,
    publishedAt: now.toISOString(), source: o.source,
    totals: { tests: tests.length, passed: tests.filter((t) => t.status === 'passed').length, anomalies: tests.reduce((n, t) => n + t.anomalyCount, 0) },
    tests: tests.sort((a, b) => a.flow.localeCompare(b.flow) || a.name.localeCompare(b.name)),
  };
  // One manifest per publisher (shard). The site merges parts on read, so concurrent shards never race.
  const part = slug(o.part ?? 'all') || 'all';
  await o.blob.put(`${prefix}manifests/${part}.json`, JSON.stringify(manifest, null, 2), { contentType: 'application/json' });
  uploaded++;
  const manifestUrl = `${runUrl(o.siteUrl, o)}/manifest.json`;

  const pruned = await prune(o.blob, `runs/${slug(o.owner)}/${slug(o.repo)}/`, (o.retentionDays ?? 30) * 86_400_000, now, log, { keepPerRef: o.keepPerRef ?? 5, currentRun: prefix });
  return { url: runUrl(o.siteUrl, o), prefix, manifest, manifestUrl, uploaded, pruned };
}

/**
 * Deletes runs under `repoPrefix` that are older than `maxAgeMs`, or beyond the newest
 * `keepPerRef` runs of their ref. Recordings are large; storage is the real limit.
 */
export async function prune(
  blob: BlobClient, repoPrefix: string, maxAgeMs: number, now: Date, log: (l: string) => void,
  o: { keepPerRef?: number; currentRun?: string } = {},
): Promise<number> {
  let pruned = 0;
  let cursor: string | undefined;
  const manifests: { pathname: string; url: string }[] = [];
  do {
    const page = await blob.list({ prefix: repoPrefix, cursor, limit: 1000 });
    manifests.push(...page.blobs.filter((b) => /\/manifests\/[^/]+\.json$/.test(b.pathname)));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  // Group parts by run; a run is as old as its newest part.
  const runs = new Map<string, number>();
  for (const m of manifests) {
    const runDir = m.pathname.replace(/manifests\/[^/]+\.json$/, '');
    let publishedAt = 0;
    try {
      publishedAt = Date.parse(((await blob.getJson(m.url)) as { publishedAt?: string }).publishedAt ?? '') || 0;
    } catch {
      /* unreadable part: ignore */
    }
    runs.set(runDir, Math.max(runs.get(runDir) ?? 0, publishedAt));
  }
  // Per-ref cap: rank runs of each ref newest-first; anything past keepPerRef goes.
  const overCap = new Set<string>();
  if (o.keepPerRef && o.keepPerRef > 0) {
    const byRef = new Map<string, { runDir: string; at: number }[]>();
    for (const [runDir, at] of runs) {
      const ref = runDir.split('/').slice(0, 4).join('/');
      if (!byRef.has(ref)) byRef.set(ref, []);
      byRef.get(ref)!.push({ runDir, at: runDir === o.currentRun ? Number.POSITIVE_INFINITY : at });
    }
    for (const list of byRef.values()) {
      list.sort((a, b) => b.at - a.at);
      for (const r of list.slice(o.keepPerRef)) overCap.add(r.runDir);
    }
  }
  for (const [runDir, publishedAt] of runs) {
    if (runDir === o.currentRun) continue;
    const tooOld = publishedAt > 0 && now.getTime() - publishedAt >= maxAgeMs;
    if (!tooOld && !overCap.has(runDir)) continue;
    const files: string[] = [];
    let c: string | undefined;
    do {
      const page = await blob.list({ prefix: runDir, cursor: c, limit: 1000 });
      files.push(...page.blobs.map((b) => b.url));
      c = page.hasMore ? page.cursor : undefined;
    } while (c);
    if (files.length) await blob.del(files);
    pruned++;
    log(`  ✂ pruned ${runDir} (${files.length} files)`);
  }
  return pruned;
}

export type PublishCommandOptions = {
  cwd: string; repo?: string; pr?: number; branch?: string; run?: string; part?: string; attempt?: string; commit?: string; site?: string; token?: string; retentionDays?: number; keepPerRef?: number; log?: (l: string) => void;
};

/** CLI entry: fills defaults from git and GitHub Actions env, then publishes. */
export async function publishCommand(o: PublishCommandOptions): Promise<PublishResult> {
  const env = process.env;
  const token = o.token ?? env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('Missing BLOB_READ_WRITE_TOKEN (or --token): the Vercel Blob read-write token of the reports store.');
  const site = o.site ?? env.ETE_SITE_URL;
  if (!site) throw new Error('Missing --site (or ETE_SITE_URL): the URL of the central reports site.');
  const repoFull = o.repo ?? env.GITHUB_REPOSITORY ?? (await gitRemoteRepo(o.cwd));
  if (!repoFull || !repoFull.includes('/')) throw new Error('Cannot determine the repository. Pass --repo owner/name.');
  const [owner, repo] = repoFull.split('/') as [string, string];
  const prNumber = o.pr ?? (env.GITHUB_EVENT_NAME === 'pull_request' ? Number(env.GITHUB_REF?.match(/refs\/pull\/(\d+)/)?.[1]) : undefined);
  const branch = o.branch ?? env.GITHUB_HEAD_REF ?? env.GITHUB_REF_NAME ?? (await gitBranch(o.cwd));
  const ref: RunRef = prNumber ? { kind: 'pr', number: prNumber } : { kind: 'branch', name: branch ?? 'local' };
  const runId = o.run ?? env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  return publishRun({
    cwd: o.cwd, blob: createBlobClient(token), owner, repo, ref, runId, attempt: o.attempt ?? env.GITHUB_RUN_ATTEMPT, commit: o.commit ?? env.GITHUB_SHA ?? (await gitSha(o.cwd)),
    branch, source: env.GITHUB_ACTIONS ? 'ci' : 'local', siteUrl: site, part: o.part, retentionDays: o.retentionDays, keepPerRef: o.keepPerRef, log: o.log,
  });
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  const { execFile } = await import('node:child_process');
  return new Promise((r) => execFile('git', args, { cwd }, (err, out) => r(err ? undefined : out.trim())));
}
async function gitRemoteRepo(cwd: string): Promise<string | undefined> {
  const url = await git(cwd, ['remote', 'get-url', 'origin']);
  const m = url && /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}
const gitBranch = (cwd: string) => git(cwd, ['branch', '--show-current']);
const gitSha = (cwd: string) => git(cwd, ['rev-parse', 'HEAD']);

