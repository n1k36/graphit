/**
 * Load harness — what happens when people actually show up.
 *
 * SQLite takes one writer at a time. That is a fine choice for this app, but
 * it is a choice with a limit, and an operator deserves to know where that
 * limit is *before* a market goes viral rather than after. This drives real
 * HTTP traffic at a real server over a real file-backed database in WAL mode,
 * with a request mix shaped like the app's own read/write ratio, and reports
 * the tail latency rather than the average — nobody experiences the average.
 *
 * It ends by adding up every balance in the database. Throughput that loses
 * money is not throughput.
 *
 *   node harness/run.mjs load
 */
import { startHarnessServer } from '../lib/server.mjs';
import { Client, uniqueName } from '../lib/client.mjs';
import { conservationDrift } from './market-maker.mjs';
import { Report, percentile, mean, num, pct, money, rng } from '../lib/report.mjs';

const DEFAULTS = {
  seed: 3,
  /** Concurrent virtual users. Each holds an account and its own token. */
  concurrency: 24,
  /** How long to sustain the load. */
  seconds: 6,
  /** Markets in the book while the load runs. */
  markets: 12,
  /** Slice of requests that write. The app is overwhelmingly a read surface. */
  writeShare: 0.25,
};

export async function runLoad(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const report = new Report('Harness — load', `${opts.concurrency} concurrent users for ${opts.seconds}s`);

  const harness = await startHarnessServer({
    onDisk: true, // exercises WAL and busy_timeout; :memory: would not
    env: {
      PAYMENTS_PROVIDER: 'mock',
      // The limiter is per account and per action; a load run trips it by
      // design, so lift it and measure the engine rather than the doorman.
      PROGNOSE_AUTH_LIMIT: '1000000',
    },
  });

  try {
    const random = rng(opts.seed);
    const admin = new Client(harness.base);
    await admin.signup(uniqueName('load'));
    admin.recordTimings = false;

    // Seed a book to trade against. The deposit stays inside the product's own
    // daily cap on purpose — a harness that raises the limits it is meant to
    // exercise is measuring a system nobody ships.
    await admin.deposit(5_000);
    const slugs = [];
    for (let i = 0; i < opts.markets; i += 1) {
      const market = await admin.createMarket({
        question: `Load market ${i + 1}: will this hold up under ${opts.concurrency} users?`,
        subsidy: 300,
      });
      slugs.push(market.slug);
    }

    // Every virtual user is a real account with real money.
    const users = [];
    for (let i = 0; i < opts.concurrency; i += 1) {
      const client = new Client(harness.base);
      await client.signup(uniqueName('vu'));
      await client.deposit(2_000);
      client.recordTimings = true;
      client.timings = [];
      users.push(client);
    }

    const deadline = Date.now() + opts.seconds * 1000;
    const errors = new Map();
    const countError = (label) => errors.set(label, (errors.get(label) ?? 0) + 1);

    /** One virtual user, looping until the clock runs out. */
    async function drive(client) {
      while (Date.now() < deadline) {
        const slug = slugs[Math.floor(random() * slugs.length)];
        const roll = random();
        try {
          if (roll > opts.writeShare) {
            // Reads: the list is what everyone stares at, then a market page.
            if (roll > 1 - (1 - opts.writeShare) / 2) await client.must('/api/markets?sort=volume', { label: 'GET /api/markets' });
            else await client.must(`/api/markets/${slug}`, { label: 'GET /api/markets/:slug' });
          } else if (roll > opts.writeShare / 2) {
            await client.quote(slug, { outcome: Math.floor(random() * 2), side: 'buy', budget: 10 });
          } else {
            const res = await client.trade(slug, {
              outcome: Math.floor(random() * 2),
              side: 'buy',
              budget: Math.round(random() * 20) + 5,
            });
            if (!res.ok) countError(`${res.status} ${String(res.body?.error ?? '').slice(0, 48)}`);
          }
        } catch (err) {
          countError(String(err.message).slice(0, 60));
        }
      }
    }

    const startedAt = Date.now();
    await Promise.all(users.map(drive));
    const elapsed = (Date.now() - startedAt) / 1000;

    /* ------------------------------ report ------------------------------ */
    const timings = users.flatMap((u) => u.timings);
    const byLabel = new Map();
    for (const timing of timings) {
      if (!byLabel.has(timing.label)) byLabel.set(timing.label, []);
      byLabel.get(timing.label).push(timing.ms);
    }

    const throughput = report.section('Throughput');
    throughput.table(
      ['measure', 'value'],
      [
        ['requests', String(timings.length)],
        ['duration', `${num(elapsed, 1)}s`],
        ['requests per second', num(timings.length / elapsed, 1)],
        ['concurrent users', String(opts.concurrency)],
        ['non-2xx responses', String(timings.filter((t) => t.status >= 400).length)],
      ],
    );

    const latency = report.section('Latency by endpoint');
    latency.note('Milliseconds, measured client-side over loopback — server time plus the local round trip.');
    latency.table(
      ['endpoint', 'calls', 'p50', 'p95', 'p99', 'max'],
      [...byLabel.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([label, values]) => [
          label,
          String(values.length),
          num(percentile(values, 50)),
          num(percentile(values, 95)),
          num(percentile(values, 99)),
          num(Math.max(...values)),
        ]),
    );

    const all = timings.map((t) => t.ms);
    const p99 = percentile(all, 99);
    latency.check('p99 under 250ms', p99 < 250, `p99 ${num(p99)}ms, mean ${num(mean(all))}ms`);

    const health = report.section('Correctness under concurrency');
    const serverErrors = timings.filter((t) => t.status >= 500);
    const busy = [...errors.keys()].filter((k) => /SQLITE_BUSY|database is locked/i.test(k));
    health.check('no 5xx responses', serverErrors.length === 0, `${serverErrors.length} server errors`);
    health.check(
      'no SQLITE_BUSY under concurrent writes',
      busy.length === 0,
      busy.length ? busy.join('; ') : 'busy_timeout absorbed every write collision',
    );

    const drift = conservationDrift(harness.db);
    health.metric('ledger drift after the run', money(drift));
    health.check('money conserved under load', Math.abs(drift) < 0.05, `off by ${money(drift)}`);

    if (errors.size) {
      const rejects = report.section('Rejected requests');
      rejects.note('Expected: traders run out of balance, and the write limiter is doing its job.');
      rejects.table(
        ['response', 'count'],
        [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, count]) => [label, String(count)]),
      );
    }

    const writes = timings.filter((t) => t.label === 'POST /api/markets/:slug/trade');
    if (writes.length) {
      report
        .section('Write ceiling')
        .note('SQLite serialises writers, so this is the number that caps a single node.')
        .metric('trades per second', num(writes.length / elapsed, 1), `${writes.length} trades in ${num(elapsed, 1)}s`)
        .metric('p95 trade latency', `${num(percentile(writes.map((w) => w.ms), 95))}ms`);
    }

    return report;
  } finally {
    await harness.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runLoad();
  process.exit(report.render() ? 0 : 1);
}
