import { blobLister, fetchJson } from '../../../../lib/blob';
import { html, layout, esc, runsTable } from '../../../../lib/html';
import { listRuns, refLabel } from '../../../../lib/store';

export const dynamic = 'force-dynamic';

export async function GET(_: Request, ctx: { params: Promise<{ owner: string; repo: string; ref: string }> }) {
  const { owner, repo, ref } = await ctx.params;
  const runs = await listRuns(blobLister, `runs/${owner}/${repo}/${ref}/`, fetchJson);
  const label = runs[0] ? refLabel(runs[0].ref) : ref;
  const body = `<h1>${esc(label)}</h1><p class="muted">${esc(owner)}/${esc(repo)} · ${runs.length} runs</p>${runsTable(runs, `/${owner}/${repo}`)}`;
  return html(layout(label, [{ label: 'ete', href: '/' }, { label: `${owner}/${repo}`, href: `/${owner}/${repo}` }, { label }], body));
}
