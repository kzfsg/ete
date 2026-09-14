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
      contents: read
      pull-requests: write
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
        env:
          # Only needed when a step must be resolved or healed. Fully cached runs need no key.
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`;

function configFor(url: string, start?: string): string {
  return `# ete configuration — https://github.com/kzfsg/ete
url: ${url}
${start ? `start: ${start}` : '# start: npm run dev        # command that serves \`url\`; omit for an already-deployed URL'}
readyTimeout: 60000          # ms to wait for \`url\` after \`start\`
llm:
  provider: anthropic        # anthropic | openai | google (API key comes from the environment)
  model: claude-opus-5
heal:
  maxPerRun: 5               # LLM heal attempts per run
  maxPerStep: 2
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
