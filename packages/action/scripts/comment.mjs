// Posts or updates a sticky PR comment summarising ete-results/. Node 20+, no deps.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- ete-report -->';
const ICON = { passed: '✅', resolved: '🆕', healed: '🩹', failed: '❌', skipped: '⏭️' };

export function buildComment(reports, artifactUrl) {
  const lines = [MARKER, '## 🧪 ete E2E results', ''];
  if (reports.length === 0) {
    lines.push('_No test results were produced. Check the workflow log._');
    return lines.join('\n');
  }
  const passed = reports.filter((r) => r.status === 'passed').length;
  lines.push(`**${passed}/${reports.length} passed**`, '', '| Test | Status | Steps | Healed | Duration |', '|---|---|---:|---:|---:|');
  for (const r of reports) {
    const healed = r.steps.filter((s) => s.status === 'healed' || s.status === 'resolved').length;
    lines.push(`| ${r.name} | ${r.status === 'passed' ? '✅ passed' : '❌ failed'} | ${r.steps.length} | ${healed} | ${(r.durationMs / 1000).toFixed(1)}s |`);
  }
  for (const r of reports.filter((r) => r.status === 'failed')) {
    lines.push('', `<details open><summary>❌ <b>${r.name}</b> (${r.file})</summary>`, '');
    for (const s of r.steps) {
      const label = s.kind === 'expect' ? `expect: ${s.text}` : s.text;
      lines.push(`- ${ICON[s.status] ?? '•'} ${s.index}. ${label}${s.error ? `\n  \`\`\`\n  ${s.error.split('\n')[0]}\n  \`\`\`` : ''}`);
    }
    lines.push('', '</details>');
  }
  const healedSteps = reports.flatMap((r) => r.steps.filter((s) => s.status === 'healed' || s.status === 'resolved').map((s) => ({ test: r, step: s })));
  if (healedSteps.length) {
    lines.push('', '<details><summary>🩹 <b>Healed steps</b> — not persisted in CI; run <code>ete run</code> locally and commit <code>e2e/.resolved/</code></summary>', '');
    for (const { test, step } of healedSteps) {
      lines.push(`- **${test.name}** step ${step.index}: ${step.text}`);
      if (step.healedFrom) lines.push(`  - was: \`${JSON.stringify(step.healedFrom)}\``);
      if (step.entry) lines.push(`  - now: \`${JSON.stringify(step.entry)}\``);
    }
    lines.push('', '</details>');
  }
  lines.push('', `📦 [Download recordings & traces](${artifactUrl}) · view a trace with \`npx playwright show-trace <test>/trace.zip\` or the whole run with \`npx ete report\`.`);
  return lines.join('\n');
}

async function collect(root) {
  let names = [];
  try { names = await readdir(root); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(JSON.parse(await readFile(join(root, n, 'report.json'), 'utf8'))); } catch { /* not a result dir */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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
  const body = buildComment(await collect(env.RESULTS_DIR || 'ete-results'), artifactUrl);
  const api = `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repo}/issues/${pr}/comments`;
  const existing = (await gh(token, 'GET', `${api}?per_page=100`)).find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER));
  if (existing) {
    await gh(token, 'PATCH', `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repo}/issues/comments/${existing.id}`, { body });
    console.log(`Updated comment ${existing.id}`);
  } else {
    const created = await gh(token, 'POST', api, { body });
    console.log(`Created comment ${created.id}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
