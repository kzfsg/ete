import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import type { Report, StepReport } from './schema.js';

/** Results subdirectory for a test file: `e2e/login.yaml` -> `login`. */
export function resultsDirName(testPath: string): string {
  return parse(testPath).name;
}

export async function writeReport(resultsDir: string, report: Report): Promise<void> {
  await writeFile(join(resultsDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

export async function collectReports(root: string): Promise<Report[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const reports: Report[] = [];
  for (const name of entries) {
    try {
      reports.push(JSON.parse(await readFile(join(root, name, 'report.json'), 'utf8')) as Report);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') throw err;
    }
  }
  return reports;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function stepRow(dir: string, s: StepReport): string {
  const img = s.screenshot ? `<img src="${esc(dir)}/${esc(s.screenshot)}" alt="step ${s.index}" loading="lazy">` : '';
  const err = s.error ? `<div class="error">${esc(s.error)}</div>` : '';
  return `<tr class="status-${s.status}">
  <td class="shot">${img}</td>
  <td class="idx">${s.index}</td>
  <td class="text">${s.kind === 'expect' ? '<span class="kind">expect</span> ' : ''}${esc(s.text)}${err}</td>
  <td class="status"><span class="badge">${s.status}</span></td>
  <td class="dur">${s.durationMs} ms</td>
</tr>`;
}

function testSection(r: Report): string {
  const dir = resultsDirName(r.file);
  const video = r.recording.videoPath
    ? `<video controls preload="metadata" src="${esc(dir)}/${esc(r.recording.videoPath)}"></video>`
    : '<p class="muted">No video recorded.</p>';
  const trace = r.recording.tracePath
    ? `<p class="muted">Trace: <code>npx playwright show-trace ${esc(dir)}/${esc(r.recording.tracePath)}</code></p>`
    : '';
  return `<section class="test status-${r.status}">
<h2><span class="badge">${r.status}</span> ${esc(r.name)} <small>${esc(r.file)} · ${r.durationMs} ms</small></h2>
${video}
${trace}
<table>
<thead><tr><th></th><th>#</th><th>Step</th><th>Status</th><th>Time</th></tr></thead>
<tbody>
${r.steps.map((s) => stepRow(dir, s)).join('\n')}
</tbody>
</table>
</section>`;
}

const CSS = `
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#1a1a1a;background:#fafafa}
body{margin:0;padding:24px;max-width:1100px;margin-inline:auto}
h1{font-size:20px;margin:0 0 16px}
h2{font-size:16px;margin:0 0 12px;display:flex;gap:8px;align-items:center}
h2 small{color:#666;font-weight:normal;font-size:12px}
section.test{background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin-bottom:24px}
video{width:100%;max-height:420px;background:#000;border-radius:6px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:#666;font-weight:500;font-size:12px;padding:6px}
td{padding:6px;border-top:1px solid #eee;vertical-align:top}
td.shot img{width:160px;border:1px solid #ddd;border-radius:4px}
td.idx,td.dur{color:#666;white-space:nowrap}
.kind{font-size:11px;color:#555;background:#eee;border-radius:3px;padding:1px 4px}
.badge{font-size:11px;border-radius:999px;padding:2px 8px;background:#e5e5e5;text-transform:uppercase;letter-spacing:.03em}
.status-passed>.status .badge,.status-passed>h2 .badge{background:#d4f4dd;color:#146c2e}
.status-resolved>.status .badge{background:#dbeafe;color:#1e40af}
.status-healed>.status .badge{background:#fef3c7;color:#92400e}
.status-failed>.status .badge,.status-failed>h2 .badge{background:#fee2e2;color:#991b1b}
.status-skipped>.status .badge{background:#f3f4f6;color:#6b7280}
.error{margin-top:6px;font-family:ui-monospace,monospace;font-size:12px;color:#991b1b;white-space:pre-wrap}
.muted{color:#666;font-size:12px}
`;

export function renderHtml(reports: Report[]): string {
  const passed = reports.filter((r) => r.status === 'passed').length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ete results</title><style>${CSS}</style></head>
<body>
<h1>ete results · ${passed}/${reports.length} passed</h1>
${reports.map(testSection).join('\n')}
</body></html>
`;
}
