// Posts or updates a sticky PR comment summarising ete-results/, grouped by flow.
// Node 20+, no deps.
import { readdir, readFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- ete-report -->';
const ICON = { passed: '✅', resolved: '🆕', healed: '🩹', failed: '❌', skipped: '⏭️' };
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dirOf = (r) => parse(r.file).name;

function failingStep(r) {
  const s = r.steps.find((x) => x.status === 'failed');
  if (!s) return '';
  const err = s.error ? ` · ${s.error.split('\n')[0]}` : '';
  return ` — step ${s.index}: ${s.kind === 'expect' ? 'expect ' : ''}${s.text}${err}`;
}

/**
 * @param {Array} reports
 * @param {{artifactUrl: string, mediaBase?: string, timelineUrl?: string}} o
 */
export function buildComment(reports, o) {
  const lines = [MARKER, '## 🧪 ete E2E results', ''];
  if (reports.length === 0) {
    lines.push('_No test results were produced. Check the workflow log._');
    return lines.join('\n');
  }
  const passed = reports.filter((r) => r.status === 'passed').length;
  const anomalies = reports.reduce((n, r) => n + (r.anomalyCount ?? 0), 0);
  lines.push(`**${passed}/${reports.length} passed${anomalies ? ` · ${plural(anomalies, 'anomaly', 'anomalies')}` : ''}**`);

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
      if (o.timelineUrl) links.push(`[▶ timeline](${o.timelineUrl}#${dir})`);
      if (o.mediaBase && t.recording?.tracePath) links.push(`[trace](https://trace.playwright.dev/?trace=${o.mediaBase}/${dir}/${t.recording.tracePath})`);
      const warn = t.anomalyCount ? ` · ⚠️ ${plural(t.anomalyCount, 'anomaly', 'anomalies')}` : '';
      lines.push(`${t.status === 'passed' ? '✅' : '❌'} ${t.name} · ${secs(t.durationMs)}${warn}${failingStep(t)}${links.length ? `  ${links.join(' · ')}` : ''}`);
      if (o.mediaBase && t.recording?.filmstripPath) lines.push('', `![${t.name}](${o.mediaBase}/${dir}/${t.recording.filmstripPath})`, '');
    }
  }

  const healed = reports.flatMap((r) => r.steps.filter((s) => s.status === 'healed' || s.status === 'resolved').map((s) => ({ test: r, step: s })));
  if (healed.length) {
    lines.push('', `<details><summary>🩹 ${plural(healed.length, 'step', 'steps')} healed — not persisted in CI; run <code>ete run</code> locally and commit <code>e2e/.resolved/</code></summary>`, '');
    for (const { test, step } of healed) {
      lines.push(`- **${test.name}** step ${step.index}: ${step.text}`);
      if (step.healedFrom) lines.push(`  - was: \`${JSON.stringify(step.healedFrom)}\``);
      if (step.entry) lines.push(`  - now: \`${JSON.stringify(step.entry)}\``);
    }
    lines.push('', '</details>');
  }
  const anomalyList = reports.flatMap((r) => r.steps.flatMap((s) => s.anomalies.map((a) => ({ test: r, step: s, a }))));
  if (anomalyList.length) {
    lines.push('', `<details><summary>⚠️ ${plural(anomalyList.length, 'anomaly', 'anomalies')} (did not fail any test)</summary>`, '');
    for (const { test, step, a } of anomalyList.slice(0, 30)) lines.push(`- **${test.name}** step ${step.index} · \`${a.kind}\` ${a.message}`);
    if (anomalyList.length > 30) lines.push(`- … and ${anomalyList.length - 30} more`);
    lines.push('', '</details>');
  }
  lines.push('', `📦 [Download full videos & traces](${o.artifactUrl}) · view a trace with \`npx playwright show-trace <test>/trace.zip\`, or the whole run with \`npx ete report\`.`);
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
    mediaBase: env.MEDIA_BASE || undefined,
    timelineUrl: env.TIMELINE_URL || undefined,
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
