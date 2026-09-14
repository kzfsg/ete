import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { join } from 'node:path';
import type {
  Anomaly,
  Driver,
  DriverStartOptions,
  Observation,
  Recording,
  ResolvedAction,
  ResolvedAssertion,
  StepTelemetry,
  Target,
} from '@ete/core';

export { renderFilmstrip, sampleFrames } from './filmstrip.js';
export { renderPreview, ffmpegPath } from './preview.js';
export { buildApng, apngFrameCount } from './apng.js';

const MAX_MESSAGE = 500;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);

/**
 * Selector strings are Playwright selectors (`role=`, `text=`, `css=`, `xpath=`, `id=`, `data-testid=`),
 * plus two conveniences that map to Playwright's semantic locators:
 *   `placeholder=Email` -> page.getByPlaceholder('Email')
 *   `label=Password`    -> page.getByLabel('Password')
 */
export function locatorFor(page: Page, selector: string): Locator {
  const m = /^(placeholder|label)=(.*)$/s.exec(selector);
  if (m) {
    const value = m[2].replace(/^"(.*)"$/s, '$1');
    return (m[1] === 'placeholder' ? page.getByPlaceholder(value) : page.getByLabel(value)).first();
  }
  return page.locator(selector).first();
}

export type BrowserDriverOptions = {
  /** Timeout for navigations (page load). Default 30000: dev servers compile on first hit. */
  navigationTimeoutMs?: number;
  /** Per-action locator timeout. Default 10000. */
  actionTimeoutMs?: number;
  /** How long an assertion polls before returning false. Default 10000. */
  checkTimeoutMs?: number;
  viewport?: { width: number; height: number };
};

export class BrowserDriver implements Driver {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private baseUrl = '';
  private resultsDir = '';
  private t0 = 0;
  private anomalies: Anomaly[] = [];
  private stepStart?: number;
  private inGroup = false;
  private readonly navigationTimeout: number;
  private readonly actionTimeout: number;
  private readonly checkTimeout: number;
  private readonly viewport: { width: number; height: number };

  constructor(opts: BrowserDriverOptions = {}) {
    this.navigationTimeout = opts.navigationTimeoutMs ?? 30000;
    this.actionTimeout = opts.actionTimeoutMs ?? 10000;
    this.checkTimeout = opts.checkTimeoutMs ?? 10000;
    this.viewport = opts.viewport ?? { width: 1280, height: 800 };
  }

