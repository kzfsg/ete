import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeploymentUrl, VERCEL_JSON } from '../scripts/deploy.mjs';

test('parses the deployment url from plain and json cli output', () => {
  assert.equal(parseDeploymentUrl('https://ete-x-abc123-team.vercel.app\n'), 'https://ete-x-abc123-team.vercel.app');
  assert.equal(parseDeploymentUrl('{"deployment":{"url":"https://ete-x-abc123-team.vercel.app","inspectorUrl":"https://vercel.com/x"}}'), 'https://ete-x-abc123-team.vercel.app');
  assert.equal(parseDeploymentUrl('Error: nope'), undefined);
});

test('vercel.json allows cross-origin fetches so the hosted trace viewer can load traces', () => {
  const cors = VERCEL_JSON.headers.find((h) => h.source === '/(.*)');
  assert.deepEqual(cors.headers, [{ key: 'Access-Control-Allow-Origin', value: '*' }]);
});
