/**
 * Eval lab — does the market tell the truth?
 *
 * A prediction market has exactly one job: turn the money people are willing
 * to risk into a number that matches reality. Everything else — the UI, the
 * streak counters, the payment rails — is scaffolding around that number. So
 * this harness does not test that the code runs. It runs hundreds of markets
 * whose true probability *we* chose, lets simulated traders with noisy beliefs
 * trade them, settles them against a coin weighted by that hidden truth, and
 * then asks whether the closing prices were honest.
 *
 * It runs the real engine in process — `logic.executeTrade`, the real ledger,
 * the real fee split — rather than a model of it. A calibration number
 * produced by a reimplementation of LMSR would prove nothing about the app.
 *
 *   node harness/run.mjs eval
 */
import { openDb, getSettings, updateSettings, totalFeeRate } from '../../server/db.js';
import { createUser } from '../../server/auth.js';
import { creditUser, treasuryBalance } from '../../server/ledger.js';
import * as logic from '../../server/logic.js';
import * as lmsr from '../../server/lmsr.js';
import { Report, rng, mean, num, pct, money } from '../lib/report.mjs';

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Two populations, because a market made only of well-informed traders is not
 * a market — it is a poll. Noise traders are what pays the informed ones, and
 * whether the price still lands on the truth *despite* them is the question.
 */
const POPULATIONS = [
  { name: 'informed', share: 0.45, noise: 0.5 },
  { name: 'casual', share: 0.4, noise: 1.4 },
  { name: 'noise', share: 0.15, noise: 3.0 },
];

const DEFAULTS = {
  seed: 7,
  /**
   * Calibration is a frequency claim, so it needs a sample. At 120 markets the
   * binomial noise inside a single price band is ±10pp on its own, which is
   * larger than any miscalibration worth finding.
   */
  markets: 300,
  tradersPerMarket: 24,
  traderPool: 60,
  subsidy: 250,
  bankroll: 4000,
  /** A trader needs an edge bigger than the round-trip fee to bother. */
  minEdge: 0.02,
  /**
   * How far towards their own belief a trader is willing to push the price.
   * Never all the way: the last cent of edge costs the most to take, so real
   * traders stop short. This is the single most important knob in the model —
   * at 1.0 every trader hands the whole market to whoever traded last.
   */
  conviction: 0.25,
  /** Fraction of the bankroll a trader will stake on one market. */
  maxStake: 0.35,
};

/* ------------------------------------------------------------------ *
 * The simulation
 * ------------------------------------------------------------------ */

