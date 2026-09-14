import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

export type FilmstripFrame = { path: string; index: number; failed?: boolean };
export type FilmstripResult = { frames: number; width: number; height: number };

export const FRAME_WIDTH = 240;
export const MAX_FRAMES = 12;

/** Keep all items up to `max`; beyond that, sample evenly, always keeping first and last. */
export function sampleFrames<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (items.length - 1)) / (max - 1));
    out.push(items[idx]!);
  }
  return out;
}

/**
 * Renders the step screenshots as one horizontal strip (failed frames outlined in red)
 * by laying them out in a Chromium page and screenshotting it. No image library needed.
 */
export async function renderFilmstrip(opts: { frames: FilmstripFrame[]; out: string; frameWidth?: number; maxFrames?: number }): Promise<FilmstripResult> {
  const frames = sampleFrames(opts.frames, opts.maxFrames ?? MAX_FRAMES);
  if (frames.length === 0) return { frames: 0, width: 0, height: 0 };
  const w = opts.frameWidth ?? FRAME_WIDTH;
  const cells = await Promise.all(
    frames.map(async (f) => {
      const data = (await readFile(f.path)).toString('base64');
      return `<div class="cell${f.failed ? ' failed' : ''}"><img src="data:image/png;base64,${data}"><span>${f.index}</span></div>`;
    }),
  );
  const html = `<!doctype html><html><head><style>
  body{margin:0;background:#fff;font:12px ui-sans-serif,system-ui,sans-serif}
  .strip{display:inline-flex;gap:6px;padding:6px}
  .cell{position:relative;width:${w}px;border:2px solid #e5e5e5;border-radius:4px;overflow:hidden;background:#fafafa;line-height:0}
  .cell.failed{border-color:#dc2626}
  .cell img{width:100%;display:block}
  .cell span{position:absolute;left:4px;top:4px;line-height:1;background:rgba(0,0,0,.65);color:#fff;border-radius:3px;padding:2px 5px}
  .cell.failed span{background:#dc2626}
  </style></head><body><div class="strip" id="strip">${cells.join('')}</div></body></html>`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 4000, height: 800 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    const strip = page.locator('#strip');
    const box = await strip.boundingBox();
    await strip.screenshot({ path: opts.out, type: 'png' });
    return { frames: frames.length, width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) };
  } finally {
    await browser.close();
  }
}
