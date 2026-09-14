import { describe, it, expect } from 'vitest';
import { renderHtml, markersFor } from '../src/report.js';
import type { Report } from '../src/schema.js';

const report: Report = {
  name: 'Checkout', file: 'e2e/checkout/pay.yaml', flow: 'Checkout', mode: 'replay', status: 'failed', durationMs: 4000, anomalyCount: 1,
  recording: { videoPath: 'video.webm', tracePath: 'trace.zip', filmstripPath: 'filmstrip.png' },
  steps: [
    { index: 1, text: 'go to /cart', kind: 'action', status: 'passed', durationMs: 500, screenshot: 'steps/01.png', startMs: 0, endMs: 500, anomalies: [] },
    { index: 2, text: 'click Pay', kind: 'action', status: 'passed', durationMs: 1500, screenshot: 'steps/02.png', startMs: 500, endMs: 2000,
      anomalies: [{ t: 1000, kind: 'console-error', message: 'boom' }] },
    { index: 3, text: 'shows Order confirmed', kind: 'expect', status: 'failed', durationMs: 2000, screenshot: 'steps/03.png', startMs: 2000, endMs: 4000, error: 'Assertion failed', anomalies: [] },
    { index: 4, text: 'shows receipt', kind: 'expect', status: 'skipped', durationMs: 0, anomalies: [] },
  ],
};

describe('markersFor', () => {
  it('places one marker per executed step and per anomaly, as percentages of the total', () => {
    const m = markersFor(report);
    expect(m.total).toBe(4000);
    expect(m.markers).toEqual([
      { kind: 'step', index: 1, status: 'passed', t: 0, pct: 0, label: '1. go to /cart' },
      { kind: 'step', index: 2, status: 'passed', t: 500, pct: 12.5, label: '2. click Pay' },
      { kind: 'anomaly', index: 2, status: 'anomaly', t: 1000, pct: 25, label: 'console-error: boom' },
      { kind: 'step', index: 3, status: 'failed', t: 2000, pct: 50, label: '3. expect: shows Order confirmed' },
    ]);
  });
  it('uses durationMs when no step has telemetry', () => {
    const m = markersFor({ ...report, steps: [{ index: 1, text: 'x', kind: 'action', status: 'passed', durationMs: 1, anomalies: [] }] });
    expect(m.total).toBe(4000);
    expect(m.markers).toEqual([]);
  });
});

