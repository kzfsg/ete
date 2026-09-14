// Posts or updates a sticky PR comment summarising ete-results/, grouped by flow.
// Node 20+, no deps.
import { readdir, readFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- ete-report -->';
const ICON = { passed: '✅', failed: '❌', skipped: '⏭️' };
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dirOf = (r) => parse(r.file).name;

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
  for (const flow of [...flows.keys()].sort((a, b) => a.localeCompare(b))) {
    const tests = flows.get(flow).sort((a, b) => a.name.localeCompare(b.name));
    const ok = tests.filter((t) => t.status === 'passed').length;
    lines.push('', `### ${flow} — ${ok}/${tests.length} passed`, '');
    for (const t of tests) {
      const dir = dirOf(t);
      const links = [];
      if (o.reportUrl) {
        links.push(`[▶ timeline](${o.reportUrl}/#${dir})`);
        if (t.recording?.tracePath) links.push(`[trace](https://trace.playwright.dev/?trace=${o.reportUrl}/${dir}/${t.recording.tracePath})`);
      }
      const warn = t.anomalyCount ? ` · ⚠️ ${plural(t.anomalyCount, 'anomaly', 'anomalies')}` : '';
      lines.push(`${t.status === 'passed' ? '✅' : '❌'} ${t.name} · ${secs(t.durationMs)}${warn}${links.length ? `  ${links.join(' · ')}` : ''}`);
      const failed = t.steps.find((s) => s.status === 'failed');
      if (failed) {
        const err = failed.error ? ` · ${failed.error.split('\n')[0]}` : '';
        lines.push(`  - step ${failed.index}: ${failed.kind === 'expect' ? 'expect ' : ''}${failed.text}${err}`);
        lines.push(`  - fix: \`ete session start --from ${t.file} --at ${failed.index}\``);
        if (o.reportUrl && failed.screenshot) lines.push('', `  ![step ${failed.index}](${o.reportUrl}/${dir}/${failed.screenshot})`, '');
      }
    }
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
  const body = buildComment(await collect(env.RESULTS_DIR || 'ete-results'), {
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
