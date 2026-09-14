// Posts or updates a sticky PR comment summarising ete-results/, grouped by flow.
// Node 20+, no deps.
import { readdir, readFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- ete-report -->';
const ICON = { passed: '✅', failed: '❌', skipped: '⏭️' };
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dirOf = (r) => r.dir || parse(r.file).name;

/**
 * Turns a published run manifest (possibly merged from several shards) into the report shapes
 * buildComment expects. Blob URLs are absolute, so links use them directly.
 */
export function reportsFromManifest(manifest) {
  return (manifest.tests || []).map((t) => ({
    name: t.name, file: t.file || `e2e/${t.dir}.yaml`, dir: t.dir, flow: t.flow, status: t.status, durationMs: t.durationMs, anomalyCount: t.anomalyCount,
    recording: { tracePath: t.blobs?.trace ? 'trace.zip' : undefined, traceUrl: t.blobs?.trace },
    steps: t.failedStep ? [{ index: t.failedStep.index, text: t.failedStep.text, kind: 'action', status: 'failed', error: t.failedStep.error, screenshotUrl: t.failedStep.screenshot, anomalies: [] }] : [],
  }));
}

/**
 * @param {Array} reports
 * @param {{artifactUrl: string, reportUrl?: string, run?: {id?: string, attempt?: string, at?: string}}} o
 */
export function buildComment(reports, o) {
  const lines = [MARKER, '## 🧪 ete E2E results', ''];
  if (reports.length === 0) {
    lines.push('_No test results were produced. Check the workflow log._');
    return lines.join('\n');
  }
  const passed = reports.filter((r) => r.status === 'passed').length;
  const anomalies = reports.reduce((n, r) => n + (r.anomalyCount ?? 0), 0);
  const headline = `**${passed}/${reports.length} passed${anomalies ? ` · ${plural(anomalies, 'anomaly', 'anomalies')}` : ''}**`;
  lines.push(o.reportUrl ? `${headline} · **[▶ open report](${o.reportUrl})**` : headline);
  if (o.run?.at || o.run?.id) {
    const when = o.run.at ? new Date(o.run.at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
    lines.push(`<sub>Updated ${when}${o.run.id ? ` · run ${o.run.id}${o.run.attempt && o.run.attempt !== '1' ? ` (attempt ${o.run.attempt})` : ''}` : ''}</sub>`);
  }

  const flows = new Map();
  for (const r of reports) {
    const f = r.flow || 'General';
    if (!flows.has(f)) flows.set(f, []);
    flows.get(f).push(r);
  }
  const COLLAPSE_AT = 10;
  const flowNames = [...flows.keys()].sort((a, b) => a.localeCompare(b));
  const failingFlows = flowNames.filter((f) => flows.get(f).some((t) => t.status !== 'passed'));
  const passingFlows = flowNames.filter((f) => !failingFlows.includes(f));
  const collapse = reports.length > COLLAPSE_AT && passingFlows.length > 0;

  const renderFlow = (flow) => {
    const tests = flows.get(flow).sort((a, b) => a.name.localeCompare(b.name));
    const ok = tests.filter((t) => t.status === 'passed').length;
    const out = ['', `### ${flow} — ${ok}/${tests.length} passed`, ''];
    for (const t of tests) {
      const dir = dirOf(t);
      const links = [];
      if (o.reportUrl) {
        links.push(`[▶ play](${o.reportUrl}/#play=${dir})`);
        const traceUrl = t.recording?.traceUrl || (t.recording?.tracePath ? `${o.reportUrl}/${dir}/${t.recording.tracePath}` : undefined);
        if (traceUrl) links.push(`[trace](https://trace.playwright.dev/?trace=${traceUrl})`);
      }
      const warn = t.anomalyCount ? ` · ⚠️ ${plural(t.anomalyCount, 'anomaly', 'anomalies')}` : '';
      out.push(`${t.status === 'passed' ? '✅' : '❌'} ${t.name} · ${secs(t.durationMs)}${warn}${links.length ? `  ${links.join(' · ')}` : ''}`);
      const failed = t.steps.find((s) => s.status === 'failed');
      if (failed) {
        const err = failed.error ? ` · ${failed.error.split('\n')[0]}` : '';
        out.push(`  - step ${failed.index}: ${failed.kind === 'expect' ? 'expect ' : ''}${failed.text}${err}`);
        out.push(`  - fix: \`ete session start --from ${t.file} --at ${failed.index}\``);
        const shot = failed.screenshotUrl || (o.reportUrl && failed.screenshot ? `${o.reportUrl}/${dir}/${failed.screenshot}` : undefined);
        if (shot) out.push('', `  ![step ${failed.index}](${shot})`, '');
      }
    }
    return out;
  };

  // Failures first, always expanded. Passing flows are collapsed once the suite is large.
  for (const flow of failingFlows) lines.push(...renderFlow(flow));
  if (collapse) {
    const n = passingFlows.reduce((k, f) => k + flows.get(f).length, 0);
    lines.push('', `<details><summary>✅ ${plural(passingFlows.length, 'passing flow', 'passing flows')} (${plural(n, 'test', 'tests')})</summary>`);
    for (const flow of passingFlows) lines.push(...renderFlow(flow));
    lines.push('', '</details>');
  } else {
    for (const flow of passingFlows) lines.push(...renderFlow(flow));
  }

  const anomalyList = reports.flatMap((r) => r.steps.flatMap((s) => (s.anomalies ?? []).map((a) => ({ test: r, step: s, a }))));
  if (anomalyList.length) {
    lines.push('', `<details><summary>⚠️ ${plural(anomalyList.length, 'anomaly', 'anomalies')} (did not fail any test)</summary>`, '');
    for (const { test, step, a } of anomalyList.slice(0, 30)) lines.push(`- **${test.name}** step ${step.index} · \`${a.kind}\` ${a.message}`);
    if (anomalyList.length > 30) lines.push(`- … and ${anomalyList.length - 30} more`);
    lines.push('', '</details>');
  }
  lines.push('', `📦 [Raw videos, traces & screenshots](${o.artifactUrl})${o.reportUrl ? '' : ' · view a trace with `npx playwright show-trace <test>/trace.zip`, or the whole run with `npx ete report`'}.`);
  return lines.join('\n');
}

async function collect(root) {
  let names = [];
  try { names = await readdir(root); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(JSON.parse(await readFile(join(root, n, 'report.json'), 'utf8'))); } catch { /* not a result dir */ }
  }
  return out;
}

async function gh(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${method} ${url} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function main(env = process.env) {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const pr = env.PR_NUMBER;
  if (!token || !repo || !pr) throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are required');
  const artifactUrl = env.ARTIFACT_URL || `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  // Sharded runs: the merged manifest on the site has every shard's tests; local results have only ours.
  let reports = await collect(env.RESULTS_DIR || 'ete-results');
  if (env.MANIFEST_URL) {
    try {
      reports = reportsFromManifest(await (await fetch(env.MANIFEST_URL, { cache: 'no-store' })).json());
    } catch (err) {
      console.warn(`could not read merged manifest (${err.message}); using local results`);
    }
  }
  const body = buildComment(reports, {
    artifactUrl,
    reportUrl: env.REPORT_URL || undefined,
    run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, at: new Date().toISOString() },
  });
  const apiBase = env.GITHUB_API_URL ?? 'https://api.github.com';
  const api = `${apiBase}/repos/${repo}/issues/${pr}/comments`;
  const existing = (await gh(token, 'GET', `${api}?per_page=100`)).find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER));
  if (existing) {
    await gh(token, 'PATCH', `${apiBase}/repos/${repo}/issues/comments/${existing.id}`, { body });
    console.log(`Updated comment ${existing.id}`);
  } else {
    const created = await gh(token, 'POST', api, { body });
    console.log(`Created comment ${created.id}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
