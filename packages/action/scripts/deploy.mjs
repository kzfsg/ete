// Deploys ete-results/ to Vercel as a static site so the PR comment can link straight into the
// timeline, videos, and traces. Node 20+, uses the Vercel CLI via npx. No other deps.
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const VERCEL_CLI = 'vercel@59';

/** Static-site config: CORS on everything so trace.playwright.dev can fetch trace.zip; no caching of index. */
export const VERCEL_JSON = {
  headers: [
    { source: '/(.*)', headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }] },
    { source: '/index.html', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
  ],
};

/** Vercel CLI prints the deployment URL on stdout, sometimes wrapped in JSON. */
export function parseDeploymentUrl(stdout) {
  const m = /https:\/\/[a-z0-9.-]+\.vercel\.app/i.exec(stdout);
  return m ? m[0] : undefined;
}

async function vercel(args, o) {
  const scope = o.scope ? ['--scope', o.scope] : [];
  const { stdout, stderr } = await exec('npx', ['--yes', VERCEL_CLI, ...args, ...scope, '--token', o.token], {
    cwd: o.cwd, env: { ...process.env, CI: '1' }, maxBuffer: 16 * 1024 * 1024,
  });
  return stdout + '\n' + stderr;
}

/**
 * Deployment protection would put a login page in front of per-deployment URLs. Reports are
 * meant to be opened from a PR comment, so turn it off for this project (idempotent).
 */
export async function disableProtection(o) {
  const q = o.orgId ? `?teamId=${encodeURIComponent(o.orgId)}` : '';
  const res = await fetch(`https://api.vercel.com/v9/projects/${o.projectId}${q}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ssoProtection: null }),
  });
  if (!res.ok) console.warn(`could not disable deployment protection (${res.status}); links may require a Vercel login`);
}

export async function deploy(o) {
  await stat(o.resultsDir);
  await writeFile(join(o.resultsDir, 'vercel.json'), JSON.stringify(VERCEL_JSON, null, 2));
  await mkdir(join(o.resultsDir, '.vercel'), { recursive: true });
  await vercel(['link', '--yes', '--project', o.project], { ...o, cwd: o.resultsDir });
  const link = JSON.parse(await readFile(join(o.resultsDir, '.vercel', 'project.json'), 'utf8'));
  await disableProtection({ token: o.token, projectId: link.projectId, orgId: link.orgId });
  const out = await vercel(['deploy', '--yes', '--archive=tgz', ...(o.name ? ['--meta', `ete=${o.name}`] : [])], { ...o, cwd: o.resultsDir });
  const url = parseDeploymentUrl(out);
  if (!url) throw new Error(`Vercel deploy did not return a URL:\n${out.slice(-2000)}`);
  return { url, projectId: link.projectId };
}

async function main(env = process.env) {
  const token = env.VERCEL_TOKEN;
  if (!token) { console.log('VERCEL_TOKEN not set; skipping report hosting'); return; }
  const repoName = (env.GITHUB_REPOSITORY || 'repo').split('/')[1];
  const project = env.VERCEL_PROJECT || `ete-${repoName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 100);
  const { url } = await deploy({
    resultsDir: env.RESULTS_DIR || 'ete-results',
    token, project, scope: env.VERCEL_SCOPE || undefined,
    name: `${env.GITHUB_REPOSITORY}#${env.GITHUB_RUN_ID}`,
  });
  console.log(`Report hosted at ${url}`);
  if (env.GITHUB_ENV) await writeFile(env.GITHUB_ENV, `REPORT_URL=${url}\n`, { flag: 'a' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
