import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('applies defaults', () => {
    const c = parseConfig('url: http://localhost:3000\n');
    expect(c).toEqual({
      url: 'http://localhost:3000',
      start: undefined,
      readyTimeout: 60000,
    });
  });
  it('accepts overrides', () => {
    const c = parseConfig('url: http://x\nstart: npm run dev\nreadyTimeout: 10\n');
    expect(c.start).toBe('npm run dev');
    expect(c.readyTimeout).toBe(10);
  });
  it('ignores legacy llm/heal keys', () => {
    expect(() => parseConfig('url: http://x\nllm:\n  provider: anthropic\nheal:\n  maxPerRun: 1\n')).not.toThrow();
  });
  it('requires url', () => {
    expect(() => parseConfig('start: x\n')).toThrow(/url/);
  });
});

describe('loadConfig', () => {
  it('reads a file and reports a clear error when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ete-cfg-'));
    await writeFile(join(dir, 'ete.yaml'), 'url: http://y\n');
    expect((await loadConfig(join(dir, 'ete.yaml'))).url).toBe('http://y');
    await expect(loadConfig(join(dir, 'nope.yaml'))).rejects.toThrow(/nope\.yaml.*ete init/);
  });
});
