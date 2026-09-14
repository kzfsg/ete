import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { flowFor } from './flow.js';
import type { Report, StepReport, StepStatus } from './schema.js';

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
      reports.push(normaliseReport(JSON.parse(await readFile(join(root, name, 'report.json'), 'utf8'))));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
  }
  return reports.sort((a, b) => a.flow.localeCompare(b.flow) || a.name.localeCompare(b.name));
}

/** Fills in fields that older report.json files may lack. */
export function normaliseReport(raw: Partial<Report> & Pick<Report, 'name' | 'file' | 'status' | 'durationMs' | 'steps' | 'recording'>): Report {
  const steps = raw.steps.map((s) => ({ ...s, anomalies: s.anomalies ?? [] }));
  return {
    ...raw,
    flow: raw.flow ?? flowFor(raw.file),
    mode: raw.mode ?? 'replay',
    anomalyCount: raw.anomalyCount ?? steps.reduce((n, s) => n + s.anomalies.length, 0),
    steps,
  };
}

// ---- timeline model -------------------------------------------------------

export type Marker = {
  kind: 'step' | 'anomaly';
  index: number;
  status: StepStatus | 'anomaly';
  t: number;
  pct: number;
  label: string;
};

export function markersFor(report: Report): { total: number; markers: Marker[] } {
  const executed = report.steps.filter((s) => s.startMs !== undefined && s.endMs !== undefined);
  const total = executed.length ? Math.max(report.durationMs, ...executed.map((s) => s.endMs!)) : report.durationMs;
  const pct = (t: number) => (total > 0 ? Math.round((t / total) * 10000) / 100 : 0);
  const markers: Marker[] = [];
  for (const s of executed) {
    markers.push({ kind: 'step', index: s.index, status: s.status, t: s.startMs!, pct: pct(s.startMs!), label: `${s.index}. ${s.kind === 'expect' ? 'expect: ' : ''}${s.text}` });
    for (const a of s.anomalies) {
      markers.push({ kind: 'anomaly', index: s.index, status: 'anomaly', t: a.t, pct: pct(a.t), label: `${a.kind}: ${a.message}` });
    }
  }
  markers.sort((a, b) => a.t - b.t || (a.kind === 'step' ? -1 : 1));
  return { total, markers };
}

// ---- html -----------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

type AssetUrl = (dir: string, rel: string) => string | undefined;
const relativeAsset: AssetUrl = (dir, rel) => `${esc(dir)}/${esc(rel)}`;

function stepRow(dir: string, s: StepReport, asset: AssetUrl): string {
  const shot = s.screenshot ? asset(dir, s.screenshot) : undefined;
  const img = shot ? `<img src="${shot}" alt="step ${s.index}" loading="lazy">` : '';
  const err = s.error ? `<div class="error">${esc(s.error)}</div>` : '';
  const anomalies = s.anomalies.length
    ? `<ul class="anomalies">${s.anomalies.map((a) => `<li><span class="akind">${esc(a.kind)}</span> ${esc(a.message)} <span class="at">@${(a.t / 1000).toFixed(1)}s</span></li>`).join('')}</ul>`
    : '';
  const start = s.startMs !== undefined ? ` data-start="${s.startMs}"` : '';
  return `<tr class="step status-${s.status}"${start}>
  <td class="shot">${img}</td>
  <td class="idx">${s.index}</td>
  <td class="text">${s.kind === 'expect' ? '<span class="kind">expect</span> ' : ''}${esc(s.text)}${err}${anomalies}</td>
  <td class="status"><span class="badge">${s.status}</span></td>
  <td class="dur">${s.durationMs} ms</td>
</tr>`;
}

function rail(report: Report): string {
  const { total, markers } = markersFor(report);
  const items = markers
    .map((m) =>
      m.kind === 'step'
        ? `<button class="marker step status-${m.status}" style="left:${m.pct}%" data-t="${m.t}" title="${esc(m.label)}"></button>`
        : `<button class="marker anomaly" style="left:${m.pct}%" data-t="${m.t}" title="${esc(m.label)}"></button>`,
    )
    .join('');
  return `<div class="rail" data-total="${total}"><div class="playhead"></div>${items}</div>`;
}

