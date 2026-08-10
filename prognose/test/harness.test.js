/**
 * The harness is code too, and a broken harness reports success.
 *
 * These are cheap smoke tests that run in the normal suite: they prove the
 * pieces the harness is built from actually work, without paying for a full
 * 300-market eval on every `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarnessServer, withServer } from '../harness/lib/server.mjs';
import { Client, uniqueName } from '../harness/lib/client.mjs';
import { Report, rng, percentile, mean } from '../harness/lib/report.mjs';
import { simulate, brier, calibration, conservationDrift } from '../harness/eval/market-maker.mjs';

test('each harness server gets its own port and its own database', async () => {
  const a = await startHarnessServer();
  const b = await startHarnessServer();
  try {
    assert.notEqual(a.port, b.port, 'two harness servers must never share a port');
    const client = new Client(a.base);
    await client.signup(uniqueName('iso'));
    const onB = await new Client(b.base).call('/api/auth/login', {
      method: 'POST',
      body: { username: client.username, password: 'harness-pass-1' },
    });
    assert.equal(onB.status, 401, 'an account on one harness must not exist on the other');
  } finally {
    await a.close();
    await b.close();
  }
});

test('withServer restores the environment it changed', async () => {
  const before = process.env.PAYMENTS_PROVIDER;
  await withServer({ env: { PAYMENTS_PROVIDER: 'mock' } }, async (harness) => {
    assert.equal(process.env.PAYMENTS_PROVIDER, 'mock');
    assert.ok(harness.port > 0);
  });
  assert.equal(process.env.PAYMENTS_PROVIDER, before);
});

test('the client reports failures instead of swallowing them', async () => {
  await withServer({}, async (harness) => {
    const client = new Client(harness.base);
    const missing = await client.call('/api/markets/not-a-real-market');
    assert.equal(missing.status, 404, 'call() must surface the status rather than throw');
    await assert.rejects(() => client.must('/api/markets/not-a-real-market'), /404/);
  });
});

test('the simulation is deterministic for a given seed', () => {
  const one = simulate({ seed: 42, markets: 4, tradersPerMarket: 6, traderPool: 8 });
  const two = simulate({ seed: 42, markets: 4, tradersPerMarket: 6, traderPool: 8 });
  assert.deepEqual(
    one.results.map((r) => [r.trueP, r.finalPrice, r.outcome]),
    two.results.map((r) => [r.trueP, r.finalPrice, r.outcome]),
    'a failing eval run has to be replayable',
  );
  one.db.close();
  two.db.close();
});

test('the simulation leaves the books balanced', () => {
  const { db } = simulate({ seed: 5, markets: 6, tradersPerMarket: 8, traderPool: 10 });
  assert.ok(Math.abs(conservationDrift(db)) < 0.05, 'the eval must not invent or destroy money');
  db.close();
});

test('the market maker never exceeds its b·ln(n) loss bound', () => {
  const { db, results } = simulate({ seed: 9, markets: 8, tradersPerMarket: 10, traderPool: 12 });
  for (const result of results) {
    assert.ok(
      result.makerLoss <= result.bound + 1e-6,
      `market lost ${result.makerLoss.toFixed(2)} against a bound of ${result.bound.toFixed(2)}`,
    );
  }
  db.close();
});

test('brier and calibration agree with hand-worked numbers', () => {
  // A forecaster who said 100% twice and was right once.
  const results = [
    { finalPrice: 1, outcome: 1 },
    { finalPrice: 1, outcome: 0 },
  ];
  assert.equal(brier(results), 0.5);
  const { bins, ece } = calibration(results, 2);
  assert.equal(bins.length, 1, 'both forecasts belong in the top bucket');
  assert.equal(ece, 0.5, 'said 100%, happened 50% — the gap is the whole error');
});

test('percentile picks the value at the rank, not an interpolation', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 50), 5);
  assert.equal(percentile(values, 100), 10);
  assert.equal(mean(values), 5.5);
});

test('the seeded generator is reproducible and roughly uniform', () => {
  const a = rng(3);
  const b = rng(3);
  const draws = Array.from({ length: 2000 }, () => a());
  assert.deepEqual(draws.slice(0, 5), Array.from({ length: 5 }, () => b()));
  assert.ok(draws.every((x) => x >= 0 && x < 1));
  assert.ok(Math.abs(mean(draws) - 0.5) < 0.03, 'a biased generator would bias every eval built on it');
});

test('a report fails when any single check fails', () => {
  const report = new Report('t');
  const section = report.section('s');
  section.check('passes', true);
  assert.equal(report.ok, true);
  section.check('fails', false, 'because');
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 1);
  assert.equal(report.toJSON().ok, false);
});
