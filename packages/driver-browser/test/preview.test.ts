import { describe, it, expect } from 'vitest';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createDemoServer } from '../../../fixtures/demo-app/server.mjs';
import { createBrowserDriver } from '../src/index.js';
import { ffmpegPath, renderPreview } from '../src/preview.js';
import { buildApng, apngFrameCount, parseChunks } from '../src/apng.js';

describe('ffmpegPath', () => {
  it('finds the ffmpeg Playwright ships', async () => {
    const p = await ffmpegPath();
    expect(p).not.toBe('ffmpeg');
    expect((await stat(p)).isFile()).toBe(true);
  });
});

describe('buildApng', () => {
  it('stitches same-sized PNGs into an animated PNG that still decodes', async () => {
    const b = await chromium.launch();
    const p = await b.newPage({ viewport: { width: 120, height: 80 } });
    const frames: Buffer[] = [];
    for (const color of ['red', 'lime', 'blue']) {
      await p.setContent(`<body style="margin:0;background:${color}"></body>`);
      frames.push(await p.screenshot({ type: 'png' }));
    }
    const apng = buildApng(frames, 250);
    expect(apngFrameCount(apng)).toBe(3);
    const types = parseChunks(apng).map((c) => c.type);
    expect(types[0]).toBe('IHDR');
    expect(types).toContain('acTL');
    expect(types.filter((t) => t === 'fcTL').length).toBe(3);
    expect(types.filter((t) => t === 'fdAT').length).toBeGreaterThanOrEqual(2);
    expect(types[types.length - 1]).toBe('IEND');
    // A browser must be able to decode it and report the right size.
    await p.setContent(`<img id="i" src="data:image/png;base64,${apng.toString('base64')}">`);
    const size = await p.locator('#i').evaluate((img: HTMLImageElement) => new Promise<[number, number, boolean]>((r) => {
      const done = () => r([img.naturalWidth, img.naturalHeight, img.complete]);
      img.complete ? done() : (img.onload = done);
    }));
    expect(size).toEqual([120, 80, true]);
    const small = await b.newPage({ viewport: { width: 60, height: 40 } });
    await small.setContent('<body style="background:red"></body>');
    const mismatched = await small.screenshot({ type: 'png' });
    await b.close();
    expect(() => buildApng([frames[0]!, mismatched], 100)).toThrow(/different IHDR/);
  }, 30_000);
});

describe('renderPreview', () => {
  it('turns a recorded video into an animated png', async () => {
    const server = createDemoServer();
    await new Promise<void>((r) => server.listen(0, r));
    const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    const resultsDir = await mkdtemp(join(tmpdir(), 'ete-prev-'));
    const d = createBrowserDriver();
    await d.start({ baseUrl, resultsDir });
    await d.act({ kind: 'navigate', url: '/login.html' });
    await d.act({ kind: 'type', target: { selector: 'css=input[name=email]' }, text: 'alice@example.com' });
    await d.act({ kind: 'wait', ms: 600 });
    const rec = await d.stop();
    await new Promise<void>((r) => server.close(() => r()));

    const out = join(resultsDir, 'preview.png');
    const res = await renderPreview({ video: join(resultsDir, rec.videoPath!), out, fps: 4, width: 480 });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.frames).toBeGreaterThan(1);
    const buf = await readFile(out);
    expect(apngFrameCount(buf)).toBe(res.frames);
  }, 60_000);

  it('reports failure instead of throwing for a missing video', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ete-prev-'));
    const res = await renderPreview({ video: join(dir, 'nope.webm'), out: join(dir, 'x.png') });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
