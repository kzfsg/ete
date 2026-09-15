import { describe, it, expect } from 'vitest';
import { mergeMaps } from '../src/commands/setup.js';
import type { AppMap } from '@ete/core';

const screen = (id: string, sig: string, extra: Partial<AppMap['screens'][number]> = {}) => ({ id, name: id, url: '/', signature: sig, screenshot: `.map/${id}.png`, depth: 0, x: 0, y: 0, ...extra });

describe('mergeMaps', () => {
  it('keeps positions, renamed names, notes, and all cases from the previous map', () => {
    const prev: AppMap = { version: 1, baseUrl: 'http://a', screens: [screen('home', '/|Home', { x: 100, y: 200, name: 'Landing', nameEdited: true, notes: 'hero' }), screen('old', '/old|Old'), screen('auto', '/auto|', { name: '/ · Zoom in' })], edges: [],
      cases: [
        { id: 'c1', title: 'kept', path: ['home'], steps: ['go to /'], status: 'passed', test: 'e2e/x.yaml' },
        { id: 'stale', title: 'stale proposal', path: ['old'], steps: ['go to /'], status: 'proposed' },
        { id: 'recorded-old', title: 'recorded, screen gone', path: ['old'], steps: ['go to /'], status: 'recorded', test: 'e2e/y.yaml' },
      ] };
    const fresh: AppMap = { version: 1, baseUrl: 'http://a', screens: [screen('home', '/|Home', { x: 40, y: 40 }), screen('new', '/new|New', { x: 360, y: 40 }), screen('solo', '/auto|', { name: 'Solo' })], edges: [], cases: [{ id: 'case-new', title: 'a visitor can reach "New"', path: ['new'], steps: [], status: 'proposed' }] };
    const m = mergeMaps(prev, fresh);
    expect(m.screens.find((s) => s.id === 'home')).toMatchObject({ x: 100, y: 200, name: 'Landing', notes: 'hero' });
    expect(m.screens.find((s) => s.id === 'new')).toMatchObject({ x: 360, y: 40 });
    // a crawl-derived name is replaced by the fresh crawl's better name; an edited name is kept
    expect(m.screens.find((s) => s.signature === '/auto|')!.name).toBe('Solo');
    expect(m.screens.some((s) => s.id === 'old')).toBe(false);
    // a proposed case pointing at a screen that no longer exists is dropped; recorded ones stay
    expect(m.cases.map((c) => c.id)).toEqual(['c1', 'recorded-old', 'case-new']);
    expect(m.cases[0]!.status).toBe('passed');
  });
});
