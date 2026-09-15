import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Driver } from './driver.js';
import type { Observation, ResolvedAction } from './schema.js';

// ---- map model -------------------------------------------------------------

export type MapScreen = { id: string; name: string; url: string; signature: string; screenshot: string; depth: number; x: number; y: number; notes?: string };
export type MapEdge = { id: string; from: string; to: string; action: ResolvedAction; label: string };
export type MapCase = { id: string; title: string; path: string[]; steps: string[]; status: 'proposed' | 'recorded' | 'passed' | 'failed'; test?: string };
export type AppMap = { version: 1; baseUrl: string; screens: MapScreen[]; edges: MapEdge[]; cases: MapCase[] };

export type Interactive = { kind: 'link' | 'button'; name: string; selector: string; href?: string };

const DESTRUCTIVE = /\b(delete|remove|sign ?out|log ?out|logout|pay|purchase|buy|checkout|unsubscribe|deactivate|cancel account|reset)\b/i;

/** Links and buttons worth trying from an accessibility tree, in document order. */
export function interactiveElements(tree: string, pageUrl: string): Interactive[] {
  const lines = tree.split('\n');
  const out: Interactive[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-\s+(link|button)\s+"((?:[^"\\]|\\.)*)"/.exec(lines[i]!);
    if (!m) continue;
    const kind = m[1] as 'link' | 'button';
    const name = m[2]!.replace(/\\"/g, '"');
    if (!name.trim() || DESTRUCTIVE.test(name)) continue;
    let href: string | undefined;
    if (kind === 'link') {
      const next = lines[i + 1] ?? '';
      const u = /^\s*-\s+\/url:\s*(.+)$/.exec(next);
      href = u?.[1]?.trim();
      if (href) {
        if (/^(mailto:|tel:|javascript:|#)/.test(href)) continue;
        if (/^https?:\/\//.test(href)) {
          try { if (new URL(href).origin !== new URL(pageUrl).origin) continue; } catch { continue; }
        }
        if (/\.(pdf|zip|dmg|exe|csv)$/i.test(href)) continue;
      }
    }
    const key = `${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, name, selector: `role=${kind}[name="${name.replace(/"/g, '\\"')}"]`, ...(href ? { href } : {}) });
  }
  return out;
}

/** URL path + top headings + dialog presence. Query strings and hashes are ignored. */
export function screenSignature(obs: Observation): string {
  let path = '/';
  try { path = new URL(obs.url ?? 'http://x/').pathname.replace(/\/+$/, '') || '/'; } catch { /* keep */ }
  const tree = obs.a11yTree ?? '';
  const headings = [...tree.matchAll(/^\s*-\s+heading\s+"((?:[^"\\]|\\.)*)"\s+\[level=([12])\]/gm)].map((m) => m[1]!).slice(0, 3);
  const dialog = /^\s*-\s+(dialog|alertdialog)\b/m.test(tree) ? '|dialog' : '';
  return `${path}|${headings.join('|')}${dialog}`;
}

function screenName(obs: Observation, fallback: string): string {
  const h = /^\s*-\s+heading\s+"((?:[^"\\]|\\.)*)"\s+\[level=[12]\]/m.exec(obs.a11yTree ?? '');
  return h?.[1] ?? fallback;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'screen';

/** Columns by depth, rows within a column. Only touches screens that have no position yet unless `force`. */
export function layoutScreens(map: AppMap, opts: { force?: boolean } = {}): void {
  const colW = 320, rowH = 260;
  const byDepth = new Map<number, MapScreen[]>();
  for (const s of map.screens) byDepth.set(s.depth, [...(byDepth.get(s.depth) ?? []), s]);
  for (const [depth, col] of byDepth) {
    col.forEach((s, i) => {
      if (opts.force || (s.x === 0 && s.y === 0)) { s.x = 40 + depth * colW; s.y = 40 + i * rowH; }
    });
  }
}

// ---- crawler ---------------------------------------------------------------

export type CrawlLimits = { maxScreens: number; maxDepth: number; maxActionsPerScreen: number };
export type CrawlOptions = { driver: Driver; baseUrl: string; outDir: string; limits?: Partial<CrawlLimits>; log?: (line: string) => void };

const DEFAULT_LIMITS: CrawlLimits = { maxScreens: 40, maxDepth: 4, maxActionsPerScreen: 12 };

/**
 * Breadth-first exploration of the app through the Driver: every screen is reached by replaying
 * the actions from the root, so state is fresh for each attempt. No model involved.
 */
