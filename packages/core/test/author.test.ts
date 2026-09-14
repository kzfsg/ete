import { describe, it, expect } from 'vitest';
import { authorTest, describeEntry } from '../src/author.js';
import { mockModelReturning } from './helpers.js';
import { FakeDriver } from './fake-driver.js';

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

describe('authorTest', () => {
  it('explores with the driver until the model says done, then returns the draft', async () => {
    const driver = new FakeDriver();
    const { model, calls } = mockModelReturning([
      { done: false, nextAction: { kind: 'navigate', url: '/login' } },
      { done: false, nextAction: { kind: 'click', target: { selector: 'role=button[name="Sign in"]' } } },
      { done: true, draftSteps: ['go to /login', 'click "Sign in"', { expect: 'the page shows "Welcome"' }] },
    ]);
    const test = await authorTest({ goal: 'a user can log in', driver, model, baseUrl: 'http://fake' });
    expect(driver.acted.length).toBe(2);
    expect(driver.stopped).toBe(true);
    expect(calls.length).toBe(3);
    expect(test).toEqual({
      name: 'a user can log in',
      target: 'browser',
      steps: [
        { kind: 'action', text: 'go to /login' },
        { kind: 'action', text: 'click "Sign in"' },
        { kind: 'expect', text: 'the page shows "Welcome"' },
      ],
    });
  });

  it('falls back to the actions taken when the model finishes without a draft', async () => {
    const driver = new FakeDriver();
    const { model } = mockModelReturning([
      { done: false, nextAction: { kind: 'navigate', url: '/login' } },
      { done: true },
    ]);
    const test = await authorTest({ goal: 'x', driver, model, baseUrl: 'http://fake' });
    expect(test.steps).toEqual([{ kind: 'action', text: 'go to /login' }]);
  });

  it('stops at maxActions and keeps going after a failed action', async () => {
    const driver = new FakeDriver();
    driver.failOn.add('text=Nope');
    const { model, calls } = mockModelReturning([
      { done: false, nextAction: { kind: 'click', target: { selector: 'text=Nope' } } },
    ]);
    const test = await authorTest({ goal: 'x', driver, model, baseUrl: 'http://fake', maxActions: 3 });
    expect(calls.length).toBe(3);
    expect(test.steps.length).toBe(0);
    const lastPrompt = JSON.stringify(calls[2]);
    expect(lastPrompt).toContain('Timeout');
  });
});
