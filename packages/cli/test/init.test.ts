import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand } from '../src/commands/init.js';

describe('ete init', () => {
  it('scaffolds config, e2e dir, workflow and gitignore', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ete-init-'));
    const created = await initCommand({ cwd, url: 'http://localhost:4000', start: 'npm run dev' });
    expect(created.sort()).toEqual(['.github/workflows/ete.yml', '.gitignore', 'e2e/.gitkeep', 'ete.yaml'].sort());
    const cfg = await readFile(join(cwd, 'ete.yaml'), 'utf8');
    expect(cfg).toContain('url: http://localhost:4000');
    expect(cfg).toContain('start: npm run dev');
    expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toContain('ete-results/');
    expect(await readFile(join(cwd, '.github/workflows/ete.yml'), 'utf8')).toContain('ANTHROPIC_API_KEY');
    expect((await stat(join(cwd, 'e2e'))).isDirectory()).toBe(true);
  });
  it('appends to an existing .gitignore and refuses to overwrite ete.yaml without --force', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ete-init-'));
    await writeFile(join(cwd, '.gitignore'), 'node_modules/\n');
    await writeFile(join(cwd, 'ete.yaml'), 'url: http://keep\n');
    const created = await initCommand({ cwd, url: 'http://x' });
    expect(created).not.toContain('ete.yaml');
    expect(await readFile(join(cwd, 'ete.yaml'), 'utf8')).toBe('url: http://keep\n');
    expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('node_modules/\nete-results/\n');
    const forced = await initCommand({ cwd, url: 'http://x', force: true });
    expect(forced).toContain('ete.yaml');
  });
});
