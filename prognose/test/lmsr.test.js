import test from 'node:test';
import assert from 'node:assert/strict';
import * as lmsr from '../server/lmsr.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b} (±${eps})`);

test('prices always sum to 1', () => {
  for (const q of [
    [0, 0],
    [40, -12],
    [1000, 3, 17],
    [-500, -500, -500, 20],
  ]) {
    const sum = lmsr.prices(q, 75).reduce((a, b) => a + b, 0);
    close(sum, 1, 1e-12);
  }
});

test('a fresh market is uniform across outcomes', () => {
  for (const n of [2, 3, 5, 8]) {
    for (const p of lmsr.prices(new Array(n).fill(0), 100)) close(p, 1 / n, 1e-12);
  }
});

test('buying an outcome raises its price and lowers the others', () => {
  const q = [0, 0, 0];
  const before = lmsr.prices(q, 100);
  const after = lmsr.prices(lmsr.applyTrade(q, 1, 50), 100);
  assert.ok(after[1] > before[1]);
  assert.ok(after[0] < before[0] && after[2] < before[2]);
});

test('a complete set of one share of every outcome costs exactly $1', () => {
  const q = [12, -4, 30, 7];
  const b = 63;
  const beforeCost = lmsr.cost(q, b);
  const afterCost = lmsr.cost(q.map((x) => x + 1), b);
  close(afterCost - beforeCost, 1, 1e-9);
});

test('cost is monotonically increasing and convex in size', () => {
  const q = [0, 0];
  let previous = 0;
  let previousMarginal = 0;
  for (let size = 1; size <= 200; size += 1) {
    const c = lmsr.costToTrade(q, 100, 0, size);
    assert.ok(c > previous, 'cost must increase with size');
    const marginal = c - previous;
    assert.ok(marginal >= previousMarginal - 1e-12, 'marginal price must not fall');
    previous = c;
    previousMarginal = marginal;
  }
});

test('shares always cost less than their $1 payout', () => {
  for (const size of [0.5, 10, 250, 5000]) {
    const c = lmsr.costToTrade([0, 0], 100, 0, size);
    assert.ok(c < size, `paid ${c} for ${size} shares that pay at most ${size}`);
  }
});

test('selling straight back is a round trip with no profit', () => {
  const q = [30, 10];
  const b = 120;
  const bought = lmsr.costToTrade(q, b, 0, 25);
  const after = lmsr.applyTrade(q, 0, 25);
  const sold = lmsr.costToTrade(after, b, 0, -25);
  close(bought + sold, 0, 1e-9);
});

test('sharesForBudget inverts the cost function', () => {
  const q = [80, -20, 5];
  const b = 90;
  for (const budget of [0.01, 1, 25, 500, 10_000]) {
    const size = lmsr.sharesForBudget(q, b, 1, budget);
    close(lmsr.costToTrade(q, b, 1, size), budget, Math.max(1e-9, budget * 1e-9));
  }
});

test('quote applies the fee on top when buying and out of proceeds when selling', () => {
  const q = [0, 0];
  const buy = lmsr.quote(q, 100, 0, 'buy', 40, 0.01);
  close(buy.cashDelta, buy.cost * 1.01, 1e-9);
  assert.ok(buy.cashDelta > buy.cost);

  const sell = lmsr.quote(lmsr.applyTrade(q, 0, 40), 100, 0, 'sell', 40, 0.01);
  close(Math.abs(sell.cashDelta), Math.abs(sell.cost) * 0.99, 1e-9);
});

test('the market maker cannot lose more than b * ln(n)', () => {
  const b = 100;
  const n = 2;
  const bound = lmsr.maxLoss(b, n);
  let q = [0, 0];
  let collected = 0;
  // Traders pile into outcome 0 until it is nearly certain.
  for (let i = 0; i < 40; i++) {
    collected += lmsr.costToTrade(q, b, 0, 50);
    q = lmsr.applyTrade(q, 0, 50);
  }
  const owed = q[0]; // every share of the winner pays $1
  assert.ok(owed - collected <= bound + 1e-9, `loss ${owed - collected} exceeded bound ${bound}`);
});

test('liquidityForSubsidy round-trips with maxLoss', () => {
  for (const n of [2, 3, 8]) {
    close(lmsr.maxLoss(lmsr.liquidityForSubsidy(250, n), n), 250, 1e-9);
  }
});

test('extreme quantities stay numerically stable', () => {
  const p = lmsr.prices([100_000, 0], 50);
  close(p[0], 1, 1e-12);
  close(p[1], 0, 1e-12);
  assert.ok(Number.isFinite(lmsr.cost([100_000, 0], 50)));
});

test('invalid input is rejected', () => {
  assert.throws(() => lmsr.prices([1], 100), /2 outcomes/);
  assert.throws(() => lmsr.prices([1, 2], 0), /positive/);
  assert.throws(() => lmsr.costToTrade([1, 2], 10, 5, 1), /out of range/);
});
