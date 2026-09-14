import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, parse, sep } from 'node:path';
import type { ResolvedEntry } from './schema.js';

export type ResolvedFile = { version: 1; steps: Record<string, ResolvedEntry> };

export function emptyResolved(): ResolvedFile {
  return { version: 1, steps: {} };
}

export function hashStep(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function loadResolved(path: string): Promise<ResolvedFile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyResolved();
    throw err;
  }
  const parsed = JSON.parse(raw) as ResolvedFile;
  if (parsed.version !== 1) throw new Error(`Unsupported resolved file version in ${path}: ${parsed.version}`);
  return parsed;
}

export async function saveResolved(path: string, file: ResolvedFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2) + '\n');
}

/** `e2e/a/b.yaml` -> `e2e/.resolved/a/b.json` */
export function resolvedPathFor(testPath: string): string {
  const { dir, name } = parse(testPath);
  const segments = dir ? dir.split(sep) : [];
  const [root, ...rest] = segments;
  return root === undefined ? join('.resolved', `${name}.json`) : join(root, '.resolved', ...rest, `${name}.json`);
}