describe('timeline html', () => {
  const html = renderHtml([report]);
  it('renders a rail with markers carrying seek times', () => {
    expect(html.match(/class="marker step status-/g)?.length).toBe(3);
    expect(html.match(/class="marker anomaly"/g)?.length).toBe(1);
    expect(html).toContain('style="left:12.5%"');
    expect(html).toContain('data-t="2000"');
  });
  it('marks step rows with their start time and the filmstrip', () => {
    expect(html).toContain('data-start="500"');
    expect(html).toContain('src="pay/filmstrip.png"');
    expect(html).toContain('boom');
  });
  it('includes the seek and highlight script', () => {
    expect(html).toContain("addEventListener('timeupdate'");
    expect(html).toContain('currentTime');
  });
  it('shows flow and mode in the heading', () => {
    expect(html).toMatch(/Checkout.*<span class="flow">Checkout<\/span>/s);
    expect(html).toContain('id="pay"');
  });
});

describe('renderHtmlWith', () => {
  it('resolves assets through the given resolver', async () => {
    const { renderHtmlWith } = await import('../src/report.js');
    const html = renderHtmlWith([report], (dir, rel) => `https://blob.example/${dir}/${rel}`, 'Run 42');
    expect(html).toContain('src="https://blob.example/pay/video.webm"');
    expect(html).toContain('src="https://blob.example/pay/steps/01.png"');
    expect(html).toContain('Run 42');
  });
});

describe('player', () => {
  const html = renderHtml([report]);
  it('embeds the run data the player needs', () => {
    const m = /<script type="application\/json" id="ete-data">([\s\S]*?)<\/script>/.exec(html);
    expect(m).toBeTruthy();
    const data = JSON.parse(m![1]!);
    expect(data.tests).toHaveLength(1);
    expect(data.tests[0]).toMatchObject({ dir: 'pay', name: 'Checkout', flow: 'Checkout', status: 'failed', video: 'pay/video.webm', total: 4000 });
    expect(data.tests[0].steps[1]).toMatchObject({ index: 2, text: 'click Pay', status: 'passed', startMs: 500, endMs: 2000, screenshot: 'pay/steps/02.png' });
    expect(data.tests[0].steps[1].anomalies).toEqual([{ t: 1000, kind: 'console-error', message: 'boom' }]);
    expect(data.tests[0].steps[3]).toMatchObject({ index: 4, status: 'skipped' });
  });
  it('renders the player shell with a stage, reel, caption, and test rail', () => {
    expect(html).toContain('id="player"');
    for (const cls of ['player-stage', 'player-reel', 'player-caption', 'player-rail']) expect(html).toContain(`class="${cls}"`);
    expect(html).toMatch(/<button class="open-player" data-dir="pay"/);
  });
  it('opens straight into a test from the url hash, and reacts to in-page hash changes', () => {
    expect(html).toContain("'#play='");
    expect(html).toContain("addEventListener('hashchange'");
  });
  it('escapes data for safe embedding in a script tag', () => {
    const evil = { ...report, name: 'x</script><script>alert(1)</script>' };
    const out = renderHtml([evil]);
    expect(out).not.toContain('</script><script>alert(1)');
    expect(out).toContain('\\u003c/script>');
  });
});

describe('summary at the top of the report', () => {
  const passedLogin: Report = {
    name: 'Sign in', file: 'e2e/login/sign-in.yaml', flow: 'Login', mode: 'replay', status: 'passed', durationMs: 900, anomalyCount: 2,
    recording: { videoPath: 'video.webm' },
    steps: [{ index: 1, text: 'go to /', kind: 'action', status: 'passed', durationMs: 100, startMs: 0, endMs: 100, anomalies: [{ t: 1, kind: 'console-error', message: 'x' }, { t: 2, kind: 'http-error', message: 'y' }] }],
  };
  const html = renderHtml([report, passedLogin, { ...passedLogin, name: 'Sign out', file: 'e2e/login/sign-out.yaml' }]);

  it('leads with the headline counts', () => {
    const i = html.indexOf('class="summary"');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(html.indexOf('<section class="test'));
    expect(html).toMatch(/<div class="summary">[\s\S]*2 of 3 passed[\s\S]*1 failed[\s\S]*5 anomalies/);
  });
  it('lists every test by name with its result, failures first, each linking into the player', () => {
    const rows = [...html.matchAll(/<li class="trow (passed|failed)">[\s\S]*?<a href="#play=([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2], m[3]]);
    expect(rows).toEqual([['failed', 'pay', 'Checkout'], ['passed', 'sign-in', 'Sign in'], ['passed', 'sign-out', 'Sign out']]);
    expect(html).toMatch(/<li class="trow failed">[\s\S]*?step 3: expect shows Order confirmed[\s\S]*?Assertion failed/);
    expect(html).not.toMatch(/class="flow-row"/);
  });
  it('renders a run-history row when history is supplied', async () => {
    const { renderHtmlWith } = await import('../src/report.js');
    const out = renderHtmlWith([report], (d, r) => `${d}/${r}`, 'Run 3', {
      history: [
        { runId: '1', passed: 3, tests: 3, publishedAt: '2026-09-12T10:00:00Z', url: '/r/1' },
        { runId: '2', passed: 2, tests: 3, publishedAt: '2026-09-13T10:00:00Z', url: '/r/2' },
        { runId: '3', passed: 2, tests: 3, publishedAt: '2026-09-14T10:00:00Z', url: '/r/3', current: true },
      ],
    });
    expect(out).toMatch(/class="history"/);
    expect(out.match(/class="hbar[^"]*"/g)?.length).toBe(3);
    expect(out).toMatch(/class="hbar failed current"/);
    expect(out).toMatch(/<a class="hbar passed" href="\/r\/1"[^>]*title="run 1 · 3\/3 passed/);
    expect(renderHtml([report])).not.toMatch(/class="history"/);
  });
  it('shows no error detail under a passing test', () => {
    expect(renderHtml([passedLogin])).not.toMatch(/class="fail-detail"/);
  });
});