export function simulate(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const random = rng(opts.seed);
  const db = openDb(':memory:');

  // Give every account enough promo credit to trade with. Bonus grants are
  // already part of the money-conservation identity, so funding this way keeps
  // the books checkable without faking a payment.
  updateSettings(db, { welcomeBonus: opts.bankroll, minSubsidy: 10, maxSubsidy: 1e6 });
  const settings = getSettings(db);

  const house = createUser(db, 'housemaker', 'harness-pass-1', { isAdmin: true });
  creditUser(db, house.id, opts.subsidy * opts.markets + 1000, { kind: 'welcome_bonus', memo: 'Harness float' }, { toBonus: true });

  const traders = [];
  for (let i = 0; i < opts.traderPool; i += 1) {
    const roll = random();
    let cumulative = 0;
    const population = POPULATIONS.find((p) => (cumulative += p.share) >= roll) ?? POPULATIONS.at(-1);
    traders.push({ ...createUser(db, `trader${String(i).padStart(3, '0')}`, 'harness-pass-1'), population });
  }

  const results = [];
  const rejected = new Map();
  let attempted = 0;
  let capped = 0;
  const note = (message) => rejected.set(message, (rejected.get(message) ?? 0) + 1);

  for (let m = 0; m < opts.markets; m += 1) {
    // The hidden truth. Kept away from the extremes: a market on something
    // that is 99% certain teaches you nothing about price discovery.
    const trueP = random.between(0.08, 0.92);

    const market = logic.createMarket(db, house, {
      question: `Harness market ${m + 1}: will the coin land heads?`,
      description: 'A synthetic market with a known true probability.',
      category: 'Other',
      symbol: 'EVAL',
      closesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      subsidy: opts.subsidy,
      outcomes: ['Yes', 'No'],
    });

    let trades = 0;
    for (let t = 0; t < opts.tradersPerMarket; t += 1) {
      const trader = random.pick(traders);
      const balance = db.prepare('SELECT balance + bonus_balance AS total FROM users WHERE id = ?').get(trader.id).total;
      if (balance < 5) continue;

      // Belief = the truth, seen through this trader's noise, in log-odds so
      // it can never leave (0, 1).
      const belief = clamp(sigmoid(logit(trueP) + random.normal(0, trader.population.noise)), 0.01, 0.99);
      const row = logic.marketRowById(db, market.id);
      const price = lmsr.prices(JSON.parse(row.q), row.b)[0];

      const edge = belief - price;
      if (Math.abs(edge) < opts.minEdge + totalFeeRate(settings)) {
        note('no edge after fees');
        continue;
      }
      const outcome = edge > 0 ? 0 : 1;

      // Buy until the price has moved most of the way to what you believe,
      // then stop. For binary LMSR that distance is exactly
      // b·(logit(belief) − logit(price)) shares — closed form, no search.
      const q = JSON.parse(row.q);
      const priceOf = outcome === 0 ? price : 1 - price;
      const beliefOf = outcome === 0 ? belief : 1 - belief;
      let size = row.b * (logit(beliefOf) - logit(priceOf)) * opts.conviction;
      if (size <= 0) {
        note('price already past belief');
        continue;
      }

      // Nobody stakes their whole bankroll on one market.
      const budget = Math.min(balance * opts.maxStake, balance - 1);
      const cost = lmsr.costToTrade(q, row.b, outcome, size) * (1 + totalFeeRate(settings));
      attempted += 1;
      if (cost > budget) {
        // The trader wanted to move the price further than their money allows.
        // How often this happens is what actually decides whether more
        // liquidity helps or is wasted.
        capped += 1;
        size = lmsr.sharesForBudget(q, row.b, outcome, budget / (1 + totalFeeRate(settings)));
      }
      if (!(size > 0.01)) {
        note('stake too small to matter');
        continue;
      }

      try {
        logic.executeTrade(db, trader, market.id, { outcome, side: 'buy', shares: size });
        trades += 1;
      } catch (err) {
        note(err.message.slice(0, 60));
      }
    }

    const before = logic.marketRowById(db, market.id);
    const q = JSON.parse(before.q);
    const finalPrice = lmsr.prices(q, before.b)[0];

    // Settle against the hidden truth.
    const yesWins = random() < trueP;
    const settlement = logic.resolveMarket(db, house, market.id, yesWins ? 0 : 1);

    results.push({
      trueP,
      finalPrice,
      outcome: yesWins ? 1 : 0,
      b: before.b,
      subsidy: before.subsidy,
      collected: before.collected,
      volume: before.volume,
      trades,
      payout: settlement.totalPayout,
      creatorReturn: settlement.creatorReturn,
      makerLoss: settlement.totalPayout - before.collected,
      bound: lmsr.maxLoss(before.b, 2),
    });
  }

  return { db, results, opts, settings, rejected, traders, house, cappedShare: attempted ? capped / attempted : 0 };
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

/** Mean squared error of the closing price against what actually happened. */
export const brier = (results) => mean(results.map((r) => (r.finalPrice - r.outcome) ** 2));

/**
 * Expected calibration error: bucket the markets by closing price and ask, in
 * each bucket, whether the events happened as often as the price claimed. A
 * market that says 70% should be right about 70% of the time.
 */
export function calibration(results, buckets = 5) {
  const bins = Array.from({ length: buckets }, (_, i) => ({
    lo: i / buckets,
    hi: (i + 1) / buckets,
    predicted: [],
    actual: [],
  }));
  for (const r of results) {
    const index = Math.min(buckets - 1, Math.floor(r.finalPrice * buckets));
    bins[index].predicted.push(r.finalPrice);
    bins[index].actual.push(r.outcome);
  }
  const populated = bins.filter((b) => b.predicted.length > 0);
  const ece = populated.reduce(
    (sum, b) => sum + (b.predicted.length / results.length) * Math.abs(mean(b.predicted) - mean(b.actual)),
    0,
  );
  return { bins: populated, ece };
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

export function evaluate(options = {}) {
  const report = new Report(
    'Eval lab — market maker',
    `seed ${options.seed ?? DEFAULTS.seed} · ${options.markets ?? DEFAULTS.markets} markets`,
  );

  const { db, results, opts, settings, rejected } = simulate(options);

  /* --- 1. Does the price find the truth? --- */
  const discovery = report.section('Price discovery');
  const errorFinal = mean(results.map((r) => Math.abs(r.finalPrice - r.trueP)));
  const errorPrior = mean(results.map((r) => Math.abs(0.5 - r.trueP)));
  const improvement = 1 - errorFinal / errorPrior;

  discovery.note('Each market has a hidden true probability. Traders only ever see a noisy version of it.');
  discovery.table(
    ['measure', 'value'],
    [
      ['mean |price − truth| at open (50¢)', num(errorPrior, 4)],
      ['mean |price − truth| at close', num(errorFinal, 4)],
      ['error removed by trading', pct(improvement)],
      ['mean trades per market', num(mean(results.map((r) => r.trades)), 1)],
    ],
  );
  discovery.check(
    'closing price beats an uninformed 50/50',
    improvement > 0.5,
    `removed ${pct(improvement)} of the error — needs ≥50%`,
  );

  /* --- 2. Is it calibrated? ---
   *
   * Judged against an oracle that prices every market at its true probability
   * and settles on the same coin flips. The oracle is perfectly calibrated by
   * construction, so whatever error it still shows on this sample is sampling
   * noise, not miscalibration — and that is the floor the market is held to.
   * Without it, a well-behaved market on 300 samples looks 5pp off and you go
   * hunting for a bug that is not there. */
  const calib = report.section('Calibration');
  const oracleResults = results.map((r) => ({ ...r, finalPrice: r.trueP }));
  const score = brier(results);
  const oracleScore = brier(oracleResults);
  const baseline = mean(results.map((r) => (0.5 - r.outcome) ** 2));
  const skill = (baseline - score) / (baseline - oracleScore);
  const { bins, ece } = calibration(results);
  const oracleEce = calibration(oracleResults).ece;

  calib.table(
    ['price band', 'markets', 'said', 'happened', 'gap'],
    bins.map((b) => [
      `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%`,
      String(b.predicted.length),
      pct(mean(b.predicted)),
      pct(mean(b.actual)),
      pct(mean(b.actual) - mean(b.predicted)),
    ]),
  );
  calib.table(
    ['forecaster', 'Brier score'],
    [
      ['always 50%', num(baseline, 4)],
      ['the market', num(score, 4)],
      ['perfect foresight', num(oracleScore, 4)],
    ],
  );
  calib.metric('skill', pct(skill), 'share of the gap to perfect foresight the market closed');
  calib.check(
    'the market closes most of the gap to perfect foresight',
    skill > 0.6,
    `skill ${pct(skill)} — 0% is a coin flip, 100% is knowing the answer`,
  );
  calib.check(
    'calibration error within sampling noise',
    ece < oracleEce + 0.04,
    `ECE ${pct(ece)} against a noise floor of ${pct(oracleEce)} on this sample size`,
  );

  /* --- 3. Is the house's loss bounded? --- */
  const risk = report.section('Market maker risk');
  const worst = results.reduce((a, b) => (b.makerLoss > a.makerLoss ? b : a));
  const breaches = results.filter((r) => r.makerLoss > r.bound + 1e-6);
  const negativeReturns = results.filter((r) => r.creatorReturn < -1e-6);

  const makerPnl = -mean(results.map((r) => r.makerLoss));
  const creatorFees = (mean(results.map((r) => r.volume)) * settings.creatorFeeRate);

  risk.note('LMSR guarantees the maker can lose at most b·ln(n), whatever the traders do. This checks it empirically.');
  risk.table(
    ['measure', 'value'],
    [
      ['theoretical bound b·ln(2)', money(worst.bound)],
      ['worst observed maker loss', money(worst.makerLoss)],
      ['subsidy posted per market', money(opts.subsidy)],
      ['mean subsidy returned', money(mean(results.map((r) => r.creatorReturn)))],
      ['mean maker P&L per market', money(makerPnl)],
      ['creator fees earned per market', money(creatorFees)],
      ['net to the market creator', money(makerPnl + creatorFees)],
    ],
  );
  risk.note(
    makerPnl + creatorFees < 0
      ? `Creating a market is a paid service at these settings: the subsidy funds price discovery and the ${pct(settings.creatorFeeRate, 2)} creator fee does not cover it at this volume. Fine while the house creates the markets — a problem the day you want users to.`
      : 'Creators come out ahead at this volume, so user-created markets are self-sustaining.',
  );
  risk.check(
    'no market ever exceeded the b·ln(n) loss bound',
    breaches.length === 0,
    breaches.length ? `${breaches.length} breaches, worst ${money(worst.makerLoss)} vs bound ${money(worst.bound)}` : `worst ${money(worst.makerLoss)} against a bound of ${money(worst.bound)}`,
  );
  risk.check(
    'the creator never had to pay in at settlement',
    negativeReturns.length === 0,
    negativeReturns.length
      ? `${negativeReturns.length} markets left the creator owing money`
      : 'subsidy always covered the shortfall',
  );

  /* --- 4. Does the business make money? --- */
  const revenue = report.section('Fee capture');
  const volume = results.reduce((sum, r) => sum + r.volume, 0);
  const platform = treasuryBalance(db);
  const realised = volume > 0 ? platform / volume : 0;
  const target = settings.platformFeeRate;

  revenue.table(
    ['measure', 'value'],
    [
      ['notional traded', money(volume)],
      ['platform revenue', money(platform)],
      ['realised take rate', pct(realised, 3)],
      ['configured platform fee', pct(target, 3)],
      ['revenue per market', money(platform / results.length)],
    ],
  );
  revenue.check(
    'take rate matches the configured platform fee',
    Math.abs(realised - target) < target * 0.15 + 0.0005,
    `${pct(realised, 3)} against ${pct(target, 3)} — a gap here means fees are leaking`,
  );
  revenue.check('the platform never lost money', platform >= 0, `treasury ${money(platform)}`);

  /* --- 5. Did the books stay balanced? --- */
  const books = report.section('Money conservation');
  const drift = conservationDrift(db);
  books.note('Every balance, open position, AMM inventory and treasury row, added up and compared to what was granted.');
  books.metric('drift after the whole simulation', money(drift), 'should be rounding dust');
  books.check('play money is conserved', Math.abs(drift) < 0.05, `off by ${money(drift)}`);

  /* --- 6. What does liquidity cost? --- */
  const depth = report.section('Liquidity and price impact');
  depth.note('How far a single order moves a fresh 50/50 market, by subsidy. This is the number to tune before launch.');
  depth.table(
    ['subsidy', 'b', '$25 order', '$100', '$500', '$2,000', 'max loss'],
    [50, 100, 250, 500, 1000, 5000].map((subsidy) => {
      const b = lmsr.liquidityForSubsidy(subsidy, 2);
      const impact = (budget) => {
        const size = lmsr.sharesForBudget([0, 0], b, 0, budget);
        return pct(lmsr.prices(lmsr.applyTrade([0, 0], 0, size), b)[0] - 0.5, 1);
      };
      return [money(subsidy), num(b, 1), impact(25), impact(100), impact(500), impact(2000), money(lmsr.maxLoss(b, 2))];
    }),
  );

  /* --- 7. Rejected trades, so silence never looks like success --- */
  if (rejected.size) {
    const skipped = report.section('Trades the engine turned away');
    skipped.table(
      ['reason', 'count'],
      [...rejected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => [reason, String(count)]),
    );
  }

  db.close();
  return report;
}

/**
 * The same identity the test suite asserts: everything the system holds should
 * equal everything that was ever granted or deposited, minus withdrawals.
 */
export function conservationDrift(db) {
  const users = db.prepare('SELECT balance + bonus_balance AS balance FROM users').all();
  const markets = db.prepare('SELECT id, q, b, subsidy, collected, status FROM markets').all();
  const positions = db.prepare('SELECT market_id, outcome, shares FROM positions').all();

  const priceCache = new Map(markets.map((m) => [m.id, lmsr.prices(JSON.parse(m.q), m.b)]));
  let total = users.reduce((sum, u) => sum + u.balance, 0);
  for (const p of positions) total += p.shares * priceCache.get(p.market_id)[p.outcome];
  for (const m of markets) {
    if (m.status !== 'open') continue;
    const q = JSON.parse(m.q);
    const prices = priceCache.get(m.id);
    total += m.subsidy + m.collected - q.reduce((sum, x, i) => sum + x * prices[i], 0);
  }
  total += db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE account = 'platform'").get().t;

  const deposited = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM payment_intents WHERE status = 'succeeded'").get().t;
  const withdrawn = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM withdrawals WHERE status != 'rejected'").get().t;
  const bonuses = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE account = 'bonus' AND amount > 0").get().t;
  return total - (bonuses + deposited - withdrawn);
}

/* ------------------------------------------------------------------ *
 * A second experiment: how much liquidity should a market carry?
 * ------------------------------------------------------------------ */

/**
 * Subsidy is the one number the operator sets by hand, and it is a genuine
 * trade-off: too little and a single trader swings the price to nonsense, too
 * much and the price barely moves on real information. This sweeps it.
 */
export function sweepLiquidity({ seed = 11, markets = 60, bankroll = 4000, subsidies = [50, 400, 2000, 8000, 30000] } = {}) {
  const report = new Report('Eval lab — liquidity sweep', `${markets} markets at each of ${subsidies.length} subsidy levels`);
  const section = report.section('Subsidy trade-off');
  section.note(`Same traders, same truths, same ${money(bankroll)} bankrolls — only the depth of the book changes.`);

  const rows = [];
  let bestError = Infinity;
  for (const subsidy of subsidies) {
    const { db, results, cappedShare } = simulate({ seed, markets, subsidy, bankroll, tradersPerMarket: 24, traderPool: 40 });
    const error = mean(results.map((r) => Math.abs(r.finalPrice - r.trueP)));
    const volume = results.reduce((sum, r) => sum + r.volume, 0) / results.length;
    const exposure = lmsr.maxLoss(lmsr.liquidityForSubsidy(subsidy, 2), 2);
    bestError = Math.min(bestError, error);
    rows.push([money(subsidy), num(error, 4), num(brier(results), 4), pct(cappedShare), money(volume), money(exposure)]);
    db.close();
  }
  section.table(
    ['subsidy', 'mean price error', 'Brier', 'orders capped by capital', 'volume/market', 'max exposure'],
    rows,
  );

  /* Two results here, neither of them obvious.
   *
   * While traders can still afford to move the price wherever they want it,
   * the closing price is *independent of the subsidy*: doubling the liquidity
   * doubles both the shares needed to move a cent and the cost of buying them,
   * and the two cancel exactly. Thin and deep books price identically.
   *
   * Accuracy only changes once orders start hitting the capital cap — and it
   * improves. A book deep enough that nobody can single-handedly reach their
   * own belief forces the price to be an average of many traders instead of an
   * echo of the last one. Push it further and the price stops moving at all.
   * The sweet spot sits where a majority of orders are capped, which lands at
   * a few multiples of the largest order you expect. */
  const best = rows.reduce((a, b) => (Number(b[1]) < Number(a[1]) ? b : a));
  section.note('While capital is not the binding constraint, price discovery is scale-free — thin and deep books close at the same price.');
  section.note(`Accuracy improves once the book is deep enough to cap orders: the price becomes an average of many traders rather than an echo of the last one. Best here at ${best[0]} with ${best[3]} of orders capped.`);
  section.note(`Rule of thumb from these runs: set the subsidy at a few times the largest single order you expect (${money(bankroll * DEFAULTS.maxStake)} here).`);
  section.check(
    'a well-chosen subsidy prices markets to within 12¢ of the truth',
    bestError < 0.12,
    `best mean error ${num(bestError, 4)} at ${best[0]}`,
  );
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ok = evaluate().render();
  process.exit(ok ? 0 : 1);
}