function testSection(r: Report, asset: AssetUrl): string {
  const dir = resultsDirName(r.file);
  const videoSrc = r.recording.videoPath ? asset(dir, r.recording.videoPath) : undefined;
  const video = videoSrc ? `<video controls preload="metadata" src="${videoSrc}"></video>` : '<p class="muted">No video recorded.</p>';
  const filmstripSrc = r.recording.filmstripPath ? asset(dir, r.recording.filmstripPath) : undefined;
  const filmstrip = filmstripSrc ? `<img class="filmstrip" src="${filmstripSrc}" alt="filmstrip">` : '';
  const trace = r.recording.tracePath
    ? `<p class="muted">Trace: <code>npx playwright show-trace ${esc(dir)}/${esc(r.recording.tracePath)}</code></p>`
    : '';
  const anomalies = r.anomalyCount ? ` · <span class="warn">${r.anomalyCount} anomal${r.anomalyCount === 1 ? 'y' : 'ies'}</span>` : '';
  return `<section class="test status-${r.status}" id="${esc(dir)}">
<h2><span class="badge">${r.status}</span> ${esc(r.name)} <span class="flow">${esc(r.flow)}</span> <small>${esc(r.file)} · ${r.mode} · ${r.durationMs} ms${anomalies}</small></h2>
${video}
${rail(r)}
${filmstrip}
${trace}
<table>
<thead><tr><th></th><th>#</th><th>Step</th><th>Status</th><th>Time</th></tr></thead>
<tbody>
${r.steps.map((s) => stepRow(dir, s, asset)).join('\n')}
</tbody>
</table>
</section>`;
}

const CSS = `
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#1a1a1a;background:#fafafa}
body{margin:0;padding:24px;max-width:1100px;margin-inline:auto}
h1{font-size:20px;margin:0 0 16px}
h2{font-size:16px;margin:0 0 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
h2 small{color:#666;font-weight:normal;font-size:12px}
.flow{font-size:11px;background:#eef2ff;color:#3730a3;border-radius:999px;padding:2px 8px;font-weight:500}
.warn{color:#92400e}
section.test{background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin-bottom:24px}
video{width:100%;max-height:420px;background:#000;border-radius:6px;display:block}
.rail{position:relative;height:22px;margin:6px 0 12px;background:#f0f0f0;border-radius:4px}
.playhead{position:absolute;top:0;bottom:0;width:2px;background:#111;left:0;pointer-events:none}
.marker{position:absolute;top:3px;width:10px;height:16px;margin-left:-5px;border:0;border-radius:2px;cursor:pointer;padding:0;background:#9ca3af}
.marker.status-passed{background:#22c55e}
.marker.status-failed{background:#ef4444}.marker.status-skipped{background:#d1d5db}
.marker.anomaly{background:#facc15;top:8px;width:8px;height:8px;margin-left:-4px;border-radius:50%}
.marker:hover{outline:2px solid #111}
.filmstrip{width:100%;border:1px solid #eee;border-radius:4px;margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:#666;font-weight:500;font-size:12px;padding:6px}
td{padding:6px;border-top:1px solid #eee;vertical-align:top}
tr.step[data-start]{cursor:pointer}
tr.step.current{background:#fffbeb}
td.shot img{width:160px;border:1px solid #ddd;border-radius:4px}
td.idx,td.dur{color:#666;white-space:nowrap}
.kind{font-size:11px;color:#555;background:#eee;border-radius:3px;padding:1px 4px}
.badge{font-size:11px;border-radius:999px;padding:2px 8px;background:#e5e5e5;text-transform:uppercase;letter-spacing:.03em}
.status-passed>.status .badge,.status-passed>h2 .badge{background:#d4f4dd;color:#146c2e}
.status-failed>.status .badge,.status-failed>h2 .badge{background:#fee2e2;color:#991b1b}
.status-skipped>.status .badge{background:#f3f4f6;color:#6b7280}
.error{margin-top:6px;font-family:ui-monospace,monospace;font-size:12px;color:#991b1b;white-space:pre-wrap}
.anomalies{margin:6px 0 0;padding-left:16px;font-size:12px;color:#92400e}
.akind{font-family:ui-monospace,monospace;background:#fef3c7;border-radius:3px;padding:0 4px}
.at{color:#999}
.muted{color:#666;font-size:12px}
`;

