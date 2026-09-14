import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { publish } from '../scripts/publish.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ete-pub-'));
  const remote = join(root, 'remote.git');
  await mkdir(remote);
  git(remote, 'init', '--bare', '-q', '-b', 'main');
  const repo = join(root, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'ci@example.com');
  git(repo, 'config', 'user.name', 'ci');
  await writeFile(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  const results = join(root, 'ete-results');
  await mkdir(join(results, 'login', 'steps'), { recursive: true });
  await writeFile(join(results, 'login', 'report.json'), JSON.stringify({ name: 'Login', file: 'e2e/login.yaml', status: 'passed', durationMs: 1, recording: {}, steps: [] }));
  await writeFile(join(results, 'login', 'filmstrip.png'), 'png');
  await writeFile(join(results, 'index.html'), '<html>');
  return { root, remote, repo, results };
}

function lsRemote(remote, branch, path) {
  return git(remote, 'ls-tree', '-r', '--name-only', branch, path ?? '.').split('\n').filter(Boolean);
}

test('publishes results to an orphan media branch and returns urls', async () => {
  const { remote, repo, results } = await setup();
  const out = await publish({ resultsDir: results, repoDir: repo, branch: 'ete-media', runId: '111-1', retentionDays: 30, repository: 'acme/shop', now: new Date('2026-09-14T00:00:00Z') });
  assert.equal(out.runDir, 'runs/111-1');
  assert.equal(out.rawBase, 'https://raw.githubusercontent.com/acme/shop/ete-media/runs/111-1');
  const files = lsRemote(remote, 'ete-media');
  assert.ok(files.includes('runs/111-1/login/report.json'));
  assert.ok(files.includes('runs/111-1/login/filmstrip.png'));
  assert.ok(files.includes('runs/111-1/index.html'));
  assert.ok(files.includes('runs/111-1/.published'));
  // main is untouched
  assert.deepEqual(lsRemote(remote, 'main'), ['README.md']);
  // working tree of the repo is untouched
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
});

test('a second publish keeps recent runs and prunes ones past retention', async () => {
  const { remote, repo, results } = await setup();
  await publish({ resultsDir: results, repoDir: repo, branch: 'ete-media', runId: 'old-1', retentionDays: 30, repository: 'acme/shop', now: new Date('2026-08-01T00:00:00Z') });
  await publish({ resultsDir: results, repoDir: repo, branch: 'ete-media', runId: 'recent-1', retentionDays: 30, repository: 'acme/shop', now: new Date('2026-09-10T00:00:00Z') });
  await publish({ resultsDir: results, repoDir: repo, branch: 'ete-media', runId: 'new-1', retentionDays: 30, repository: 'acme/shop', now: new Date('2026-09-14T00:00:00Z') });
  const files = lsRemote(remote, 'ete-media');
  assert.ok(!files.some((f) => f.startsWith('runs/old-1/')), 'old run pruned');
  assert.ok(files.some((f) => f.startsWith('runs/recent-1/')), 'recent run kept');
  assert.ok(files.some((f) => f.startsWith('runs/new-1/')), 'new run kept');
});
