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
