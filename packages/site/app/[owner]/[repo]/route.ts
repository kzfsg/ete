import { blobLister, fetchJson } from '../../../lib/blob';
import { html, layout, esc, runsTable } from '../../../lib/html';
import { listRuns } from '../../../lib/store';

export const dynamic = 'force-dynamic';

export async function GET(_: Request, ctx: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await ctx.params;
  const runs = await listRuns(blobLister, `runs/${owner}/${repo}/`, fetchJson);
  const body = `<h1>${esc(owner)}/${esc(repo)}</h1><p class="muted">${runs.length} runs</p>${runsTable(runs, `/${owner}/${repo}`, { showRef: true })}`;
  return html(layout(`${owner}/${repo}`, [{ label: 'ete', href: '/' }, { label: `${owner}/${repo}` }], body));
}
