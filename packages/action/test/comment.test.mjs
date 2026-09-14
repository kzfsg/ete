import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComment, MARKER } from '../scripts/comment.mjs';

const step = (index, text, status, extra = {}) => ({ index, text, kind: 'action', status, durationMs: 100, anomalies: [], ...extra });
const login = {
  name: 'Sign in with valid credentials', file: 'e2e/login/sign-in.yaml', flow: 'Login', mode: 'replay', status: 'passed', durationMs: 3100, anomalyCount: 0,
  recording: { videoPath: 'video.webm', tracePath: 'trace.zip', filmstripPath: 'filmstrip.png' },
  steps: [step(1, 'go to /login', 'passed'), step(2, 'click Sign in', 'healed', { healedFrom: { kind: 'click', target: { selector: 'text=Login' } }, entry: { kind: 'click', target: { selector: 'role=button[name="Sign in"]' } } })],
};
const wrongPw = {
  name: 'Wrong password shows an error', file: 'e2e/login/wrong-password.yaml', flow: 'Login', mode: 'replay', status: 'passed', durationMs: 2400, anomalyCount: 1,
  recording: { videoPath: 'video.webm', tracePath: 'trace.zip', filmstripPath: 'filmstrip.png' },
  steps: [step(1, 'go to /login', 'passed', { anomalies: [{ t: 10, kind: 'console-error', message: 'boom' }] })],
};
const pay = {
  name: 'Pay with saved card', file: 'e2e/checkout/pay.yaml', flow: 'Checkout', mode: 'replay', status: 'failed', durationMs: 700, anomalyCount: 0,
  recording: { videoPath: 'video.webm', tracePath: 'trace.zip', filmstripPath: 'filmstrip.png' },
  steps: [step(1, 'go to /cart', 'passed'), { ...step(2, 'shows Order confirmed', 'failed', { error: 'Assertion failed: {"kind":"textVisible","text":"Order confirmed"}' }), kind: 'expect' }, step(3, 'shows receipt', 'skipped')],
};
const opts = { artifactUrl: 'https://example.com/artifact', mediaBase: 'https://raw.githubusercontent.com/acme/shop/ete-media/runs/1-1', timelineUrl: 'https://acme.github.io/shop/runs/1-1/index.html' };

test('starts with the marker and a headline with anomalies', () => {
  const md = buildComment([login, wrongPw, pay], opts);
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /2\/3 passed · 1 anomaly/);
});

test('groups tests by flow with per-flow counts and links', () => {
  const md = buildComment([login, wrongPw, pay], opts);
  assert.match(md, /### Login — 2\/2 passed/);
  assert.match(md, /### Checkout — 0\/1 passed/);
  assert.ok(md.indexOf('### Checkout') < md.indexOf('### Login'), 'flows sorted alphabetically');
  assert.match(md, /\[▶ timeline\]\(https:\/\/acme\.github\.io\/shop\/runs\/1-1\/index\.html#pay\)/);
  assert.match(md, /\[trace\]\(https:\/\/trace\.playwright\.dev\/\?trace=https:\/\/raw\.githubusercontent\.com\/acme\/shop\/ete-media\/runs\/1-1\/pay\/trace\.zip\)/);
});

test('embeds one filmstrip per test when media is published', () => {
  const md = buildComment([login, pay], opts);
  assert.match(md, /!\[Sign in with valid credentials\]\(https:\/\/raw\.githubusercontent\.com\/acme\/shop\/ete-media\/runs\/1-1\/sign-in\/filmstrip\.png\)/);
  assert.match(md, /!\[Pay with saved card\]\([^)]*\/pay\/filmstrip\.png\)/);
});

test('lists each test with status, duration, anomalies, and the failing step inline', () => {
  const md = buildComment([login, wrongPw, pay], opts);
  assert.match(md, /✅ Sign in with valid credentials · 3\.1s/);
  assert.match(md, /✅ Wrong password shows an error · 2\.4s · ⚠️ 1 anomaly/);
  assert.match(md, /❌ Pay with saved card · 0\.7s — step 2: expect shows Order confirmed · Assertion failed/);
});

test('shows healed steps and the artifact link', () => {
  const md = buildComment([login], opts);
  assert.match(md, /🩹 1 step healed/);
  assert.match(md, /text=Login/);
  assert.match(md, /https:\/\/example\.com\/artifact/);
});

test('falls back to no images or timeline links when media is not published', () => {
  const md = buildComment([login, pay], { artifactUrl: 'https://example.com/artifact' });
  assert.doesNotMatch(md, /filmstrip\.png/);
  assert.doesNotMatch(md, /timeline/);
  assert.doesNotMatch(md, /trace\.playwright\.dev/);
  assert.match(md, /### Login/);
  assert.match(md, /playwright show-trace/);
});

test('handles no reports', () => {
  assert.match(buildComment([], { artifactUrl: 'x' }), /No test results/);
});
