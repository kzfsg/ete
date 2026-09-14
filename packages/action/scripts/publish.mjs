// Publishes ete-results/ to an orphan media branch so the PR comment can embed
// filmstrips and link to hosted traces/timelines. Node 20+, git only, no deps.
import { cp, mkdtemp, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const git = async (cwd, args, env) => (await exec('git', args, { cwd, env: { ...process.env, ...env } })).stdout.trim();

/**
 * @param {object} o
 * @param {string} o.resultsDir   local ete-results/ directory
 * @param {string} o.repoDir      checkout of the user's repo (its `origin` is used)
 * @param {string} o.branch       media branch name, e.g. "ete-media"
 * @param {string} o.runId        unique run id, e.g. `${run_id}-${run_attempt}`
 * @param {number} o.retentionDays prune runs whose .published timestamp is older
 * @param {string} o.repository   "owner/repo" for raw URLs
 * @param {Date}   [o.now]
 * @param {string} [o.token]      GitHub token; when set, pushes over https with it
 * @param {string} [o.serverUrl]  default https://github.com
 * @param {string} [o.pagesUrl]   base URL where the branch is served; enables timelineUrl
 */
export async function publish(o) {
  const now = o.now ?? new Date();
  const runDir = `runs/${o.runId}`;
  const remoteUrl = o.token
    ? `${(o.serverUrl ?? 'https://github.com').replace(/^https:\/\//, `https://x-access-token:${o.token}@`)}/${o.repository}.git`
    : await git(o.repoDir, ['remote', 'get-url', 'origin']);

  const work = await mkdtemp(join(tmpdir(), 'ete-media-'));
  try {
    await git(work, ['init', '-q']);
    await git(work, ['config', 'user.email', 'ete[bot]@users.noreply.github.com']);
    await git(work, ['config', 'user.name', 'ete']);
    await git(work, ['remote', 'add', 'origin', remoteUrl]);
    let exists = true;
    try {
      await git(work, ['fetch', '-q', '--depth=1', 'origin', o.branch]);
      await git(work, ['checkout', '-q', '-b', o.branch, 'FETCH_HEAD']);
    } catch {
      exists = false;
      await git(work, ['checkout', '-q', '--orphan', o.branch]);
      await writeFile(join(work, 'README.md'), `# ete media\n\nRecordings published by ete CI. Runs older than the retention window are pruned automatically.\n`);
    }

    // prune
    const runsRoot = join(work, 'runs');
    const cutoff = now.getTime() - o.retentionDays * 86_400_000;
    let pruned = 0;
    try {
      for (const name of await readdir(runsRoot)) {
        let published = 0;
        try { published = Number(await readFile(join(runsRoot, name, '.published'), 'utf8')); } catch { /* keep unknown */ }
        if (published && published < cutoff) { await rm(join(runsRoot, name), { recursive: true, force: true }); pruned++; }
      }
    } catch { /* no runs yet */ }

    // copy this run
    const dest = join(work, runDir);
    await rm(dest, { recursive: true, force: true });
    await cp(o.resultsDir, dest, { recursive: true });
    await writeFile(join(dest, '.published'), String(now.getTime()));

    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', `ete: publish ${o.runId}${pruned ? ` (pruned ${pruned})` : ''}`]);
    await git(work, ['push', '-q', 'origin', `${o.branch}:${o.branch}`, ...(exists ? [] : ['--set-upstream'])]);

    const rawBase = `https://raw.githubusercontent.com/${o.repository}/${o.branch}/${runDir}`;
    const timelineUrl = o.pagesUrl ? `${o.pagesUrl.replace(/\/$/, '')}/${runDir}/index.html` : undefined;
    return { runDir, rawBase, timelineUrl, pruned };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main(env = process.env) {
  const required = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID'];
  for (const k of required) if (!env[k]) throw new Error(`${k} is required`);
  const resultsDir = env.RESULTS_DIR || 'ete-results';
  try { await stat(join(resultsDir)); } catch { console.log('No ete-results/ to publish'); return; }
  const out = await publish({
    resultsDir,
    repoDir: process.cwd(),
    branch: env.MEDIA_BRANCH || 'ete-media',
    runId: `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || '1'}`,
    retentionDays: Number(env.MEDIA_RETENTION_DAYS || 30),
    repository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    serverUrl: env.GITHUB_SERVER_URL,
    pagesUrl: env.PAGES_URL || undefined,
  });
  console.log(`Published ${out.runDir} (${out.pruned} pruned) -> ${out.rawBase}`);
  if (env.GITHUB_ENV) {
    await writeFile(env.GITHUB_ENV, `MEDIA_BASE=${out.rawBase}\n${out.timelineUrl ? `TIMELINE_URL=${out.timelineUrl}\n` : ''}`, { flag: 'a' });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
