
function titleCase(s: string): string {
  return s.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

/** Declared flow wins; else the directory under `e2e/`; else `General`. */
export function flowFor(testPath: string, declared?: string): string {
  if (declared?.trim()) return declared.trim();
  const parts = testPath.split(/[\\/]/).filter(Boolean);
  const i = parts.indexOf('e2e');
  const dir = i >= 0 ? parts.slice(i + 1, -1) : parts.slice(0, -1);
  return dir.length ? titleCase(dir[0]!) : 'General';
}
