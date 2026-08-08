/**
 * Hanson's Logarithmic Market Scoring Rule (LMSR) automated market maker.
 *
 * A market over `n` mutually exclusive outcomes holds a vector `q` of shares
 * sold for each outcome and a liquidity parameter `b`.
 *
 *   C(q) = b * ln( sum_i exp(q_i / b) )          (cost function)
 *   p_i  = exp(q_i/b) / sum_j exp(q_j/b)         (instantaneous price)
 *
 * Buying `d` shares of outcome i costs C(q + d*e_i) - C(q). Selling is the
 * same expression with a negative `d`. Prices always sum to 1, and the market
 * maker's worst-case loss is bounded by b * ln(n) — which is exactly the
 * subsidy a market creator has to put up in this app.
 *
 * Every function here is pure: no database, no rounding policy, no money.
 */

/** Numerically stable log(sum(exp(xs))). */
export function logSumExp(xs) {
  let max = -Infinity;
  for (const x of xs) if (x > max) max = x;
  if (!Number.isFinite(max)) return max;
  let sum = 0;
  for (const x of xs) sum += Math.exp(x - max);
  return max + Math.log(sum);
}

/** Cost function C(q). */
export function cost(q, b) {
  assertMarket(q, b);
  return b * logSumExp(q.map((x) => x / b));
}

/** Instantaneous price vector; always sums to 1. */
export function prices(q, b) {
  assertMarket(q, b);
  const z = q.map((x) => x / b);
  const lse = logSumExp(z);
  return z.map((x) => Math.exp(x - lse));
}

/**
 * Cash needed to move the market by `shares` of `outcome`.
 * Positive `shares` = buy (returns a positive cost).
 * Negative `shares` = sell (returns a negative cost, i.e. proceeds).
 */
export function costToTrade(q, b, outcome, shares) {
  assertOutcome(q, outcome);
  if (!Number.isFinite(shares)) throw new Error('shares must be finite');
  const next = q.slice();
  next[outcome] += shares;
  return cost(next, b) - cost(q, b);
}

/** The share vector after a trade. */
export function applyTrade(q, outcome, shares) {
  assertOutcome(q, outcome);
  const next = q.slice();
  next[outcome] += shares;
  return next;
}

/**
 * How many shares of `outcome` a given budget buys.
 *
 * Cost is strictly increasing and convex in `shares`, so we bisect. Bounds:
 * price is in (0,1), so cost(d) < d, meaning d > budget; and cost(d) >= d*p0,
 * meaning d <= budget/p0.
 */
export function sharesForBudget(q, b, outcome, budget) {
  assertOutcome(q, outcome);
  if (!(budget > 0)) return 0;
  const p0 = prices(q, b)[outcome];
  let lo = budget;
  let hi = budget / Math.max(p0, 1e-12);
  // Guard against pathological bounds from floating point.
  if (!Number.isFinite(hi) || hi <= lo) hi = lo * 2 + 1;
  while (costToTrade(q, b, outcome, hi) < budget) {
    hi *= 2;
    if (hi > 1e15) break;
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (costToTrade(q, b, outcome, mid) > budget) hi = mid;
    else lo = mid;
  }
  return lo;
}

/**
 * A full quote for a trade, in the shape the UI and the trade endpoint want.
 * `side` is 'buy' or 'sell'; `shares` is always a positive magnitude.
 */
export function quote(q, b, outcome, side, shares, feeRate = 0) {
  const signed = side === 'sell' ? -Math.abs(shares) : Math.abs(shares);
  const raw = costToTrade(q, b, outcome, signed);
  const fee = Math.abs(raw) * feeRate;
  // Buying: you pay cost + fee. Selling: you receive |proceeds| - fee.
  const cashDelta = side === 'sell' ? -(Math.abs(raw) - fee) : raw + fee;
  const after = applyTrade(q, outcome, signed);
  const magnitude = Math.abs(shares);
  return {
    side,
    outcome,
    shares: magnitude,
    cost: raw,
    fee,
    /** What the user pays (buy) or receives as a negative number (sell). */
    cashDelta,
    avgPrice: magnitude > 0 ? Math.abs(raw) / magnitude : 0,
    pricesBefore: prices(q, b),
    pricesAfter: prices(after, b),
    q: after,
  };
}

/** Worst-case loss of the market maker — the subsidy a creator must post. */
export function maxLoss(b, outcomeCount) {
  return b * Math.log(outcomeCount);
}

/**
 * The liquidity parameter that gives a market the requested worst-case
 * subsidy. Inverse of maxLoss().
 */
export function liquidityForSubsidy(subsidy, outcomeCount) {
  return subsidy / Math.log(outcomeCount);
}

function assertMarket(q, b) {
  if (!Array.isArray(q) || q.length < 2) throw new Error('q must have >= 2 outcomes');
  if (!(b > 0) || !Number.isFinite(b)) throw new Error('b must be a positive finite number');
  for (const x of q) if (!Number.isFinite(x)) throw new Error('q must be finite');
}

function assertOutcome(q, outcome) {
  if (!Number.isInteger(outcome) || outcome < 0 || outcome >= q.length) {
    throw new Error(`outcome index ${outcome} out of range`);
  }
}
