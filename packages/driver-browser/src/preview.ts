import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { buildApng } from './apng.js';

const exec = promisify(execFile);

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Default Playwright browsers cache, mirroring Playwright's own resolution. */
function browsersRoot(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright');
}

/**
 * Path to the ffmpeg Playwright installs with Chromium. It is a minimal build (PNG/webm only),
 * which is enough to extract frames. Falls back to `ffmpeg` on PATH.
 */
export async function ffmpegPath(): Promise<string> {
  try {
    const require = createRequire(import.meta.url);
    // browsers.json is not in the package's exports; resolve package.json (which is) and read it from the same dir.
    const browsersJson = join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
    const { browsers } = JSON.parse(await readFile(browsersJson, 'utf8')) as { browsers: { name: string; revision: string }[] };
    const rev = browsers.find((b) => b.name === 'ffmpeg')?.revision;
    if (rev) {
      const dir = join(browsersRoot(), `ffmpeg-${rev}`);
      const names = process.platform === 'darwin' ? ['ffmpeg-mac-arm64', 'ffmpeg-mac'] : process.platform === 'win32' ? ['ffmpeg-win64.exe'] : ['ffmpeg-linux'];
      for (const n of names) if (await exists(join(dir, n))) return join(dir, n);
    }
  } catch {
    /* fall through to PATH */
  }
  return 'ffmpeg';
}

export type PreviewOptions = { video: string; out: string; fps?: number; width?: number; maxSeconds?: number };
export type PreviewResult = { ok: boolean; frames?: number; error?: string };

/**
 * Renders an animated PNG preview of a recorded video: frames are extracted with Playwright's
 * ffmpeg and stitched into an APNG in-process, so no extra tooling is needed. Never throws.
 */
export async function renderPreview(o: PreviewOptions): Promise<PreviewResult> {
  const fps = o.fps ?? 4;
  const width = o.width ?? 640;
  const maxSeconds = o.maxSeconds ?? 60;
  const tmp = await mkdtemp(join(tmpdir(), 'ete-frames-'));
  try {
    if (!(await exists(o.video))) return { ok: false, error: `video not found: ${o.video}` };
    const bin = await ffmpegPath();
    await exec(bin, ['-y', '-hide_banner', '-loglevel', 'error', '-t', String(maxSeconds), '-i', o.video, '-r', String(fps), '-vf', `scale=${width}:-2`, '-f', 'image2', join(tmp, 'f%04d.png')], { timeout: 120_000 });
    const names = (await readdir(tmp)).filter((n) => n.endsWith('.png')).sort();
    if (names.length === 0) return { ok: false, error: 'ffmpeg produced no frames' };
    const frames = await Promise.all(names.map((n) => readFile(join(tmp, n))));
    await writeFile(o.out, buildApng(frames, 1000 / fps));
    return { ok: true, frames: frames.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
