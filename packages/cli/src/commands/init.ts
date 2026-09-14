import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type InitOptions = { cwd: string; url?: string; start?: string; force?: boolean };

const WORKFLOW = `name: E2E (ete)
on:
  pull_request:
  push:
    branches: [main]

jobs:
  e2e:
    runs-on: ubuntu-latest
    permissions:
      contents: write        # publish recordings to the ete-media branch
      pull-requests: write   # post the results comment
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - uses: kzfsg/ete/packages/action@main
        with:
          # url and start default to the values in ete.yaml
          url: \${{ vars.ETE_URL }}

  # Optional: let your coding agent fix a failing test on the PR branch. ete itself never needs
  # credentials; this job uses whatever agent action and auth you already have. The agent follows
  # the /ete skill: it resumes the session at the failing step, fixes it, replays, and commits.
  # heal:
  #   needs: e2e
  #   if: failure() && github.event_name == 'pull_request'
  #   runs-on: ubuntu-latest
  #   permissions:
  #     contents: write
  #     pull-requests: write
  #   steps:
  #     - uses: actions/checkout@v4
  #       with:
  #         ref: \${{ github.head_ref }}
  #     - uses: <your agent's GitHub action>   # e.g. Claude Code or Codex
  #       with:
  #         prompt: "Use the /ete skill. The ete E2E results comment on this PR lists a failing step and a
  #                  'fix:' command. Resume the session with it, make the step pass, run \`ete run\`, and commit
  #                  e2e/ (including .resolved/) to this branch."
`;

function configFor(url: string, start?: string): string {
  return `# ete configuration — https://github.com/kzfsg/ete
url: ${url}
${start ? `start: ${start}` : '# start: npm run dev        # command that serves \`url\`; omit for an already-deployed URL'}
readyTimeout: 60000          # ms to wait for \`url\` after \`start\`
`;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Returns the list of files created or modified, relative to cwd. */
export async function initCommand(opts: InitOptions): Promise<string[]> {
  const touched: string[] = [];
  const write = async (rel: string, content: string) => {
    const abs = join(opts.cwd, rel);
    if (!opts.force && (await exists(abs))) return;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    touched.push(rel);
  };

  await write('ete.yaml', configFor(opts.url ?? 'http://localhost:3000', opts.start));
  await write('e2e/.gitkeep', '');
  await write('.github/workflows/ete.yml', WORKFLOW);

  const gi = join(opts.cwd, '.gitignore');
  const current = (await exists(gi)) ? await readFile(gi, 'utf8') : '';
  if (!current.split('\n').some((l) => l.trim() === 'ete-results/' || l.trim() === 'ete-results')) {
    await writeFile(gi, current + (current && !current.endsWith('\n') ? '\n' : '') + 'ete-results/\n');
    touched.push('.gitignore');
  }
  return touched;
}
