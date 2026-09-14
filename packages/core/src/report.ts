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

export type AssetUrl = (dir: string, rel: string) => string | undefined;
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

function playerData(reports: Report[], asset: AssetUrl) {
  return {
    tests: reports.map((r) => {
      const dir = resultsDirName(r.file);
      const { total } = markersFor(r);
      return {
        dir, name: r.name, flow: r.flow, status: r.status, durationMs: r.durationMs, anomalyCount: r.anomalyCount, total,
        video: r.recording.videoPath ? asset(dir, r.recording.videoPath) : undefined,
        steps: r.steps.map((st) => ({
          index: st.index, text: st.text, kind: st.kind, status: st.status, startMs: st.startMs, endMs: st.endMs, error: st.error,
          screenshot: st.screenshot ? asset(dir, st.screenshot) : undefined, anomalies: st.anomalies,
        })),
      };
    }),
  };
}

/** JSON safe inside a <script> element. */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const PLAYER_SHELL = `<div id="player" hidden aria-modal="true" role="dialog" aria-label="Recording player">
  <div class="player-top"><span class="player-title"></span><button class="player-close" aria-label="Close player">Close</button></div>
  <div class="player-main">
    <div class="player-stage"><video playsinline preload="auto"></video><div class="player-empty" hidden>No video for this test.</div></div>
    <aside class="player-rail" aria-label="Tests in this run"></aside>
  </div>
  <div class="player-caption"></div>
  <div class="player-reel" tabindex="0" aria-label="Scrub through steps"><div class="reel-track"></div><div class="reel-head"></div><div class="reel-tip" hidden></div></div>
  <div class="player-hint">space play · ← → step · ↑ ↓ test · esc close</div>
</div>`;

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
<h2><span class="badge">${r.status}</span> ${esc(r.name)} <span class="flow">${esc(r.flow)}</span> <small>${esc(r.file)} · ${r.mode} · ${r.durationMs} ms${anomalies}</small>${videoSrc ? `<button class="open-player" data-dir="${esc(dir)}">▶ Open player</button>` : ''}</h2>
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

export const SUMMARY_CSS = `
.summary{background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin-bottom:24px}
.headline{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:12px}
.headline .big{font-size:22px;font-weight:600}
.headline .stat{font-size:13px;color:#666}.headline .stat.bad{color:#991b1b}.headline .stat.warn{color:#92400e}
.flows{display:grid;gap:6px;margin-bottom:12px}
.flow-row{display:grid;grid-template-columns:160px 1fr 48px;align-items:center;gap:10px;font-size:13px}
.flow-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{display:flex;gap:2px;height:18px}
.seg{display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:#fff;border-radius:3px;min-width:14px}
.seg.passed{background:#16a34a}.seg.failed{background:#dc2626}
.flow-count{text-align:right}
.legend{display:flex;gap:14px;font-size:12px;color:#666;margin-top:4px}
.legend .sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.legend .sw.passed{background:#16a34a}.legend .sw.failed{background:#dc2626}
.failures{list-style:none;padding:0;margin:0;border-top:1px solid #eee}
.failures li{padding:8px 0;border-bottom:1px solid #eee;font-size:14px}
.failures a{color:#1a1a1a;font-weight:500}
.fail-detail{font-size:12px;color:#555;margin-top:2px}
.error-inline{font-family:ui-monospace,monospace;color:#991b1b}
.history{display:flex;align-items:flex-end;gap:3px;height:44px;margin-left:auto}
.history .muted{align-self:center;margin-right:6px}
.hbar{display:inline-block;width:10px;border-radius:2px 2px 0 0;background:#16a34a;opacity:.55}
.hbar.failed{background:#dc2626}.hbar.current{opacity:1;outline:2px solid #111;outline-offset:1px}
.hbar:hover{opacity:1}
`;

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

