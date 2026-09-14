import { describe, it, expect } from 'vitest';
import { describeEntry } from '../src/describe.js';

describe('describeEntry', () => {
  it('renders actions as natural-language steps', () => {
    expect(describeEntry({ kind: 'navigate', url: '/login' })).toBe('go to /login');
    expect(describeEntry({ kind: 'click', target: { selector: 'role=button[name="Sign in"]' } })).toBe('click "Sign in"');
    expect(describeEntry({ kind: 'type', target: { selector: 'placeholder=Email' }, text: 'a@b.c' })).toBe('type "a@b.c" into "Email"');
    expect(describeEntry({ kind: 'type', target: { selector: 'css=input[name=email]' }, text: 'a@b.c' })).toBe('type "a@b.c" into input[name=email]');
    expect(describeEntry({ kind: 'press', key: 'Enter' })).toBe('press Enter');
    expect(describeEntry({ kind: 'click', target: { point: { x: 1, y: 2 } } })).toBe('click at (1, 2)');
  });
});