export async function crawl(o: CrawlOptions): Promise<AppMap> {
  const limits = { ...DEFAULT_LIMITS, ...o.limits };
  const log = o.log ?? (() => {});
  const { driver } = o;
  const shotsDir = join(o.outDir, '.map');
  await mkdir(shotsDir, { recursive: true });
  await driver.start({ baseUrl: o.baseUrl, resultsDir: o.outDir });

  const map: AppMap = { version: 1, baseUrl: o.baseUrl, screens: [], edges: [], cases: [] };
  const bySig = new Map<string, MapScreen>();
  const pathTo = new Map<string, ResolvedAction[]>(); // screen id -> actions from root
  const parentOf = new Map<string, string>(); // screen id -> first discovered parent
  const queue: string[] = [];
  const isAncestor = (candidate: string, of: string): boolean => {
    for (let cur: string | undefined = of; cur; cur = parentOf.get(cur)) if (cur === candidate) return true;
    return false;
  };
  const usedIds = new Set<string>();

  const idFor = (name: string) => {
    let id = slug(name), n = 2;
    while (usedIds.has(id)) id = `${slug(name)}-${n++}`;
    usedIds.add(id);
    return id;
  };

  async function replay(actions: ResolvedAction[]): Promise<void> {
    await driver.act({ kind: 'navigate', url: '/' });
    for (const a of actions) await driver.act(a);
  }

  async function addScreen(obs: Observation, sig: string, depth: number, actions: ResolvedAction[], parent?: string): Promise<MapScreen> {
    const name = screenName(obs, new URL(obs.url ?? o.baseUrl).pathname);
    const id = idFor(name);
    const screenshot = `.map/${id}.png`;
    await driver.screenshot(join(o.outDir, screenshot));
    const screen: MapScreen = { id, name, url: obs.url ?? '', signature: sig, screenshot, depth, x: 0, y: 0 };
    map.screens.push(screen);
    bySig.set(sig, screen);
    pathTo.set(id, actions);
    if (parent) parentOf.set(id, parent);
    queue.push(id);
    log(`+ screen "${name}" (${sig})`);
    return screen;
  }

  try {
    await replay([]);
    const rootObs = await driver.observe();
    await addScreen(rootObs, screenSignature(rootObs), 0, []);

    while (queue.length && map.screens.length < limits.maxScreens) {
      const fromId = queue.shift()!;
      const from = map.screens.find((s) => s.id === fromId)!;
      if (from.depth >= limits.maxDepth) continue;
      const base = pathTo.get(fromId)!;
      await replay(base);
      const obs = await driver.observe();
      const els = interactiveElements(obs.a11yTree ?? '', obs.url ?? o.baseUrl).slice(0, limits.maxActionsPerScreen);
      for (const el of els) {
        if (map.screens.length >= limits.maxScreens) break;
        const action: ResolvedAction = { kind: 'click', target: { selector: el.selector } };
        try {
          await replay(base);
          await driver.act(action);
        } catch (err) {
          log(`  ✗ ${el.selector}: ${(err as Error).message.split('\n')[0]}`);
          continue;
        }
        const after = await driver.observe();
        const sig = screenSignature(after);
        if (sig === from.signature) continue; // no visible change
        let to = bySig.get(sig);
        if (!to) to = await addScreen(after, sig, from.depth + 1, [...base, action], from.id);
        // Going back up the tree (Home, Back, logo) is navigation noise, not a flow.
        if (isAncestor(to.id, from.id)) continue;
        const label = `click "${el.name}"`;
        if (!map.edges.some((e) => e.from === from.id && e.to === to!.id)) {
          map.edges.push({ id: `${from.id}->${to.id}`, from: from.id, to: to.id, action, label });
        }
      }
    }
  } finally {
    await driver.stop();
  }

  layoutScreens(map);
  map.cases = proposeCases(map);
  return map;
}

/** One case per leaf screen: the shortest path from the root, as plain steps. */
export function proposeCases(map: AppMap): MapCase[] {
  const root = map.screens[0];
  if (!root) return [];
  const parent = new Map<string, { from: string; edge: MapEdge }>();
  const seen = new Set([root.id]);
  const q = [root.id];
  while (q.length) {
    const id = q.shift()!;
    for (const e of map.edges.filter((e) => e.from === id)) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      parent.set(e.to, { from: id, edge: e });
      q.push(e.to);
    }
  }
  const hasChildren = new Set(map.edges.map((e) => e.from));
  return map.screens
    .filter((s) => s.id !== root.id && !hasChildren.has(s.id) && parent.has(s.id))
    .map((leaf) => {
      const path: string[] = [];
      const steps: string[] = [];
      let cur = leaf.id;
      while (cur !== root.id) {
        const p = parent.get(cur)!;
        path.unshift(cur);
        steps.unshift(p.edge.label);
        cur = p.from;
      }
      return { id: `case-${leaf.id}`, title: `a visitor can reach "${leaf.name}"`, path, steps: ['go to /', ...steps, `expect: the page shows "${leaf.name}"`], status: 'proposed' as const };
    });
}