const JS = `
document.querySelectorAll('section.test').forEach(function (sec) {
  var video = sec.querySelector('video'); if (!video) return;
  var rail = sec.querySelector('.rail'); var playhead = sec.querySelector('.playhead');
  var total = Number(rail && rail.dataset.total) || 0;
  var rows = Array.prototype.slice.call(sec.querySelectorAll('tr.step[data-start]'));
  function seek(ms) { video.currentTime = ms / 1000; video.pause(); }
  sec.querySelectorAll('.marker').forEach(function (m) { m.addEventListener('click', function () { seek(Number(m.dataset.t)); }); });
  rows.forEach(function (r) { r.addEventListener('click', function (e) { if (e.target.tagName !== 'IMG') seek(Number(r.dataset.start)); }); });
  video.addEventListener('loadedmetadata', function () { if (video.duration && isFinite(video.duration)) total = Math.max(total, video.duration * 1000); });
  video.addEventListener('timeupdate', function () {
    var ms = video.currentTime * 1000;
    if (playhead && total) playhead.style.left = Math.min(100, ms / total * 100) + '%';
    var current = null;
    rows.forEach(function (r) { if (Number(r.dataset.start) <= ms) current = r; });
    rows.forEach(function (r) { r.classList.toggle('current', r === current); });
  });
});
`;

function page(reports: Report[], asset: AssetUrl, title?: string): string {
  const passed = reports.filter((r) => r.status === 'passed').length;
  const anomalies = reports.reduce((n, r) => n + (r.anomalyCount ?? 0), 0);
  const heading = `ete results · ${passed}/${reports.length} passed${anomalies ? ` · <span class="warn">${anomalies} anomalies</span>` : ''}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title ?? 'ete results')}</title><style>${CSS}</style></head>
<body>
<h1>${heading}${title ? ` <small class="muted">${esc(title)}</small>` : ''}</h1>
${reports.map((r) => testSection(r, asset)).join('\n')}
<script>${JS}</script>
</body></html>
`;
}

/** Report that references recordings as sibling files under the results root. */
export function renderHtml(reports: Report[], title?: string): string {
  return page(reports, relativeAsset, title);
}

const MIME: Record<string, string> = { '.png': 'image/png', '.webm': 'video/webm', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };

/**
 * A single self-contained file: every video, screenshot, and filmstrip is inlined as a data
 * URI, so it opens from anywhere (artifact download, chat, email) with real video playback.
 * Missing files degrade to "no video"/no image rather than failing.
 */
export async function renderStandaloneHtml(reports: Report[], root: string, opts: { title?: string } = {}): Promise<string> {
  const cache = new Map<string, string | undefined>();
  async function load(dir: string, rel: string): Promise<string | undefined> {
    const key = `${dir}/${rel}`;
    if (!cache.has(key)) {
      try {
        const buf = await readFile(join(root, dir, rel));
        const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
        cache.set(key, `data:${MIME[ext] ?? 'application/octet-stream'};base64,${buf.toString('base64')}`);
      } catch {
        cache.set(key, undefined);
      }
    }
    return cache.get(key);
  }
  // Pre-load everything so the synchronous renderer can look assets up.
  for (const r of reports) {
    const dir = resultsDirName(r.file);
    for (const rel of [r.recording.videoPath, r.recording.filmstripPath, ...r.steps.map((s) => s.screenshot)]) if (rel) await load(dir, rel);
  }
  return page(reports, (dir, rel) => cache.get(`${dir}/${rel}`), opts.title);
}
