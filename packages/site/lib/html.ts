import type { RunSummary } from './store';
import { refLabel } from './store';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#1a1a1a;background:#fafafa}
body{margin:0;padding:24px;max-width:1100px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}
nav.crumbs{font-size:13px;color:#666;margin-bottom:16px}nav.crumbs a{color:#3730a3;text-decoration:none}
table{width:100%;border-collapse:collapse;font-size:14px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden}
th{text-align:left;color:#666;font-weight:500;font-size:12px;padding:8px 10px;background:#f5f5f5}
td{padding:8px 10px;border-top:1px solid #eee;vertical-align:middle}
td a{color:#1a1a1a;text-decoration:none;font-weight:500}td a:hover{text-decoration:underline}
.badge{font-size:11px;border-radius:999px;padding:2px 8px;background:#e5e5e5;text-transform:uppercase;letter-spacing:.03em}
.passed{background:#d4f4dd;color:#146c2e}.failed{background:#fee2e2;color:#991b1b}
.muted{color:#666;font-size:12px}.warn{color:#92400e}.empty{padding:32px;text-align:center;color:#666;background:#fff;border:1px dashed #ddd;border-radius:8px}
code{font-family:ui-monospace,monospace;font-size:12px;background:#eee;padding:1px 4px;border-radius:3px}
`;

export function layout(title: string, crumbs: { label: string; href?: string }[], body: string): string {
  const nav = crumbs.map((c) => (c.href ? `<a href="${esc(c.href)}">${esc(c.label)}</a>` : esc(c.label))).join(' › ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · ete</title><style>${CSS}</style></head>
<body><nav class="crumbs">${nav}</nav>${body}</body></html>`;
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export const when = (iso: string) => iso.replace('T', ' ').slice(0, 16) + ' UTC';

export function runsTable(runs: RunSummary[], base: string, opts: { showRef?: boolean } = {}): string {
  if (!runs.length) return '<div class="empty">No runs published yet.</div>';
  const rows = runs.map((r) => {
    const status = r.totals.passed === r.totals.tests ? 'passed' : 'failed';
    const ref = `${refSlugOf(r)}`;
    const href = `${base}/${ref}/${esc(r.runId)}`;
    return `<tr>
  <td><span class="badge ${status}">${status}</span></td>
  ${opts.showRef ? `<td><a href="${base}/${ref}">${esc(refLabel(r.ref))}</a>${r.branch ? ` <span class="muted">${esc(r.branch)}</span>` : ''}</td>` : ''}
  <td><a href="${href}">run ${esc(r.runId)}${r.attempt && r.attempt !== '1' ? ` · attempt ${esc(r.attempt)}` : ''}</a> <span class="muted">${r.source}</span></td>
  <td>${r.totals.passed}/${r.totals.tests} passed${r.totals.anomalies ? ` · <span class="warn">${r.totals.anomalies} anomalies</span>` : ''}</td>
  <td class="muted">${r.commit ? `<code>${esc(r.commit.slice(0, 7))}</code> · ` : ''}${when(r.publishedAt)}</td>
</tr>`;
  });
  return `<table><thead><tr><th></th>${opts.showRef ? '<th>Ref</th>' : ''}<th>Run</th><th>Result</th><th>When</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

export const refSlugOf = (r: RunSummary) => r.path.split('/').slice(-2)[0]!;
