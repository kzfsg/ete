import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComment, MARKER } from '../scripts/comment.mjs';

const step = (index, text, status, extra = {}) => ({ index, text, kind: 'action', status, durationMs: 100, anomalies: [], screenshot: `steps/0${index}.png`, ...extra });
const login = {
  name: 'Sign in with valid credentials', file: 'e2e/login/sign-in.yaml', flow: 'Login', mode: 'replay', status: 'passed', durationMs: 3100, anomalyCount: 0,
  recording: { videoPath: 'video.webm', tracePath: 'trace.zip', filmstripPath: 'filmstrip.png' },
  steps: [step(1, 'go to /login', 'passed'), step(2, 'click Sign in', 'passed')],
};
const wrongPw = {
  name: 'Wrong password shows an error', file: 'e2e/login/wrong-password.yaml', flow: 'Login', mode: 'replay', status: 'passed', durationMs: 2400, anomalyCount: 1,
  recording: { videoPath: 'video.webm', tracePath: 'trace.zip' },
  steps: [step(1, 'go to /login', 'passed', { anomalies: [{ t: 10, kind: 'console-error', message: 'boom' }] })],
};
const pay = {
  name: 'Pay with saved card', file: 'e2e/checkout/pay.yaml', flow: 'Checkout', mode: 'replay', status: 'failed', durationMs: 700, anomalyCount: 0,
  recording: { videoPath: 'video.webm', tracePath: 'trace.zip' },
  steps: [step(1, 'go to /cart', 'passed'), { ...step(2, 'shows Order confirmed', 'failed', { error: 'Assertion failed: {"kind":"textVisible","text":"Order confirmed"}' }), kind: 'expect' }, step(3, 'shows receipt', 'skipped')],
};
const hosted = { artifactUrl: 'https://example.com/artifact', reportUrl: 'https://ete-shop-abc.vercel.app', run: { id: '42', attempt: '2', at: '2026-09-14T21:54:44Z' } };

test('headline links the hosted report and shows when it was updated', () => {
  const md = buildComment([login, wrongPw, pay], hosted);
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /\*\*2\/3 passed · 1 anomaly\*\* · \*\*\[▶ open report\]\(https:\/\/ete-shop-abc\.vercel\.app\)\*\*/);
  assert.match(md, /<sub>Updated 2026-09-14 21:54 UTC · run 42 \(attempt 2\)<\/sub>/);
});

test('groups by flow with timeline and trace links per test', () => {
  const md = buildComment([login, wrongPw, pay], hosted);
  assert.match(md, /### Checkout — 0\/1 passed/);
  assert.match(md, /### Login — 2\/2 passed/);
  assert.ok(md.indexOf('### Checkout') < md.indexOf('### Login'));
  assert.match(md, /✅ Sign in with valid credentials · 3\.1s  \[▶ timeline\]\(https:\/\/ete-shop-abc\.vercel\.app\/#sign-in\) · \[trace\]\(https:\/\/trace\.playwright\.dev\/\?trace=https:\/\/ete-shop-abc\.vercel\.app\/sign-in\/trace\.zip\)/);
  assert.match(md, /✅ Wrong password shows an error · 2\.4s · ⚠️ 1 anomaly/);
});

test('failed tests show the failing step, the fix command, and the step screenshot inline', () => {
  const md = buildComment([pay], hosted);
  assert.match(md, /❌ Pay with saved card · 0\.7s/);
  assert.match(md, /- step 2: expect shows Order confirmed · Assertion failed/);
  assert.match(md, /- fix: `ete session start --from e2e\/checkout\/pay\.yaml --at 2`/);
  assert.match(md, /!\[step 2\]\(https:\/\/ete-shop-abc\.vercel\.app\/pay\/steps\/02\.png\)/);
  assert.doesNotMatch(md, /!\[step 1\]/);
});

test('passing tests never embed images', () => {
  assert.doesNotMatch(buildComment([login], hosted), /!\[/);
});

test('without a hosted report it falls back to text and the artifact link', () => {
  const md = buildComment([login, pay], { artifactUrl: 'https://example.com/artifact' });
  assert.doesNotMatch(md, /open report|timeline|trace\.playwright\.dev|!\[/);
  assert.match(md, /fix: `ete session start/);
  assert.match(md, /https:\/\/example\.com\/artifact/);
  assert.match(md, /playwright show-trace/);
});

test('handles no reports', () => {
  assert.match(buildComment([], { artifactUrl: 'x' }), /No test results/);
});
