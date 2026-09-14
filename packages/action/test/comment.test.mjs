import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComment, MARKER } from '../scripts/comment.mjs';

const passed = {
  name: 'Login', file: 'e2e/login.yaml', status: 'passed', durationMs: 1500, recording: { videoPath: 'video.webm', tracePath: 'trace.zip' },
  steps: [
    { index: 1, text: 'go to /login', kind: 'action', status: 'passed', durationMs: 100 },
    { index: 2, text: 'click Sign in', kind: 'action', status: 'healed', durationMs: 900,
      healedFrom: { kind: 'click', target: { selector: 'text=Login' } }, entry: { kind: 'click', target: { selector: 'role=button[name="Sign in"]' } } },
  ],
};
const failed = {
  name: 'Checkout', file: 'e2e/checkout.yaml', status: 'failed', durationMs: 700, recording: {},
  steps: [
    { index: 1, text: 'go to /cart', kind: 'action', status: 'passed', durationMs: 100 },
    { index: 2, text: 'click Buy', kind: 'action', status: 'failed', durationMs: 600, error: 'Timeout 5000ms exceeded' },
    { index: 3, text: 'shows receipt', kind: 'expect', status: 'skipped', durationMs: 0 },
  ],
};

test('starts with the sticky marker and summarises every test', () => {
  const md = buildComment([passed, failed], 'https://example.com/artifact');
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /\| Login \| ✅ passed \| 2 \| 1 \|/);
  assert.match(md, /\| Checkout \| ❌ failed \| 3 \| 0 \|/);
});

test('lists steps only for failed tests, with the error', () => {
  const md = buildComment([passed, failed], 'https://example.com/artifact');
  assert.match(md, /❌ 2\. click Buy/);
  assert.match(md, /Timeout 5000ms exceeded/);
  assert.match(md, /⏭️ 3\. expect: shows receipt/);
  assert.doesNotMatch(md, /1\. go to \/login/);
});

test('shows healed steps with old and new entries', () => {
  const md = buildComment([passed], 'https://example.com/artifact');
  assert.match(md, /Healed steps/);
  assert.match(md, /text=Login/);
  assert.match(md, /role=button\[name=\\"Sign in\\"\]/);
  assert.match(md, /ete run/);
});

test('links the artifact and the trace viewer hint', () => {
  const md = buildComment([passed], 'https://example.com/artifact');
  assert.match(md, /https:\/\/example\.com\/artifact/);
  assert.match(md, /playwright show-trace/);
});

test('handles no reports', () => {
  const md = buildComment([], 'https://example.com/artifact');
  assert.match(md, /No test results/);
});
