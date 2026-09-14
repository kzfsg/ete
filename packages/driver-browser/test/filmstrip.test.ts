import { describe, it, expect } from 'vitest';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { renderFilmstrip, sampleFrames } from '../src/filmstrip.js';

async function fakeFrames(dir: string, n: number): Promise<string[]> {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 400, height: 300 } });
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    await p.setContent(`<body style="background:hsl(${i * 30},60%,60%);font:40px sans-serif">${i + 1}</body>`);
    const path = join(dir, `${i + 1}.png`);
    await p.screenshot({ path });
    out.push(path);
  }
  await b.close();
  return out;
}

describe('sampleFrames', () => {
  it('keeps everything up to the max and samples evenly beyond it', () => {
    const items = Array.from({ length: 13 }, (_, i) => i);
    expect(sampleFrames(items.slice(0, 5), 12)).toEqual([0, 1, 2, 3, 4]);
    const s = sampleFrames(items, 12);
    expect(s.length).toBe(12);
    expect(s[0]).toBe(0);
    expect(s[11]).toBe(12);
  });
});

describe('renderFilmstrip', () => {
  it('renders a wide png with one frame per screenshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ete-film-'));
    const paths = await fakeFrames(dir, 4);
    const out = join(dir, 'filmstrip.png');
    const { width, height, frames } = await renderFilmstrip({
      frames: paths.map((path, i) => ({ path, index: i + 1, failed: i === 2 })),
      out,
    });
    expect(frames).toBe(4);
    expect(width).toBeGreaterThan(height * 2);
    expect((await stat(out)).size).toBeGreaterThan(1000);
  });
  it('returns zero frames and writes nothing for an empty list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ete-film-'));
    const out = join(dir, 'filmstrip.png');
    expect((await renderFilmstrip({ frames: [], out })).frames).toBe(0);
    await expect(stat(out)).rejects.toThrow();
  });
});
