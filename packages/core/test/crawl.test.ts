import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interactiveElements, screenSignature, layoutScreens, crawl, type AppMap } from '../src/crawl.js';
import type { Driver, DriverStartOptions } from '../src/driver.js';
import type { Observation, ResolvedAction, ResolvedAssertion, StepTelemetry } from '../src/schema.js';

const png = Buffer.from('89504e470d0a1a0a', 'hex');

/** An in-memory app: states with an accessibility tree; clicking a named control moves state. */
type State = { url: string; tree: string; go: Record<string, string> };
class FakeApp implements Driver {
  state = 'home';
  screenshots: string[] = [];
  navigations = 0;
  constructor(public states: Record<string, State>) {}
  async start(_: DriverStartOptions) {}
  async observe(): Promise<Observation> { const s = this.states[this.state]!; return { screenshotPng: png, a11yTree: s.tree, url: 'http://app' + s.url }; }
  async act(a: ResolvedAction) {
    if (a.kind === 'navigate') { this.navigations++; this.state = 'home'; return; }
    if (a.kind === 'click' && 'selector' in a.target) {
      const name = /name="([^"]+)"/.exec(a.target.selector)?.[1] ?? '';
      const next = this.states[this.state]!.go[name];
      if (!next) throw new Error(`Timeout: no control "${name}" on ${this.state}`);
      this.state = next;
    }
  }
  async check(_: ResolvedAssertion) { return true; }
  async screenshot(p: string) { this.screenshots.push(p); }
  async beginStep() {}
  async endStep(): Promise<StepTelemetry> { return { startMs: 0, endMs: 1, anomalies: [] }; }
  async stop() { return {}; }
}

const app = new FakeApp({
  home: { url: '/', tree: '- heading "Welcome" [level=1]\n- link "Blog":\n  - /url: /blog\n- button "Begin"\n- link "Privacy":\n  - /url: /privacy\n- link "Twitter":\n  - /url: https://twitter.com/x\n- link "Delete account":\n  - /url: /delete', go: { Blog: 'blog', Begin: 'menu', Privacy: 'privacy' } },
  blog: { url: '/blog', tree: '- heading "Notes" [level=1]\n- link "Home":\n  - /url: /\n- link "First post":\n  - /url: /blog/first', go: { Home: 'home', 'First post': 'post' } },
  post: { url: '/blog/first', tree: '- heading "First post" [level=1]\n- link "Home":\n  - /url: /', go: { Home: 'home' } },
  menu: { url: '/', tree: '- heading "Choose Mode" [level=2]\n- button "Solo"\n- button "Back"', go: { Solo: 'solo', Back: 'home' } },
  solo: { url: '/', tree: '- heading "Round 1" [level=2]\n- button "Submit"', go: {} },
  privacy: { url: '/privacy', tree: '- heading "Privacy" [level=1]\n- link "Home":\n  - /url: /', go: { Home: 'home' } },
});

describe('interactiveElements', () => {
  it('extracts links and buttons with selectors, skipping external, mailto, and destructive ones', () => {
    const els = interactiveElements(app.states.home!.tree, 'http://app/');
    expect(els).toEqual([
      { kind: 'link', name: 'Blog', selector: 'role=link[name="Blog"]', href: '/blog' },
      { kind: 'button', name: 'Begin', selector: 'role=button[name="Begin"]' },
      { kind: 'link', name: 'Privacy', selector: 'role=link[name="Privacy"]', href: '/privacy' },
    ]);
  });
});

describe('screenSignature', () => {
  it('combines the path, top headings, and dialog presence; ignores query strings', () => {
    const a = screenSignature({ screenshotPng: png, url: 'http://app/blog?x=1', a11yTree: '- heading "Notes" [level=1]\n- link "Home"' });
    const b = screenSignature({ screenshotPng: png, url: 'http://app/blog', a11yTree: '- heading "Notes" [level=1]\n- link "Other"' });
    const c = screenSignature({ screenshotPng: png, url: 'http://app/blog', a11yTree: '- heading "Notes" [level=1]\n- dialog "Confirm"' });
    expect(a).toBe(b);
    expect(c).not.toBe(b);
    expect(a).toBe('/blog|Notes');
  });
});

describe('crawl', () => {
  it('discovers screens breadth-first, dedupes by signature, records edges, and screenshots each screen', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'ete-map-'));
    const map = await crawl({ driver: app, baseUrl: 'http://app', outDir, limits: { maxScreens: 40, maxDepth: 4, maxActionsPerScreen: 12 } });
    const names = map.screens.map((s) => s.name).sort();
    expect(names).toEqual(['Choose Mode', 'First post', 'Notes', 'Privacy', 'Round 1', 'Welcome']);
    expect(map.screens.find((s) => s.name === 'Welcome')!.depth).toBe(0);
    expect(map.screens.find((s) => s.name === 'Round 1')!.depth).toBe(2);
    const labels = map.edges.map((e) => `${map.screens.find((s) => s.id === e.from)!.name} -[${e.label}]-> ${map.screens.find((s) => s.id === e.to)!.name}`).sort();
    expect(labels).toEqual([
      'Choose Mode -[click "Solo"]-> Round 1',
      'Notes -[click "First post"]-> First post',
      'Welcome -[click "Begin"]-> Choose Mode',
      'Welcome -[click "Blog"]-> Notes',
      'Welcome -[click "Privacy"]-> Privacy',
    ]);
    expect(map.screens.every((s) => s.screenshot.startsWith('.map/') && s.screenshot.endsWith('.png'))).toBe(true);
    expect(app.screenshots.length).toBe(6);
    expect(map.screens.every((s) => typeof s.x === 'number' && typeof s.y === 'number')).toBe(true);
    // one proposed case per leaf path
    const titles = map.cases.map((c) => c.title).sort();
    expect(titles).toEqual(['a visitor can reach "First post"', 'a visitor can reach "Privacy"', 'a visitor can reach "Round 1"']);
    const solo = map.cases.find((c) => c.title.includes('Round 1'))!;
    expect(solo.steps).toEqual(['go to /', 'click "Begin"', 'click "Solo"', 'expect: the page shows "Round 1"']);
    expect(solo.status).toBe('proposed');
    expect(solo.path).toEqual(["choose-mode", "round-1"]);
  });

  it('respects the screen limit', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'ete-map-'));
    const map = await crawl({ driver: new FakeApp(app.states), baseUrl: 'http://app', outDir, limits: { maxScreens: 3, maxDepth: 4, maxActionsPerScreen: 12 } });
    expect(map.screens.length).toBe(3);
  });
});

describe('layoutScreens', () => {
  it('places screens in columns by depth and rows within a column', () => {
    const m: AppMap = { version: 1, baseUrl: 'http://app', screens: [
      { id: 'a', name: 'A', url: '/', signature: 'a', screenshot: '', depth: 0, x: 0, y: 0 },
      { id: 'b', name: 'B', url: '/b', signature: 'b', screenshot: '', depth: 1, x: 0, y: 0 },
      { id: 'c', name: 'C', url: '/c', signature: 'c', screenshot: '', depth: 1, x: 0, y: 0 },
    ], edges: [], cases: [] };
    layoutScreens(m);
    expect(m.screens[0]!.x).toBeLessThan(m.screens[1]!.x);
    expect(m.screens[1]!.x).toBe(m.screens[2]!.x);
    expect(m.screens[1]!.y).toBeLessThan(m.screens[2]!.y);
  });
});
