import { SUMMARY_CSS, summarySection, type Report } from '@ete/core';
import { blobLister, fetchJson } from '../../../../lib/blob';
import { html, layout, esc, runsTable } from '../../../../lib/html';
import { listRuns, refLabel } from '../../../../lib/store';

export const dynamic = 'force-dynamic';

export async function GET(_: Request, ctx: { params: Promise<{ owner: string; repo: string; ref: string }> }) {
  const { owner, repo, ref } = await ctx.params;
  const runs = await listRuns(blobLister, `runs/${owner}/${repo}/${ref}/`, fetchJson);
  const label = runs[0] ? refLabel(runs[0].ref) : ref;
  const latest = runs[0];
  // Summary of the latest run, with the history of every run on this ref.
  const latestReports: Report[] = latest
    ? latest.tests.map((t) => ({
        name: t.name, file: `e2e/${t.dir}.yaml`, flow: t.flow, mode: 'replay', status: t.status, durationMs: t.durationMs, anomalyCount: t.anomalyCount, recording: {},
        steps: t.failedStep ? [{ index: t.failedStep.index, text: t.failedStep.text, kind: 'action', status: 'failed', durationMs: 0, error: t.failedStep.error, anomalies: [] }] : [],
      }))
    : [];
  const history = [...runs].reverse().slice(-20).map((r) => ({
    runId: r.runId, passed: r.totals.passed, tests: r.totals.tests, publishedAt: r.publishedAt,
    url: `/${owner}/${repo}/${ref}/${r.path.split('/').pop()}`, current: r === latest,
  }));
  const summary = latest ? summarySection(latestReports, { history }).replace(/href="#play=([^"]+)"/g, `href="/${owner}/${repo}/${ref}/${latest.path.split('/').pop()}/#play=$1"`) : '';
  const body = `<style>${SUMMARY_CSS}</style><h1>${esc(label)}</h1><p class="muted">${esc(owner)}/${esc(repo)} · ${runs.length} runs · latest run ${latest ? esc(latest.runId) : ''}</p>${summary}${runsTable(runs, `/${owner}/${repo}`)}`;
  return html(layout(label, [{ label: 'ete', href: '/' }, { label: `${owner}/${repo}`, href: `/${owner}/${repo}` }, { label }], body));
}
