import { describe, it, expect } from 'vitest';
import { parseTestFile } from '../src/schema.js';

describe('parseTestFile', () => {
  it('parses action and expect steps', () => {
    const t = parseTestFile(`name: Login\nsteps:\n  - go to /login\n  - expect: the page shows "Welcome"\n`);
    expect(t.name).toBe('Login');
    expect(t.target).toBe('browser');
    expect(t.steps).toEqual([
      { kind: 'action', text: 'go to /login' },
      { kind: 'expect', text: 'the page shows "Welcome"' },
    ]);
  });

  it('rejects unknown step shapes', () => {
    expect(() => parseTestFile(`name: x\nsteps:\n  - foo: bar\n`)).toThrow();
  });

  it('rejects an empty step list', () => {
    expect(() => parseTestFile(`name: x\nsteps: []\n`)).toThrow();
  });
});
