import { blobLister, fetchJson } from '../lib/blob';
import { html, layout, esc, runsTable } from '../lib/html';
import { listFolders, listRuns } from '../lib/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const owners = await listFolders(blobLister, 'runs/');
  const sections: string[] = [];
  for (const owner of owners) {
    for (const repo of await listFolders(blobLister, `runs/${owner}/`)) {
      const runs = await listRuns(blobLister, `runs/${owner}/${repo}/`, fetchJson);
      sections.push(`<h2><a href="/${esc(owner)}/${esc(repo)}">${esc(owner)}/${esc(repo)}</a> <span class="muted">${runs.length} runs</span></h2>${runsTable(runs.slice(0, 5), `/${owner}/${repo}`, { showRef: true })}`);
    }
  }
  const body = `<h1>ete reports</h1><p class="muted">Every published E2E run, across repos.</p>${sections.join('') || '<div class="empty">Nothing published yet. Run <code>ete publish</code> or let the Action do it.</div>'}`;
  return html(layout('All repos', [{ label: 'ete' }], body));
}
