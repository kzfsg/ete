import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { join } from 'node:path';
import type {
  Driver,
  DriverStartOptions,
  Observation,
  Recording,
  ResolvedAction,
  ResolvedAssertion,
  Target,
} from '@ete/core';

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
  /** Per-action locator timeout. Default 5000. */
  actionTimeoutMs?: number;
  /** How long an assertion polls before returning false. Default 5000. */
  checkTimeoutMs?: number;
  viewport?: { width: number; height: number };
};

export class BrowserDriver implements Driver {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private baseUrl = '';
  private resultsDir = '';
  private readonly actionTimeout: number;
  private readonly checkTimeout: number;
  private readonly viewport: { width: number; height: number };

  constructor(opts: BrowserDriverOptions = {}) {
    this.actionTimeout = opts.actionTimeoutMs ?? 5000;
    this.checkTimeout = opts.checkTimeoutMs ?? 5000;
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
    await this.context.tracing.start({ screenshots: true, snapshots: true });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.actionTimeout);
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
        await page.goto(new URL(action.url, this.baseUrl).toString(), { waitUntil: 'load' });
        return;
      case 'click': {
        const loc = this.locate(action.target);
        if (loc) await loc.click({ timeout: this.actionTimeout });
        else if ('point' in action.target) await page.mouse.click(action.target.point.x, action.target.point.y);
        return;
      }
      case 'type': {
        const loc = this.locate(action.target);
        if (loc) await loc.fill(action.text, { timeout: this.actionTimeout });
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
