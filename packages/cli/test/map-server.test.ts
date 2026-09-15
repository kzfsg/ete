import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMapServer, type AgentRunner, type MapServer } from '../src/map/server.js';
import { buildPrompt } from '../src/map/prompt.js';
import type { AppMap } from '@ete/core';

const map: AppMap = {
  version: 1, baseUrl: 'http://localhost:3000',
  screens: [
    { id: 'welcome', name: 'Welcome', url: 'http://localhost:3000/', signature: '/|Welcome', screenshot: '.map/welcome.png', depth: 0, x: 40, y: 40 },
    { id: 'notes', name: 'Notes', url: 'http://localhost:3000/blog', signature: '/blog|Notes', screenshot: '.map/notes.png', depth: 1, x: 360, y: 40 },
  ],
  edges: [{ id: 'welcome->notes', from: 'welcome', to: 'notes', action: { kind: 'click', target: { selector: 'role=link[name="Blog"]' } }, label: 'click "Blog"' }],
  cases: [{ id: 'case-notes', title: 'a visitor can reach "Notes"', path: ['notes'], steps: ['go to /', 'click "Blog"', 'expect: the page shows "Notes"'], status: 'proposed' }],
};

async function project(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'ete-mapsrv-'));
  await mkdir(join(cwd, 'e2e', '.map'), { recursive: true });
  await writeFile(join(cwd, 'e2e', 'map.json'), JSON.stringify(map));
  await writeFile(join(cwd, 'e2e', '.map', 'welcome.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await writeFile(join(cwd, 'ete.yaml'), 'url: http://localhost:3000\n');
  return cwd;
}

function fakeAgent(lines: string[] = ['thinking…', 'done']): { runner: AgentRunner; calls: { prompt: string; cwd: string }[] } {
  const calls: { prompt: string; cwd: string }[] = [];
  const runner: AgentRunner = async ({ prompt, cwd, onLine }) => { calls.push({ prompt, cwd }); for (const l of lines) onLine(l); return { ok: true }; };
  return { runner, calls };
}

async function sse(res: Response): Promise<string[]> {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((chunk) => chunk.replace(/^data: /, ''));
}

describe('map server', () => {
  it('serves the canvas, the map, and screenshots', async () => {
    const cwd = await project();
    const s: MapServer = await startMapServer({ cwd, agent: fakeAgent().runner, port: 0 });
    try {
      const html = await (await fetch(`http://127.0.0.1:${s.port}/`)).text();
      expect(html).toContain('id="canvas"');
      const m = await (await fetch(`http://127.0.0.1:${s.port}/api/map`)).json();
      expect(m.screens.length).toBe(2);
      const shot = await fetch(`http://127.0.0.1:${s.port}/shots/welcome.png`);
      expect(shot.status).toBe(200);
      expect(shot.headers.get('content-type')).toBe('image/png');
    } finally { await s.close(); }
  });

  it('saves edits from the canvas back to e2e/map.json', async () => {
    const cwd = await project();
    const s = await startMapServer({ cwd, agent: fakeAgent().runner, port: 0 });
    try {
      const edited = { ...map, screens: map.screens.map((x) => (x.id === 'notes' ? { ...x, x: 999, name: 'Blog list' } : x)) };
      const res = await fetch(`http://127.0.0.1:${s.port}/api/map`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edited) });
      expect(res.status).toBe(200);
      const onDisk = JSON.parse(await readFile(join(cwd, 'e2e', 'map.json'), 'utf8'));
      expect(onDisk.screens[1]).toMatchObject({ x: 999, name: 'Blog list' });
    } finally { await s.close(); }
  });

  it('streams the agent output for a prompt and gives the agent the map context', async () => {
    const cwd = await project();
    const { runner, calls } = fakeAgent(['reading map', 'added case']);
    const s = await startMapServer({ cwd, agent: runner, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'add a case for the blog search' }) });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const events = await sse(res);
      expect(events.some((e) => e.includes('reading map'))).toBe(true);
      expect(events.some((e) => e.includes('"type":"done"'))).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0]!.cwd).toBe(cwd);
      expect(calls[0]!.prompt).toContain('add a case for the blog search');
      expect(calls[0]!.prompt).toContain('e2e/map.json');
      expect(calls[0]!.prompt).toContain('Welcome');
    } finally { await s.close(); }
  });

  it('run records every proposed case through the agent, then replays and reports', async () => {
    const cwd = await project();
    const { runner, calls } = fakeAgent();
    let ran = 0;
    const s = await startMapServer({ cwd, agent: runner, port: 0, runTests: async () => { ran++; return 0; } });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/run`, { method: 'POST' });
      const events = await sse(res);
      expect(calls.length).toBe(1);
      expect(calls[0]!.prompt).toContain('a visitor can reach "Notes"');
      expect(calls[0]!.prompt).toContain('ete session start');
      expect(ran).toBe(1);
      expect(events.some((e) => e.includes('"type":"done"'))).toBe(true);
    } finally { await s.close(); }
  });
});

describe('buildPrompt', () => {
  it('summarises screens, edges, and cases for the agent', () => {
    const p = buildPrompt(map, 'add a case', 'e2e/map.json');
    expect(p).toMatch(/Welcome.*→.*Notes/s);
    expect(p).toContain('click "Blog"');
    expect(p).toContain('proposed');
    expect(p).toContain('add a case');
  });
});