  async start(opts: DriverStartOptions): Promise<void> {
    this.baseUrl = opts.baseUrl;
    this.resultsDir = opts.resultsDir;
    this.browser = await chromium.launch({ headless: !opts.headed });
    this.context = await this.browser.newContext({
      viewport: this.viewport,
      recordVideo: { dir: opts.resultsDir, size: this.viewport },
    });
    this.t0 = Date.now();
    await this.context.tracing.start({ screenshots: true, snapshots: true });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.actionTimeout);
    this.page.setDefaultNavigationTimeout(this.navigationTimeout);
    this.listen(this.page);
  }

  private elapsed(): number {
    return Date.now() - this.t0;
  }

  private note(kind: Anomaly['kind'], message: string): void {
    this.anomalies.push({ t: this.elapsed(), kind, message: oneLine(message) });
  }

  private listen(page: Page): void {
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const url = msg.location()?.url;
      this.note('console-error', url ? `${msg.text()} (${url})` : msg.text());
    });
    page.on('pageerror', (err) => this.note('page-error', err.message));
    page.on('requestfailed', (req) => this.note('request-failed', `${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'failed'}`));
    page.on('response', (res) => {
      if (res.status() >= 500) this.note('http-error', `HTTP ${res.status()} ${res.request().method()} ${res.url()}`);
    });
    page.on('dialog', (dialog) => {
      this.note('dialog', `${dialog.type()}: ${dialog.message()}`);
      dialog.dismiss().catch(() => {});
    });
  }

  async beginStep(label: string): Promise<void> {
    const ctx = this.context;
    if (!ctx) throw new Error('BrowserDriver not started');
    if (this.inGroup) await ctx.tracing.groupEnd().catch(() => {});
    this.anomalies = [];
    this.stepStart = this.elapsed();
    try {
      await ctx.tracing.group(label);
      this.inGroup = true;
    } catch {
      this.inGroup = false;
    }
  }

  async endStep(): Promise<StepTelemetry> {
    const ctx = this.context;
    if (this.inGroup && ctx) {
      await ctx.tracing.groupEnd().catch(() => {});
      this.inGroup = false;
    }
    const telemetry: StepTelemetry = { startMs: this.stepStart ?? this.elapsed(), endMs: this.elapsed(), anomalies: this.anomalies };
    this.anomalies = [];
    this.stepStart = undefined;
    return telemetry;
  }

  private get p(): Page {
    if (!this.page) throw new Error('BrowserDriver not started');
    return this.page;
  }

  async observe(): Promise<Observation> {
    const page = this.p;
    const [screenshotPng, a11yTree] = await Promise.all([
      page.screenshot({ type: 'png' }),
      page.ariaSnapshot().catch(() => undefined),
    ]);
    return { screenshotPng, a11yTree, url: page.url() };
  }

  private locate(target: Target): Locator | undefined {
    return 'selector' in target ? locatorFor(this.p, target.selector) : undefined;
  }

  async act(action: ResolvedAction): Promise<void> {
    const page = this.p;
    switch (action.kind) {
      case 'navigate':
        await page.goto(new URL(action.url, this.baseUrl).toString(), { waitUntil: 'load', timeout: this.navigationTimeout });
        return;
      case 'click': {
        const loc = this.locate(action.target);
        if (loc) await this.withForceFallback(loc, (force, timeout) => loc.click({ timeout, force }));
        else if ('point' in action.target) await page.mouse.click(action.target.point.x, action.target.point.y);
        return;
      }
      case 'type': {
        const loc = this.locate(action.target);
        if (loc) await this.withForceFallback(loc, (force, timeout) => loc.fill(action.text, { timeout, force }));
        else if ('point' in action.target) {
          await page.mouse.click(action.target.point.x, action.target.point.y);
          await page.keyboard.type(action.text);
        }
        return;
      }
      case 'press':
        await page.keyboard.press(action.key);
        return;
      case 'scroll': {
        const loc = action.target ? this.locate(action.target) : undefined;
        if (loc) await loc.evaluate((el, dy) => el.scrollBy(0, dy), action.dy);
        else await page.mouse.wheel(0, action.dy);
        return;
      }
      case 'wait':
        await page.waitForTimeout(action.ms);
        return;
    }
  }

  /**
   * Pages with perpetual animation (physics, marquees, smooth-scroll libraries) never satisfy
   * Playwright's "stable" actionability check on slow machines. If the element exists and is
   * visible but the normal attempt times out, retry once bypassing the stability wait.
   */
  private async withForceFallback(loc: Locator, attempt: (force: boolean, timeout: number) => Promise<void>): Promise<void> {
    // Give the normal attempt a slice of the budget; a perpetually moving element would otherwise
    // burn the whole timeout on every step before the fallback kicks in.
    const firstTry = Math.max(2000, Math.round(this.actionTimeout * 0.4));
    try {
      await attempt(false, firstTry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const timedOut = /Timeout \d+ms exceeded/.test(msg);
      if (!timedOut) throw err;
      // The action itself already happened and Playwright was only waiting for the navigation it
      // triggered. Never retry (that would double-submit); wait for the page with the navigation budget.
      if (/waiting for scheduled navigations to finish/.test(msg)) {
        await this.p.waitForLoadState('load', { timeout: this.navigationTimeout }).catch(() => {});
        return;
      }
      if (!(await loc.isVisible().catch(() => false))) throw err;
      await loc.scrollIntoViewIfNeeded({ timeout: this.actionTimeout }).catch(() => {});
      await attempt(true, this.actionTimeout);
    }
  }

  async check(assertion: ResolvedAssertion): Promise<boolean> {
    const page = this.p;
    try {
      switch (assertion.kind) {
        case 'textVisible':
          await page.getByText(assertion.text).first().waitFor({ state: 'visible', timeout: this.checkTimeout });
          return true;
        case 'elementVisible': {
          const loc = this.locate(assertion.target);
          if (!loc) return false;
          await loc.waitFor({ state: 'visible', timeout: this.checkTimeout });
          return true;
        }
        case 'urlMatches':
          await page.waitForURL(new RegExp(assertion.pattern), { timeout: this.checkTimeout });
          return true;
      }
    } catch {
      return false;
    }
  }

  async screenshot(path: string): Promise<void> {
    await this.p.screenshot({ path, type: 'png' });
  }

  async stop(): Promise<Recording> {
    const recording: Recording = {};
    const { context, browser, page } = this;
    if (!context || !browser) return recording;
    const tracePath = join(this.resultsDir, 'trace.zip');
    if (this.inGroup) {
      await context.tracing.groupEnd().catch(() => {});
      this.inGroup = false;
    }
    try {
      await context.tracing.stop({ path: tracePath });
      recording.tracePath = 'trace.zip';
    } catch {
      /* tracing may already be stopped if the browser crashed */
    }
    const video = page?.video();
    await context.close();
    if (video) {
      try {
        await video.saveAs(join(this.resultsDir, 'video.webm'));
        await video.delete();
        recording.videoPath = 'video.webm';
      } catch {
        /* no video if the page never rendered */
      }
    }
    await browser.close();
    this.page = this.context = this.browser = undefined;
    return recording;
  }
}

export function createBrowserDriver(opts?: BrowserDriverOptions): Driver {
  return new BrowserDriver(opts);
}