const PLAYER_CSS = `
.open-player{margin-left:auto;font:inherit;font-size:12px;padding:4px 10px;border:1px solid #cfcfcf;border-radius:999px;background:#fff;cursor:pointer}
.open-player:hover{border-color:#111}
h1 .open-player{margin-left:12px;vertical-align:middle}
#player{position:fixed;inset:0;z-index:100;background:#1c1f24;color:#f3efe8;display:grid;grid-template-rows:auto 1fr auto auto auto;font-size:14px}
#player[hidden]{display:none}
.player-top{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid #2c3037}
.player-title{font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.player-title .st{font-size:11px;border-radius:999px;padding:2px 8px;margin-right:8px;text-transform:uppercase;letter-spacing:.03em;background:#3a3f48;color:#f3efe8}
.player-title .st.passed{background:#1f5133;color:#b7f0c8}.player-title .st.failed{background:#5a1f1f;color:#ffb3ad}
.player-close{font:inherit;color:#f3efe8;background:transparent;border:1px solid #454b55;border-radius:6px;padding:6px 12px;cursor:pointer}
.player-close:hover,.player-close:focus-visible{border-color:#f3efe8;outline:none}
.player-main{display:grid;grid-template-columns:1fr 280px;min-height:0}
.player-stage{position:relative;display:flex;align-items:center;justify-content:center;background:#0f1114;min-height:0}
.player-stage video{max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;background:#0f1114;outline:none}
.player-empty{position:absolute;color:#9aa0a8}
.player-rail{overflow:auto;border-left:1px solid #2c3037;padding:8px}
.rail-item{display:grid;grid-template-columns:72px 1fr;gap:10px;align-items:center;width:100%;text-align:left;font:inherit;color:inherit;background:transparent;border:1px solid transparent;border-radius:8px;padding:8px;cursor:pointer}
.rail-item:hover{background:#252932}.rail-item[aria-current="true"]{border-color:#6b7280;background:#252932}
.rail-item img{width:72px;aspect-ratio:16/10;object-fit:cover;border-radius:4px;background:#000}
.rail-item .name{display:block;font-size:13px;line-height:1.3}.rail-item .meta{display:block;font-size:11px;color:#9aa0a8;margin-top:3px}
.rail-item .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.dot.passed{background:#34c26b}.dot.failed{background:#ef5350}
.player-caption{padding:10px 20px 4px;min-height:44px;display:flex;gap:12px;align-items:baseline}
.player-caption .idx{color:#9aa0a8;font-variant-numeric:tabular-nums}
.player-caption .text{font-size:16px}
.player-caption .kind{font-size:11px;color:#c7cbd1;border:1px solid #454b55;border-radius:3px;padding:0 5px;margin-right:6px;vertical-align:middle}
.player-caption .err{color:#ff8a80;font-family:ui-monospace,monospace;font-size:12px}
.player-caption .anom{color:#f5c542;font-size:12px}
.player-reel{position:relative;margin:4px 20px 8px;height:84px;background:#0f1114;border-radius:6px;overflow:hidden;cursor:ew-resize;user-select:none;outline:none}
.player-reel:focus-visible{box-shadow:0 0 0 2px #f3efe8 inset}
.reel-track{position:absolute;inset:0;display:flex}
.reel-seg{position:relative;height:100%;flex:0 0 auto;border-right:1px solid #1c1f24;box-sizing:border-box;overflow:hidden;background:#23272e}
.reel-seg img{width:100%;height:100%;object-fit:cover;object-position:top;display:block;opacity:.85}
.reel-seg.failed{box-shadow:inset 0 0 0 2px #ef5350}
.reel-seg.failed img{opacity:.6}
.reel-seg.current img{opacity:1}
.reel-seg .n{position:absolute;left:4px;top:3px;font-size:10px;line-height:1;background:rgba(0,0,0,.6);padding:2px 4px;border-radius:3px}
.reel-seg .tick{position:absolute;bottom:0;width:3px;height:10px;background:#f5c542}
.reel-head{position:absolute;top:0;bottom:0;width:2px;background:#f3efe8;pointer-events:none;box-shadow:0 0 0 1px rgba(0,0,0,.6)}
.reel-tip{position:absolute;bottom:100%;transform:translate(-50%,-6px);background:#f3efe8;color:#1c1f24;font-size:12px;padding:4px 8px;border-radius:4px;white-space:nowrap;pointer-events:none}
.player-hint{padding:0 20px 10px;font-size:11px;color:#6b7280}
@media (max-width:800px){.player-main{grid-template-columns:1fr}.player-rail{display:none}}
@media (prefers-reduced-motion:no-preference){.reel-seg img{transition:opacity .15s}}
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

export type HistoryEntry = { runId: string; passed: number; tests: number; publishedAt: string; url: string; current?: boolean };
export type RenderOptions = { history?: HistoryEntry[] };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The strip above the recordings: headline counts, per-flow bars, failures, and run history. */
export function summarySection(reports: Report[], opts: RenderOptions): string {
  const passed = reports.filter((r) => r.status === 'passed').length;
  const failed = reports.length - passed;
  const anomalies = reports.reduce((n, r) => n + (r.anomalyCount ?? 0), 0);
  const flows = new Map<string, Report[]>();
  for (const r of reports) flows.set(r.flow, [...(flows.get(r.flow) ?? []), r]);
  const maxPerFlow = Math.max(1, ...[...flows.values()].map((t) => t.length));

  const rows = [...flows.entries()]
    .sort((a, b) => Number(b[1].some((t) => t.status === 'failed')) - Number(a[1].some((t) => t.status === 'failed')) || a[0].localeCompare(b[0]))
    .map(([flow, tests]) => {
      const ok = tests.filter((t) => t.status === 'passed').length;
      const bad = tests.length - ok;
      const width = (tests.length / maxPerFlow) * 100;
      const seg = (cls: string, n: number) => (n ? `<span class="seg ${cls}" style="width:${Math.round((n / tests.length) * 10000) / 100}%">${n}</span>` : '');
      return `<div class="flow-row" data-flow="${esc(flow)}"><span class="flow-name">${esc(flow)}</span><span class="bar" style="width:${width}%">${seg('passed', ok)}${seg('failed', bad)}</span><span class="flow-count muted">${ok}/${tests.length}</span></div>`;
    })
    .join('');

  const failures = reports
    .filter((r) => r.status === 'failed')
    .map((r) => {
      const dir = resultsDirName(r.file);
      const step = r.steps.find((st) => st.status === 'failed');
      const detail = step ? `step ${step.index}: ${step.kind === 'expect' ? 'expect ' : ''}${esc(step.text)}${step.error ? ` <span class="error-inline">${esc(step.error.split('\n')[0]!)}</span>` : ''}` : '';
      return `<li><span class="badge failed">failed</span> <a href="#play=${esc(dir)}">${esc(r.name)}</a> <span class="muted">${esc(r.flow)}</span><div class="fail-detail">${detail}</div></li>`;
    })
    .join('');

  const history = opts.history?.length
    ? `<div class="history" aria-label="Previous runs of this branch"><span class="muted">runs</span>${opts.history
        .map((h) => {
          const cls = `hbar ${h.passed === h.tests ? 'passed' : 'failed'}${h.current ? ' current' : ''}`;
          const height = Math.max(8, Math.round((h.tests ? h.passed / h.tests : 0) * 40));
          const when = h.publishedAt.replace('T', ' ').slice(0, 16);
          return `<a class="${cls}" href="${esc(h.url)}" style="height:${height}px" title="run ${esc(h.runId)} · ${h.passed}/${h.tests} passed · ${when}"></a>`;
        })
        .join('')}</div>`
    : '';

  return `<div class="summary">
