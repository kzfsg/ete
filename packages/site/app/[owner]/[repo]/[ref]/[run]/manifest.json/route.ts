import { blobLister, fetchJson } from '../../../../../../lib/blob';
import { listRuns } from '../../../../../../lib/store';

export const dynamic = 'force-dynamic';

/** The merged manifest of a run (all shards), for the PR comment and other tooling. */
export async function GET(_: Request, ctx: { params: Promise<{ owner: string; repo: string; ref: string; run: string }> }) {
  const { owner, repo, ref, run } = await ctx.params;
  const [manifest] = await listRuns(blobLister, `runs/${owner}/${repo}/${ref}/${run}/`, fetchJson);
  if (!manifest) return Response.json({ error: 'no such run' }, { status: 404 });
  const { path, ...rest } = manifest;
  void path;
  return Response.json(rest, { headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
}
