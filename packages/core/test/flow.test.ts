import { describe, it, expect } from 'vitest';
import { flowFor } from '../src/flow.js';
import { parseTestFile } from '../src/schema.js';

describe('flowFor', () => {
  it('prefers the declared flow', () => {
    expect(flowFor('e2e/checkout/pay.yaml', 'Login')).toBe('Login');
  });
  it('derives from the directory under e2e, title-cased', () => {
    expect(flowFor('e2e/checkout/pay.yaml')).toBe('Checkout');
    expect(flowFor('e2e/user-login/a.yaml')).toBe('User Login');
    expect(flowFor('e2e/drafting_documents/x.yaml')).toBe('Drafting Documents');
  });
  it('falls back to General for files directly in e2e', () => {
    expect(flowFor('e2e/a.yaml')).toBe('General');
    expect(flowFor('a.yaml')).toBe('General');
  });
});

describe('parseTestFile flow', () => {
  it('reads an optional flow field', () => {
    expect(parseTestFile('name: x\nflow: Checkout\nsteps:\n  - go to /\n').flow).toBe('Checkout');
    expect(parseTestFile('name: x\nsteps:\n  - go to /\n').flow).toBeUndefined();
  });
});
