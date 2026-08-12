/**
 * Browser harness — optional, and deliberately so.
 *
 * This repository has zero dependencies and that is a feature worth keeping,
 * so Playwright is never installed by the harness and never required to run
 * it. If it happens to be available the browser flows run; if not, this layer
 * reports itself as skipped and the rest of the harness carries on. A harness
 * that cannot run without a 400MB install is a harness nobody runs.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node harness/run.mjs e2e
 *
 * Two things are checked here that no API-level harness can reach: that the
 * page renders at all, and that a price moves in one tab because of a trade
 * made in another — the live stream, end to end, through the real client.
 */
import { startHarnessServer } from '../lib/server.mjs';
import { Client, uniqueName } from '../lib/client.mjs';
import { Report, num } from '../lib/report.mjs';

const SPECIFIERS = ['playwright', 'playwright-core', '@playwright/test'];

/**
 * Find Playwright wherever it happens to live. A local devDependency is the
 * obvious case, but a global install is just as common on a laptop, and this
 * project has no node_modules of its own for it to be local *to*.
 */
async function loadPlaywright() {
  for (const specifier of SPECIFIERS) {
    try {
      const module = await import(specifier);
      // A CommonJS build lands under .default, a real ESM one does not.
      const chromium = module.chromium ?? module.default?.chromium;
      if (chromium) return chromium;
    } catch {
      /* not resolvable from here — try the next one */
    }
  }

  try {
    const { execFileSync } = await import('node:child_process');
    const { pathToFileURL } = await import('node:url');
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    for (const specifier of SPECIFIERS) {
      try {
        const module = await import(pathToFileURL(`${root}/${specifier}/index.js`).href);
        // A CommonJS build lands under .default, a real ESM one does not.
        const chromium = module.chromium ?? module.default?.chromium;
        if (chromium) return chromium;
      } catch {
        /* keep looking */
      }
    }
  } catch {
    /* no npm on PATH; nothing more to try */
  }
  return null;
}

export async function runBrowser({ headless = true } = {}) {
  const report = new Report('Harness — browser', 'live UI, optional');
  const chromium = await loadPlaywright();

  if (!chromium) {
    report
      .section('Setup')
      .note('Playwright is not installed, so the browser layer was skipped — not failed.')
      .note('To enable it: npm i -D playwright && npx playwright install chromium');
    report.skipped = true;
    return report;
  }

  const harness = await startHarnessServer({ seed: true, env: { PAYMENTS_PROVIDER: 'mock', PROGNOSE_AUTH_LIMIT: '100000' } });
  let browser;
  try {
    browser = await chromium.launch({ headless });

    /* ---------------- Does it render? ---------------- */
    const render = report.section('First paint');
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err.message)));
    page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));

    // Never `networkidle`: the app holds an SSE connection open forever, so
    // that wait never resolves. This cost an afternoon once.
    await page.goto(harness.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.market-row', { timeout: 10_000 }).catch(() => {});

    const rows = await page.locator('.market-row').count();
    render.check('the market list renders', rows > 0, `${rows} markets in the book`);
    render.check('no uncaught errors on load', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' · '));

    const title = await page.title();
    render.check('the page has a title', title.length > 0, title);

    /* ---------------- Does a trade reach the other tab? ---------------- */
    const live = report.section('Live updates');
    const slug = (await new Client(harness.base).call('/api/markets')).body.markets.find((m) => m.tradable)?.slug;
    if (!slug) {
      live.check('a tradable market exists to watch', false, 'nothing open in the seeded book');
    } else {
      const watcher = await context.newPage();
      await watcher.goto(`${harness.base}/#/market/${slug}`, { waitUntil: 'domcontentloaded' });
      await watcher.waitForTimeout(1200); // let the stream connect

      const priceText = () => watcher.locator('.headline-price .big').first().innerText().catch(() => '');
      const before = await priceText();

      // Move the price from outside the browser entirely.
      const trader = new Client(harness.base);
      await trader.signup(uniqueName('e2e'));
      await trader.deposit(1_000);
      const filled = await trader.trade(slug, { outcome: 0, side: 'buy', budget: 400 });
      live.check('the out-of-band trade filled', filled.ok, filled.ok ? '' : JSON.stringify(filled.body));

      // No reload: if this changes, it changed because of the stream.
      let after = before;
      for (let i = 0; i < 30 && after === before; i += 1) {
        await watcher.waitForTimeout(200);
        after = await priceText();
      }
      live.check(
        'a trade in another session moves the price with no reload',
        after !== before && after !== '',
        `${before || '(blank)'} → ${after || '(blank)'}`,
      );

      // The book has its own repaint path, and it broke silently once when the
      // card grid became a table and the stream kept painting `.market-card`.
      const book = await context.newPage();
      await book.goto(harness.base, { waitUntil: 'domcontentloaded' });
      await book.waitForSelector(`.market-row[data-slug="${slug}"]`, { timeout: 10_000 }).catch(() => {});
      await book.waitForTimeout(1200);

      const rowPrice = () =>
        book.locator(`.market-row[data-slug="${slug}"] .col-chance`).first().innerText().catch(() => '');
      const rowBefore = await rowPrice();
      await trader.trade(slug, { outcome: 1, side: 'buy', budget: 300 });

      let rowAfter = rowBefore;
      for (let i = 0; i < 30 && rowAfter === rowBefore; i += 1) {
        await book.waitForTimeout(200);
        rowAfter = await rowPrice();
      }
      live.check(
        'the price on the market list reprices from the stream',
        rowAfter !== rowBefore && rowAfter !== '',
        `${rowBefore || '(blank)'} → ${rowAfter || '(blank)'}`,
      );
      await book.close();
    }

    /* ---------------- Does it work on a phone? ---------------- */
    const mobile = report.section('Mobile viewport');
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const small = await phone.newPage();
    await small.goto(harness.base, { waitUntil: 'domcontentloaded' });
    await small.waitForSelector('.market-row', { timeout: 10_000 }).catch(() => {});
    const overflow = await small.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    mobile.check('nothing overflows horizontally at 390px', overflow <= 1, `${num(overflow, 0)}px of sideways scroll`);
    await phone.close();

    return report;
  } finally {
    await browser?.close();
    await harness.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runBrowser({ headless: !process.argv.includes('--headed') });
  process.exit(report.render() ? 0 : 1);
}