<div class="headline"><span class="big">${passed} of ${reports.length} passed</span><span class="stat ${failed ? 'bad' : ''}">❌ ${plural(failed, 'failed', 'failed')}</span><span class="stat ${anomalies ? 'warn' : ''}">⚠️ ${plural(anomalies, 'anomaly', 'anomalies')}</span>${history}</div>
<div class="flows" role="img" aria-label="Passed and failed tests per flow">${rows}<div class="legend"><span><i class="sw passed"></i>✅ passed</span><span><i class="sw failed"></i>❌ failed</span></div></div>
${failed ? `<ul class="failures">${failures}</ul>` : ''}
</div>`;
}

function page(reports: Report[], asset: AssetUrl, title?: string, opts: RenderOptions = {}): string {
  const passed = reports.filter((r) => r.status === 'passed').length;
  const anomalies = reports.reduce((n, r) => n + (r.anomalyCount ?? 0), 0);
  const heading = `ete results · ${passed}/${reports.length} passed${anomalies ? ` · <span class="warn">${anomalies} anomalies</span>` : ''}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title ?? 'ete results')}</title><style>${CSS}${SUMMARY_CSS}${PLAYER_CSS}</style></head>
<body>
<h1>${heading}${title ? ` <small class="muted">${esc(title)}</small>` : ''}${reports.some((r) => r.recording.videoPath) ? ' <button class="open-player" data-dir="">▶ Open player</button>' : ''}</h1>
${summarySection(reports, opts)}
${reports.map((r) => testSection(r, asset)).join('\n')}
${PLAYER_SHELL}
<script type="application/json" id="ete-data">${jsonForScript(playerData(reports, asset))}</script>
<script>${JS}</script>
<script>${PLAYER_JS}</script>
</body></html>
`;
}

/** Report that references recordings as sibling files under the results root. */
const PLAYER_JS = `
(function () {
  var dataEl = document.getElementById('ete-data'); if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent || '{}'); var tests = data.tests || [];
  var root = document.getElementById('player'); if (!root || !tests.length) return;
  var video = root.querySelector('video'), empty = root.querySelector('.player-empty');
  var title = root.querySelector('.player-title'), rail = root.querySelector('.player-rail');
  var caption = root.querySelector('.player-caption'), reel = root.querySelector('.player-reel');
  var track = reel.querySelector('.reel-track'), head = reel.querySelector('.reel-head'), tip = reel.querySelector('.reel-tip');
  var cur = -1, total = 1, segs = [], scrubbing = false, wasPlaying = false;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function executed(t) { return t.steps.filter(function (s) { return s.startMs != null && s.endMs != null; }); }
  function stepAt(t, ms) { var e = executed(t), c = null; for (var i = 0; i < e.length; i++) if (e[i].startMs <= ms) c = e[i]; return c; }

  function renderRail() {
    rail.innerHTML = tests.map(function (t, i) {
      var shots = t.steps.filter(function (s) { return s.screenshot; }); var shot = (shots[shots.length - 1] || {}).screenshot;
      var executedN = executed(t).length;
      return '<button class="rail-item" data-i="' + i + '" aria-current="' + (i === cur) + '">' +
        (shot ? '<img src="' + esc(shot) + '" alt="">' : '<span></span>') +
        '<span><span class="name"><span class="dot ' + t.status + '"></span>' + esc(t.name) + '</span>' +
        '<span class="meta">' + esc(t.flow) + ' · ' + executedN + ' steps · ' + (t.durationMs / 1000).toFixed(1) + 's' + (t.anomalyCount ? ' · ⚠ ' + t.anomalyCount : '') + '</span></span></button>';
    }).join('');
    rail.querySelectorAll('.rail-item').forEach(function (b) { b.addEventListener('click', function () { load(Number(b.dataset.i), true); }); });
  }

  function renderReel(t) {
    var e = executed(t); track.innerHTML = ''; segs = [];
    total = Math.max(t.total || 0, e.length ? e[e.length - 1].endMs : 0, 1);
    e.forEach(function (s, i) {
      var end = i + 1 < e.length ? e[i + 1].startMs : total;
      var w = Math.max(0, end - s.startMs) / total * 100;
      var seg = document.createElement('div');
      seg.className = 'reel-seg' + (s.status === 'failed' ? ' failed' : ''); seg.style.width = w + '%'; seg.dataset.start = s.startMs;
      seg.innerHTML = (s.screenshot ? '<img src="' + esc(s.screenshot) + '" alt="">' : '') + '<span class="n">' + s.index + '</span>' +
        (s.anomalies || []).map(function (a) { return '<span class="tick" style="left:' + (Math.max(0, a.t - s.startMs) / Math.max(1, end - s.startMs) * 100) + '%" title="' + esc(a.kind + ': ' + a.message) + '"></span>'; }).join('');
      track.appendChild(seg); segs.push({ el: seg, step: s });
    });
  }

  function renderCaption(t, ms) {
    var s = stepAt(t, ms); if (!s) { caption.innerHTML = '<span class="idx">' + (ms / 1000).toFixed(1) + 's</span>'; return; }
    caption.innerHTML = '<span class="idx">' + s.index + ' / ' + executed(t).length + '</span>' +
      '<span class="text">' + (s.kind === 'expect' ? '<span class="kind">expect</span>' : '') + esc(s.text) + '</span>' +
      (s.error ? '<span class="err">' + esc(s.error.split('\\n')[0]) + '</span>' : '') +
      (s.anomalies && s.anomalies.length ? '<span class="anom">⚠ ' + s.anomalies.length + ' anomal' + (s.anomalies.length === 1 ? 'y' : 'ies') + '</span>' : '');
    segs.forEach(function (g) { g.el.classList.toggle('current', g.step === s); });
  }

  function tick() { var ms = video.currentTime * 1000; head.style.left = Math.min(100, ms / total * 100) + '%'; renderCaption(tests[cur], ms); }

  function load(i, play) {
    cur = i; var t = tests[i];
    title.innerHTML = '<span class="st ' + t.status + '">' + t.status + '</span>' + esc(t.name) + ' <span style="color:#9aa0a8">· ' + esc(t.flow) + '</span>';
    renderRail(); renderReel(t);
    if (t.video) { empty.hidden = true; video.src = t.video; video.currentTime = 0; if (play) video.play().catch(function () {}); }
    else { empty.hidden = false; video.removeAttribute('src'); video.load(); }
    tick(); history.replaceState(null, '', '#play=' + encodeURIComponent(t.dir));
  }

  function open(dir, play) {
    var i = Math.max(0, tests.findIndex(function (t) { return t.dir === dir; }));
    root.hidden = false; document.body.style.overflow = 'hidden'; load(i, play !== false);
    reel.focus({ preventScroll: true });
  }
  function close() { video.pause(); root.hidden = true; document.body.style.overflow = ''; history.replaceState(null, '', location.pathname + location.search + (tests[cur] ? '#' + tests[cur].dir : '')); }

  function seekFromEvent(ev) {
    var r = reel.getBoundingClientRect(); var x = Math.min(Math.max(0, ev.clientX - r.left), r.width);
    var ms = x / r.width * total; video.currentTime = ms / 1000; tick();
    var s = stepAt(tests[cur], ms); tip.hidden = false; tip.style.left = x + 'px';
    tip.textContent = (ms / 1000).toFixed(1) + 's' + (s ? ' · ' + s.index + '. ' + s.text : '');
  }
  reel.addEventListener('pointerdown', function (ev) { ev.preventDefault(); scrubbing = true; wasPlaying = !video.paused; video.pause(); seekFromEvent(ev); });
  window.addEventListener('pointermove', function (ev) { if (scrubbing) seekFromEvent(ev); });
  window.addEventListener('pointerup', function () { if (!scrubbing) return; scrubbing = false; if (wasPlaying) video.play().catch(function () {}); });
  reel.addEventListener('pointermove', function (ev) { if (scrubbing) return; var r = reel.getBoundingClientRect(); var x = ev.clientX - r.left; var s = stepAt(tests[cur], x / r.width * total); tip.hidden = false; tip.style.left = x + 'px'; tip.textContent = s ? s.index + '. ' + s.text : ''; });
  reel.addEventListener('pointerleave', function () { if (!scrubbing) tip.hidden = true; });
  video.addEventListener('timeupdate', tick);
  video.addEventListener('loadedmetadata', function () { if (isFinite(video.duration)) total = Math.max(total, video.duration * 1000); tick(); });
  video.addEventListener('click', function () { video.paused ? video.play() : video.pause(); });

  function jumpStep(delta) {
    var e = executed(tests[cur]); if (!e.length) return; var ms = video.currentTime * 1000;
    var i = e.findIndex(function (s) { return s.startMs > ms + 1; }); var curI = (i === -1 ? e.length : i) - 1;
    var next = Math.min(e.length - 1, Math.max(0, curI + delta)); video.currentTime = e[next].startMs / 1000; tick();
  }
  document.addEventListener('keydown', function (ev) {
    if (root.hidden) return;
    if (ev.key === 'Escape') { close(); }
    else if (ev.key === ' ') { ev.preventDefault(); video.paused ? video.play() : video.pause(); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); jumpStep(1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); jumpStep(-1); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); load(Math.min(tests.length - 1, cur + 1), true); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); load(Math.max(0, cur - 1), true); }
  });
  root.querySelector('.player-close').addEventListener('click', close);
  document.querySelectorAll('.open-player').forEach(function (b) { b.addEventListener('click', function () { open(b.dataset.dir || tests[0].dir); }); });
  var m = /[#&]play=([^&]+)/.exec(location.hash); if (m) open(decodeURIComponent(m[1]), false);
  var m2 = /^#play=/.test(location.hash); void m2; // '#play=' is the deep link format
})();
`;

export function renderHtml(reports: Report[], title?: string): string {
  return page(reports, relativeAsset, title);
}

/** Report with assets resolved by the caller (e.g. blob URLs on the central site). */
export function renderHtmlWith(reports: Report[], asset: AssetUrl, title?: string, opts: RenderOptions = {}): string {
  return page(reports, asset, title, opts);
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
