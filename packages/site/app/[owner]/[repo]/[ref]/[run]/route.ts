import { renderHtmlWith, type HistoryEntry, type Report } from '@ete/core';
import { blobLister, fetchJson } from '../../../../../lib/blob';
import { html, layout, esc, when } from '../../../../../lib/html';
import { listRuns, refLabel } from '../../../../../lib/store';

export const dynamic = 'force-dynamic';

export async function GET(_: Request, ctx: { params: Promise<{ owner: string; repo: string; ref: string; run: string }> }) {
  const { owner, repo, ref, run } = await ctx.params;
  const refRuns = await listRuns(blobLister, `runs/${owner}/${repo}/${ref}/`, fetchJson);
  const manifest = refRuns.find((r) => r.path === `runs/${owner}/${repo}/${ref}/${run}`);
  if (!manifest) return html(layout('Not found', [{ label: 'ete', href: '/' }], '<div class="empty">No such run.</div>'), 404);
  const history: HistoryEntry[] = [...refRuns].reverse().slice(-20).map((r) => ({
    runId: r.runId, passed: r.totals.passed, tests: r.totals.tests, publishedAt: r.publishedAt,
    url: `/${owner}/${repo}/${ref}/${r.path.split('/').pop()}`, current: r.path === manifest.path,
  }));
  const reports = (await Promise.all(manifest.tests.map((t) => fetchJson(t.blobs.report)))) as Report[];
  const byDir = new Map(manifest.tests.map((t) => [t.dir, t]));
  const asset = (dir: string, rel: string) => {
    const t = byDir.get(dir);
    if (!t) return undefined;
    if (rel === 'video.webm' || rel.endsWith('.webm')) return t.blobs.video;
    if (rel.endsWith('trace.zip')) return t.blobs.trace;
    if (rel.endsWith('filmstrip.png')) return t.blobs.filmstrip;
    return t.blobs.screenshots[rel];
  };
  const title = `${owner}/${repo} · ${refLabel(manifest.ref)} · run ${manifest.runId}${manifest.attempt && manifest.attempt !== '1' ? ` (attempt ${manifest.attempt})` : ''}`;
  const page = renderHtmlWith(reports, asset, title, { history });
  // Wrap the timeline in the site chrome: inject breadcrumbs after <body>.
  const crumbs = `<nav class="crumbs"><a href="/">ete</a> › <a href="/${esc(owner)}/${esc(repo)}">${esc(owner)}/${esc(repo)}</a> › <a href="/${esc(owner)}/${esc(repo)}/${esc(ref)}">${esc(refLabel(manifest.ref))}</a> › run ${esc(manifest.runId)} <span class="muted">· ${when(manifest.publishedAt)}${manifest.commit ? ` · <code>${esc(manifest.commit.slice(0, 7))}</code>` : ''}</span></nav>`;
  const style = '<style>nav.crumbs{font:13px ui-sans-serif,system-ui,sans-serif;color:#666;margin:0 0 16px}nav.crumbs a{color:#3730a3;text-decoration:none}nav.crumbs code{font:12px ui-monospace,monospace;background:#eee;padding:1px 4px;border-radius:3px}</style>';
  return html(page.replace('<body>', `<body>${style}${crumbs}`));
}
