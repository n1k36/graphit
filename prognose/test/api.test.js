import test from 'node:test';
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { openDb, DEFAULT_SETTINGS, getSettings } from '../server/db.js';
import { createServer } from '../server/server.js';
import * as lmsr from '../server/lmsr.js';
import { signWebhook } from '../server/payments.js';

let server;
let base;
let db;

before(async () => {
  // The suite creates dozens of accounts; lift the anti-guessing limiter.
  process.env.PROGNOSE_AUTH_LIMIT = '10000';
  db = openDb(':memory:');
  server = createServer(db);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const signup = async (username, password = 'password123') => {
  const res = await call('/api/auth/signup', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

const inAMonth = () => new Date(Date.now() + 30 * 86400_000).toISOString();

/** Current platform revenue, straight out of the ledger. */
const treasury = () =>
  db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE account = 'platform'").get().t;

/** Complete a sandbox deposit end to end. */
async function deposit(token, amount) {
  const created = await call('/api/wallet/deposit', { method: 'POST', body: { amount }, token });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const done = await call('/api/wallet/deposit/confirm', {
    method: 'POST',
    body: { reference: created.body.reference },
    token,
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { ...created.body, user: done.body.user };
}

async function newMarket(token, overrides = {}) {
  const res = await call('/api/markets', {
    method: 'POST',
    body: {
      question: overrides.question ?? 'Will the test suite pass on the first run?',
      description: 'Resolves YES if every assertion holds.',
      category: 'Tech',
      emoji: '🧪',
      closesAt: inAMonth(),
      subsidy: 100,
      ...overrides,
    },
    token,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.market;
}

/* ------------------------------- auth -------------------------------- */

test('signup issues a token and a starting balance', async () => {
  const { user, token } = await signup('alice');
  assert.equal(user.username, 'alice');
  assert.equal(user.balance, DEFAULT_SETTINGS.welcomeBonus);
  assert.match(token, /^[a-f0-9]{64}$/);

  const me = await call('/api/me', { token });
  assert.equal(me.body.user.username, 'alice');
});

test('usernames are unique and passwords are validated', async () => {
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { username: 'alice', password: 'password123' } })).status, 409);
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { username: 'x', password: 'password123' } })).status, 400);
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { username: 'okname', password: '123' } })).status, 400);
});

test('login rejects a wrong password and accepts the right one', async () => {
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'nope' } })).status, 401);
  const ok = await call('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'password123' } });
  assert.equal(ok.status, 200);
});

test('signing out invalidates the token', async () => {
  const { token } = await signup('ephemeral');
  await call('/api/auth/logout', { method: 'POST', token });
  assert.equal((await call('/api/me', { token })).body.user, null);
});

/* ------------------------------ markets ------------------------------ */

test('creating a market deducts the subsidy and starts at even odds', async () => {
  const { token } = await signup('creator');
  const market = await newMarket(token);
  assert.equal(market.outcomes.length, 2);
  assert.ok(Math.abs(market.outcomes[0].price - 0.5) < 1e-12);
  assert.equal(market.subsidy, 100);
  // b * ln(2) is exactly the subsidy the creator posted.
  assert.ok(Math.abs(lmsr.maxLoss(market.b, 2) - 100) < 1e-9);

  const me = await call('/api/me', { token });
  assert.equal(me.body.user.balance, DEFAULT_SETTINGS.welcomeBonus - 100);
});

test('market creation validates its input', async () => {
  const { token } = await signup('validator');
  const bad = (body) => call('/api/markets', { method: 'POST', body: { closesAt: inAMonth(), ...body }, token });
  assert.equal((await bad({ question: 'short' })).status, 400);
  assert.equal((await bad({ question: 'A perfectly fine question?', closesAt: '2001-01-01' })).status, 400);
  assert.equal((await bad({ question: 'A perfectly fine question?', outcomes: ['Only one'] })).status, 400);
  assert.equal((await bad({ question: 'A perfectly fine question?', outcomes: ['Same', 'same'] })).status, 400);
  assert.equal((await bad({ question: 'A perfectly fine question?', subsidy: 5 })).status, 400);
  assert.equal((await call('/api/markets', { method: 'POST', body: { question: 'No token here?' } })).status, 401);
});

test('markets can be listed, searched and filtered', async () => {
  const { token } = await signup('lister');
  await newMarket(token, { question: 'Will a very findable unicorn appear?', category: 'Culture' });
  const all = await call('/api/markets');
  assert.ok(all.body.markets.length >= 2);
  const found = await call('/api/markets?search=findable%20unicorn');
  assert.equal(found.body.markets.length, 1);
  const byCategory = await call('/api/markets?category=Culture');
  assert.ok(byCategory.body.markets.every((m) => m.category === 'Culture'));
  assert.equal((await call('/api/markets/does-not-exist')).status, 404);
});

/* ------------------------------ trading ------------------------------ */

test('buying moves the price, debits cash and credits shares', async () => {
  const { token: creatorToken } = await signup('mm1');
  const market = await newMarket(creatorToken, { question: 'Will buying move the price up?' });
  const { token, user } = await signup('buyer1');

  const res = await call(`/api/markets/${market.slug}/trade`, {
    method: 'POST',
    body: { outcome: 0, side: 'buy', budget: 50 },
    token,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { fill, market: updated, user: updatedUser } = res.body;

  assert.ok(fill.shares > 50, 'below $1 a share, $50 buys more than 50 shares');
  assert.ok(updated.outcomes[0].price > 0.5, 'price should rise');
  assert.ok(Math.abs(updatedUser.balance - (user.balance - 50)) < 0.01, 'roughly the whole budget is spent');
  assert.ok(Math.abs(fill.avgPrice - fill.cost / fill.shares) < 1e-6);

  const detail = await call(`/api/markets/${market.slug}`, { token });
  assert.equal(detail.body.positions[0].outcome, 0);
  assert.ok(Math.abs(detail.body.positions[0].shares - fill.shares) < 1e-6);
});

test('the trading fee is split between the platform and the creator', async () => {
  const { token: creatorToken } = await signup('mm2');
  const market = await newMarket(creatorToken, { question: 'Does the creator earn the trading fee?' });
  const before = (await call('/api/me', { token: creatorToken })).body.user.balance;
  const treasuryBefore = treasury();

  const { token } = await signup('buyer2');
  const res = await call(`/api/markets/${market.slug}/trade`, {
    method: 'POST',
    body: { outcome: 1, side: 'buy', budget: 100 },
    token,
  });
  const { fee, platformFee, creatorFee } = res.body.fill;
  assert.ok(fee > 0);
  assert.ok(Math.abs(platformFee + creatorFee - fee) < 1e-6, 'the split adds back up to the whole fee');

  const after = (await call('/api/me', { token: creatorToken })).body.user.balance;
  assert.ok(Math.abs(after - before - creatorFee) < 1e-6, 'the creator gets exactly their share');
  assert.ok(Math.abs(treasury() - treasuryBefore - platformFee) < 1e-6, 'the house banks the rest');

  // And the split matches the configured rates (fees are stored to 4dp).
  const settings = getSettings(db);
  const expectedShare = settings.platformFeeRate / (settings.platformFeeRate + settings.creatorFeeRate);
  assert.ok(Math.abs(platformFee / fee - expectedShare) < 1e-3, `share was ${platformFee / fee}, expected ~${expectedShare}`);
});

test('selling returns cash and realises profit or loss', async () => {
  const { token: creatorToken } = await signup('mm3');
  const market = await newMarket(creatorToken, { question: 'Can a position be closed again?' });
  const { token } = await signup('trader3');

  const buy = await call(`/api/markets/${market.slug}/trade`, {
    method: 'POST',
    body: { outcome: 0, side: 'buy', budget: 60 },
    token,
  });
  const shares = buy.body.fill.shares;

  const sell = await call(`/api/markets/${market.slug}/trade`, {
    method: 'POST',
    body: { outcome: 0, side: 'sell', shares },
    token,
  });
  assert.equal(sell.status, 200, JSON.stringify(sell.body));
  // Buying and selling straight back loses exactly the two fees.
  assert.ok(sell.body.fill.realized < 0);
  assert.ok(Math.abs(sell.body.fill.realized) < 2.5, 'a round trip should only cost the fees');
  const detail = await call(`/api/markets/${market.slug}`, { token });
  assert.equal(detail.body.positions.length, 0, 'the closed position is gone');
});

test('you cannot sell shares you do not hold', async () => {
  const { token: creatorToken } = await signup('mm4');
  const market = await newMarket(creatorToken, { question: 'Is naked shorting blocked here?' });
  const { token } = await signup('shorty');
  const res = await call(`/api/markets/${market.slug}/trade`, {
    method: 'POST',
    body: { outcome: 0, side: 'sell', shares: 10 },
    token,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /do not hold/);
});

test('trades are rejected without funds, without a session, or on a bad outcome', async () => {
  const { token: creatorToken } = await signup('mm5');
  const market = await newMarket(creatorToken, { question: 'Are invalid trades rejected properly?' });
  const { token } = await signup('pauper');

  assert.equal(
    (await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: 99_999 }, token })).status,
    400,
  );
  assert.equal(
    (await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 7, side: 'buy', budget: 10 }, token })).status,
    400,
  );
  assert.equal(
    (await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: -5 }, token })).status,
    400,
  );
  assert.equal(
    (await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: 10 } })).status,
    401,
  );
});

test('the slippage guard rejects a fill that got materially worse', async () => {
  const { token: creatorToken } = await signup('mm6');
  const market = await newMarket(creatorToken, { question: 'Does the slippage guard actually fire?' });
  const { token } = await signup('slipper');
  const res = await call(`/api/markets/${market.slug}/trade`, {
    method: 'POST',
    body: { outcome: 0, side: 'buy', budget: 50, expectedCost: 10, slippage: 0.02 },
    token,
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /price moved/i);
});

test('a quote matches the trade that follows it', async () => {
  const { token: creatorToken } = await signup('mm7');
  const market = await newMarket(creatorToken, { question: 'Does the quote match the fill exactly?' });
  const { token } = await signup('quoter');

  const quote = await call(`/api/markets/${market.slug}/quote`, {
    method: 'POST',
    body: { outcome: 0, side: 'buy', budget: 40 },
    token,
  });
  const trade = await call(`/api/markets/${market.slug}/trade`, {
    method: 'POST',
    body: { outcome: 0, side: 'buy', budget: 40 },
    token,
  });
  assert.ok(Math.abs(quote.body.quote.shares - trade.body.fill.shares) < 1e-6);
  assert.ok(Math.abs(quote.body.quote.cashDelta - trade.body.fill.cost) < 1e-6);
});

/* ---------------------------- settlement ----------------------------- */

test('settling pays winners $1 a share and expires losers', async () => {
  const { token: creatorToken, user: creator } = await signup('mm8');
  const market = await newMarket(creatorToken, { question: 'Do winners get paid a dollar per share?' });
  const { token: winnerToken } = await signup('winner');
  const { token: loserToken } = await signup('loser');

  const win = await call(`/api/markets/${market.slug}/trade`, {
    method: 'POST',
    body: { outcome: 0, side: 'buy', budget: 80 },
    token: winnerToken,
  });
  const lose = await call(`/api/markets/${market.slug}/trade`, {
    method: 'POST',
    body: { outcome: 1, side: 'buy', budget: 80 },
    token: loserToken,
  });

  const resolved = await call(`/api/markets/${market.slug}/resolve`, {
    method: 'POST',
    body: { outcome: 0 },
    token: creatorToken,
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.market.status, 'resolved');
  assert.equal(resolved.body.market.resolvedOutcome, 0);

  const winnerBalance = (await call('/api/me', { token: winnerToken })).body.user.balance;
  const loserBalance = (await call('/api/me', { token: loserToken })).body.user.balance;
  assert.ok(Math.abs(winnerBalance - (DEFAULT_SETTINGS.welcomeBonus - 80 + win.body.fill.shares)) < 0.01);
  assert.ok(Math.abs(loserBalance - (DEFAULT_SETTINGS.welcomeBonus - 80)) < 0.01, 'the loser keeps nothing');
  assert.ok(lose.body.fill.shares > 0);

  // The creator gets the subsidy back, adjusted by the market maker's result.
  const creatorBalance = (await call('/api/me', { token: creatorToken })).body.user.balance;
  assert.ok(creatorBalance > creator.balance - 100, 'the subsidy came back');

  const detail = await call(`/api/markets/${market.slug}`, { token: winnerToken });
  assert.equal(detail.body.positions.length, 0, 'positions are cleared at settlement');
  assert.equal(detail.body.market.tradable, false);
});

test('only the creator or an admin can settle, and only once', async () => {
  const { token: creatorToken } = await signup('mm9');
  const market = await newMarket(creatorToken, { question: 'Can a stranger settle this market?' });
  const { token: strangerToken } = await signup('stranger');

  assert.equal(
    (await call(`/api/markets/${market.slug}/resolve`, { method: 'POST', body: { outcome: 0 }, token: strangerToken })).status,
    403,
  );
  assert.equal(
    (await call(`/api/markets/${market.slug}/resolve`, { method: 'POST', body: { outcome: 9 }, token: creatorToken })).status,
    400,
  );
  assert.equal((await call(`/api/markets/${market.slug}/resolve`, { method: 'POST', body: { outcome: 1 }, token: creatorToken })).status, 200);
  assert.equal((await call(`/api/markets/${market.slug}/resolve`, { method: 'POST', body: { outcome: 1 }, token: creatorToken })).status, 400);
  assert.equal(
    (await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: 5 }, token: strangerToken })).status,
    400,
    'a settled market cannot be traded',
  );
});

test('cancelling a market refunds holders at the current price', async () => {
  const { token: creatorToken } = await signup('mm10');
  const market = await newMarket(creatorToken, { question: 'Are holders refunded when cancelled?' });
  const { token } = await signup('refundee');
  await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: 40 }, token });

  const res = await call(`/api/markets/${market.slug}/resolve`, { method: 'POST', body: { outcome: null }, token: creatorToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.market.status, 'cancelled');
  const balance = (await call('/api/me', { token })).body.user.balance;
  // Refunded at market price, so most of the $40 comes back (minus fee and spread).
  assert.ok(balance > DEFAULT_SETTINGS.welcomeBonus - 5, `expected a near-full refund, balance was ${balance}`);
});

/* ------------------- multi-outcome, portfolio, social ----------------- */

test('multi-outcome markets price and trade correctly', async () => {
  const { token: creatorToken } = await signup('mm11');
  const market = await newMarket(creatorToken, {
    question: 'Which of these four options wins?',
    outcomes: ['A', 'B', 'C', 'D'],
    subsidy: 200,
  });
  assert.equal(market.outcomes.length, 4);
  for (const outcome of market.outcomes) assert.ok(Math.abs(outcome.price - 0.25) < 1e-12);

  const { token } = await signup('multitrader');
  const res = await call(`/api/markets/${market.slug}/trade`, {
    method: 'POST',
    body: { outcome: 2, side: 'buy', budget: 60 },
    token,
  });
  const prices = res.body.market.outcomes.map((o) => o.price);
  assert.ok(Math.abs(prices.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(prices[2] > 0.25 && prices[0] < 0.25);
});

test('the portfolio marks positions to market', async () => {
  const { token: creatorToken } = await signup('mm12');
  const market = await newMarket(creatorToken, { question: 'Does the portfolio mark to market?' });
  const { token } = await signup('holder');
  await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: 30 }, token });

  const { body } = await call('/api/portfolio', { token });
  assert.equal(body.positions.length, 1);
  const position = body.positions[0];
  assert.ok(Math.abs(position.value - position.shares * position.price) < 0.01);
  assert.ok(Math.abs(body.summary.netWorth - (body.summary.balance + body.summary.positionValue)) < 0.01);
  assert.equal((await call('/api/portfolio')).status, 401);
});

test('comments require a session and are returned newest first', async () => {
  const { token: creatorToken } = await signup('mm13');
  const market = await newMarket(creatorToken, { question: 'Can traders discuss this market?' });
  assert.equal((await call(`/api/markets/${market.slug}/comments`, { method: 'POST', body: { body: 'hi' } })).status, 401);
  assert.equal(
    (await call(`/api/markets/${market.slug}/comments`, { method: 'POST', body: { body: '' }, token: creatorToken })).status,
    400,
  );
  await call(`/api/markets/${market.slug}/comments`, { method: 'POST', body: { body: 'first' }, token: creatorToken });
  await call(`/api/markets/${market.slug}/comments`, { method: 'POST', body: { body: 'second' }, token: creatorToken });
  const { body } = await call(`/api/markets/${market.slug}/comments`);
  assert.equal(body.comments[0].body, 'second');
});

test('the leaderboard ranks by net worth', async () => {
  const { body } = await call('/api/leaderboard');
  assert.ok(body.users.length > 0);
  for (let i = 1; i < body.users.length; i++) {
    assert.ok(body.users[i - 1].netWorth >= body.users[i].netWorth);
    assert.equal(body.users[i].rank, i + 1);
  }
});

/* ------------------------- system-wide invariant ---------------------- */

test('play money is conserved across every account and market', () => {
  const users = db.prepare('SELECT id, balance + bonus_balance AS balance FROM users').all();
  const markets = db.prepare("SELECT id, q, b, subsidy, collected, status FROM markets").all();
  const positions = db.prepare('SELECT * FROM positions').all();

  let total = users.reduce((sum, u) => sum + u.balance, 0);
  const priceCache = new Map(markets.map((m) => [m.id, lmsr.prices(JSON.parse(m.q), m.b)]));
  for (const p of positions) total += p.shares * priceCache.get(p.market_id)[p.outcome];
  for (const m of markets) {
    if (m.status !== 'open') continue;
    const q = JSON.parse(m.q);
    const prices = priceCache.get(m.id);
    total += m.subsidy + m.collected - q.reduce((sum, x, i) => sum + x * prices[i], 0);
  }
  // Add the treasury, and account for money that entered or left via payments.
  total += db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE account = 'platform'").get().t;
  const deposited = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM payment_intents WHERE status = 'succeeded'").get().t;
  const withdrawn = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM withdrawals WHERE status != 'rejected'").get().t;
  const bonuses = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS t FROM ledger WHERE account = 'bonus' AND amount > 0")
    .get().t;
  const expected = bonuses + deposited - withdrawn;
  assert.ok(
    Math.abs(total - expected) < 0.05,
    `system holds ${total.toFixed(4)}, expected ${expected.toFixed(4)}`,
  );
});

/**
 * The create-market form reads its limits straight out of /api/config. When
 * those keys moved under `settings`, the form silently posted subsidy: NaN and
 * every creation failed with a 400. This pins the contract the UI depends on.
 */
test('/api/config exposes everything the client reads', async () => {
  const { body } = await call('/api/config');
  for (const key of ['brand', 'categories', 'paymentProvider', 'feeRate', 'settings', 'levels']) {
    assert.ok(body[key] !== undefined, `/api/config is missing ${key}`);
  }
  for (const key of ['defaultSubsidy', 'minSubsidy', 'maxSubsidy', 'welcomeBonus', 'referralBonus', 'minDeposit', 'minWithdrawal']) {
    assert.equal(typeof body.settings[key], 'number', `settings.${key} must be a number the form can use`);
  }
  assert.ok(Array.isArray(body.categories) && body.categories.length > 0);
  assert.equal(typeof body.brand.name, 'string');
});

/* ------------------------------ transport ---------------------------- */

test('unknown routes and bad payloads fail cleanly', async () => {
  assert.equal((await call('/api/nope')).status, 404);
  assert.equal((await call('/api/markets', { method: 'DELETE' })).status, 405);
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

test('the single-page app is served for unknown non-API paths', async () => {
  const res = await fetch(`${base}/portfolio`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const traversal = await fetch(`${base}/../server/db.js`);
  assert.ok(traversal.status === 404 || traversal.status === 403);
});

/* ------------------------- payments and revenue ---------------------- */

test('a deposit credits withdrawable cash exactly once', async () => {
  const { token } = await signup('depositor');
  const before = (await call('/api/me', { token })).body.user.balance;

  const created = await call('/api/wallet/deposit', { method: 'POST', body: { amount: 200 }, token });
  assert.equal(created.status, 200);
  assert.match(created.body.checkoutUrl, /^\/checkout\?ref=/);

  const first = await call('/api/wallet/deposit/confirm', { method: 'POST', body: { reference: created.body.reference }, token });
  assert.equal(first.status, 200);
  assert.equal(first.body.credited, 200);
  assert.ok(Math.abs(first.body.user.balance - (before + 200)) < 1e-6);
  assert.ok(Math.abs(first.body.user.cashBalance - 200) < 1e-6, 'deposits land in cash, not bonus');

  // Replaying the confirmation must not credit a second time.
  const replay = await call('/api/wallet/deposit/confirm', { method: 'POST', body: { reference: created.body.reference }, token });
  assert.equal(replay.body.alreadyProcessed, true);
  const after = (await call('/api/me', { token })).body.user.balance;
  assert.ok(Math.abs(after - (before + 200)) < 1e-6, 'balance unchanged by the replay');
});

test('deposits validate amount, limits and ownership', async () => {
  const { token } = await signup('deplimits');
  assert.equal((await call('/api/wallet/deposit', { method: 'POST', body: { amount: 1 }, token })).status, 400);
  assert.equal((await call('/api/wallet/deposit', { method: 'POST', body: { amount: 1e9 }, token })).status, 400);
  assert.equal((await call('/api/wallet/deposit', { method: 'POST', body: { amount: 50 } })).status, 401);

  await call('/api/limits', { method: 'POST', body: { depositLimit: 60 }, token });
  await deposit(token, 50);
  const overLimit = await call('/api/wallet/deposit', { method: 'POST', body: { amount: 50 }, token });
  assert.equal(overLimit.status, 400);
  assert.match(overLimit.body.error, /deposit limit/i);

  // Another account cannot confirm someone else's payment.
  const mine = await call('/api/wallet/deposit', { method: 'POST', body: { amount: 25 }, token: (await signup('depother')).token });
  const stolen = await call('/api/wallet/deposit/confirm', { method: 'POST', body: { reference: mine.body.reference }, token });
  assert.equal(stolen.status, 403);
});

test('the webhook is signature-checked and idempotent', async () => {
  const { token } = await signup('hooked');
  const created = await call('/api/wallet/deposit', { method: 'POST', body: { amount: 120 }, token });
  const payload = JSON.stringify({ reference: created.body.reference, status: 'succeeded' });

  const unsigned = await fetch(`${base}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  assert.equal(unsigned.status, 401, 'an unsigned webhook is rejected');

  const send = () =>
    fetch(`${base}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': signWebhook(payload) },
      body: payload,
    });
  assert.equal((await send()).status, 200);
  const balance = (await call('/api/me', { token })).body.user.balance;
  const second = await (await send()).json();
  assert.equal(second.alreadyProcessed, true);
  assert.equal((await call('/api/me', { token })).body.user.balance, balance, 'no double credit');
});

test('withdrawals are gated by the bonus wagering requirement', async () => {
  const { token } = await signup('cashout');
  await deposit(token, 300);

  // The welcome bonus has not been turned over yet, so cash is locked.
  const blocked = await call('/api/wallet/withdraw', { method: 'POST', body: { amount: 100, destination: 'DE00 1234' }, token });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /volume/i);

  const wallet = await call('/api/wallet', { token });
  assert.equal(wallet.body.withdrawable, 0);
  assert.ok(wallet.body.wageringRemaining > 0);
});

test('a withdrawal debits immediately and an admin can approve or reject it', async () => {
  const { token: adminToken } = await signup('boss');
  db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run('boss');

  const { token } = await signup('withdrawer');
  await deposit(token, 400);
  // Clear the wagering requirement so the cash unlocks.
  db.prepare('UPDATE profiles SET wagered = 999999 WHERE user_id = (SELECT id FROM users WHERE username = ?)').run('withdrawer');

  const before = (await call('/api/me', { token })).body.user.balance;
  const requested = await call('/api/wallet/withdraw', { method: 'POST', body: { amount: 150, destination: 'DE00 1234 5678' }, token });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const after = (await call('/api/me', { token })).body.user.balance;
  assert.ok(Math.abs(after - (before - 150)) < 1e-6, 'the money is held the moment it is requested');

  assert.equal((await call('/api/admin/withdrawals', { token })).status, 403, 'not an admin');
  const queue = await call('/api/admin/withdrawals', { token: adminToken });
  assert.ok(queue.body.withdrawals.some((w) => w.id === requested.body.withdrawal.id));

  const approved = await call(`/api/admin/withdrawals/${requested.body.withdrawal.id}`, {
    method: 'POST',
    body: { approve: true },
    token: adminToken,
  });
  assert.equal(approved.body.status, 'paid');
  assert.equal((await call('/api/me', { token })).body.user.balance, after, 'an approved payout does not come back');

  // A rejected one is refunded in full.
  const second = await call('/api/wallet/withdraw', { method: 'POST', body: { amount: 100, destination: 'DE00 9999' }, token });
  const rejected = await call(`/api/admin/withdrawals/${second.body.withdrawal.id}`, {
    method: 'POST',
    body: { approve: false, note: 'Verification needed' },
    token: adminToken,
  });
  assert.equal(rejected.body.status, 'rejected');
  const refunded = (await call('/api/me', { token })).body.user.balance;
  assert.ok(Math.abs(refunded - after) < 1e-6, 'the money came back');
});

test('an admin can retune the fees and the next trade uses them', async () => {
  const { token: adminToken } = await signup('economist');
  db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run('economist');
  const market = await newMarket(adminToken, { question: 'Do new fee settings take effect at once?' });
  const { token } = await signup('feepayer');

  await call('/api/admin/settings', { method: 'POST', body: { platformFeeRate: 0.05, creatorFeeRate: 0 }, token: adminToken });
  const treasuryBefore = treasury();
  const res = await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: 100 }, token });

  assert.ok(res.body.fill.platformFee > 0);
  assert.equal(res.body.fill.creatorFee, 0, 'creators get nothing at a 0% creator rate');
  assert.ok(Math.abs(treasury() - treasuryBefore - res.body.fill.platformFee) < 1e-6);
  assert.ok(res.body.fill.platformFee / res.body.fill.cost > 0.04, 'a 5% fee is actually charged');

  assert.equal((await call('/api/admin/settings', { method: 'POST', body: { platformFeeRate: 0.5 } })).status, 401);
  // Put the rates back so later tests see the defaults.
  await call('/api/admin/settings', {
    method: 'POST',
    body: { platformFeeRate: DEFAULT_SETTINGS.platformFeeRate, creatorFeeRate: DEFAULT_SETTINGS.creatorFeeRate },
    token: adminToken,
  });
});

test('the admin overview reports revenue and liabilities', async () => {
  const { token } = await signup('overseer');
  db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run('overseer');
  const { body } = await call('/api/admin/overview', { token });
  assert.ok(body.treasury > 0, 'the house has earned something by now');
  assert.ok(body.revenueByKind.some((r) => r.kind === 'trading_fee'));
  assert.ok(body.liabilities > 0);
  assert.ok(body.deposits.total > 0);
  assert.ok(Array.isArray(body.revenueByDay));
});

/* ---------------------------- engagement ----------------------------- */

test('the daily bonus pays once a day and builds a streak', async () => {
  const { token } = await signup('streaker');
  const before = (await call('/api/me', { token })).body.user.balance;

  const first = await call('/api/bonus/claim', { method: 'POST', token });
  assert.equal(first.status, 200);
  assert.equal(first.body.streak, 1);
  assert.ok(first.body.amount > 0);
  assert.ok(Math.abs(first.body.user.balance - (before + first.body.amount)) < 1e-6);
  assert.ok(first.body.user.bonusBalance > 0, 'bonus credit, not cash');

  const again = await call('/api/bonus/claim', { method: 'POST', token });
  assert.equal(again.status, 400, 'only one claim a day');

  // Backdate the claim to yesterday and the streak should continue at 2.
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  db.prepare('UPDATE profiles SET last_bonus_day = ? WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(yesterday, 'streaker');
  const second = await call('/api/bonus/claim', { method: 'POST', token });
  assert.equal(second.body.streak, 2);
  assert.ok(second.body.amount > first.body.amount, 'a longer streak pays more');
});

test('referral links pay both sides', async () => {
  const { token: inviterToken, user: inviter } = await signup('inviter');
  const { body: stats } = await call('/api/referrals', { token: inviterToken });
  assert.match(stats.code, /^[0-9A-F]{8}$/);

  const invited = await call('/api/auth/signup', {
    method: 'POST',
    body: { username: 'invitee', password: 'password123', referralCode: stats.code },
  });
  assert.equal(invited.status, 200);

  const settings = getSettings(db);
  const inviterAfter = (await call('/api/me', { token: inviterToken })).body.user.balance;
  assert.ok(Math.abs(inviterAfter - (inviter.balance + settings.referralBonus)) < 1e-6);
  assert.ok(invited.body.user.balance > settings.welcomeBonus, 'the new account got the extra too');

  const after = await call('/api/referrals', { token: inviterToken });
  assert.equal(after.body.invited, 1);
  assert.equal(after.body.earned, settings.referralBonus);
});

test('trading earns XP, levels and achievements', async () => {
  const { token: creatorToken } = await signup('xpmaker');
  const market = await newMarket(creatorToken, { question: 'Does trading actually award experience?' });
  const { token } = await signup('grinder');

  const res = await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: 300 }, token });
  assert.ok(res.body.unlocked.some((a) => a.key === 'first_trade'), 'first trade is celebrated');

  const me = (await call('/api/me', { token })).body.user;
  assert.ok(me.xp > 0);
  assert.ok(me.level.level >= 1 && me.level.name);

  const { body } = await call('/api/achievements', { token });
  assert.ok(body.achievements.find((a) => a.key === 'first_trade').earned);
  assert.ok(!body.achievements.find((a) => a.key === 'volume_10k').earned);
  // The creator earned theirs for opening a market.
  const creatorAchievements = await call('/api/achievements', { token: creatorToken });
  assert.ok(creatorAchievements.body.achievements.find((a) => a.key === 'market_maker').earned);
});

test('settling a market notifies winners and losers', async () => {
  const { token: creatorToken } = await signup('notifier');
  const market = await newMarket(creatorToken, { question: 'Does settlement send a notification?' });
  const { token: winnerToken } = await signup('notified');

  await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: 40 }, token: winnerToken });
  await call(`/api/markets/${market.slug}/resolve`, { method: 'POST', body: { outcome: 0 }, token: creatorToken });

  const { body } = await call('/api/notifications', { token: winnerToken });
  assert.ok(body.unread > 0);
  const win = body.items.find((n) => n.kind === 'win');
  assert.ok(win, 'the winner is told they won');
  assert.match(win.title, /You won/);

  await call('/api/notifications/read', { method: 'POST', token: winnerToken });
  assert.equal((await call('/api/notifications', { token: winnerToken })).body.unread, 0);
});

test('self-exclusion blocks trading and deposits', async () => {
  const { token: creatorToken } = await signup('gatekeeper');
  const market = await newMarket(creatorToken, { question: 'Does self-exclusion stop a trade?' });
  const { token } = await signup('needsabreak');

  await call('/api/limits', { method: 'POST', body: { excludeDays: 7 }, token });
  const trade = await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: 10 }, token });
  assert.equal(trade.status, 400);
  assert.match(trade.body.error, /self-excluded/i);
  assert.equal((await call('/api/wallet/deposit', { method: 'POST', body: { amount: 50 }, token })).status, 403);
  assert.equal((await call('/api/bonus/claim', { method: 'POST', token })).status, 400);
});

test('the live ticker and platform stats are public', async () => {
  const activity = await call('/api/activity');
  assert.ok(activity.body.activity.length > 0);
  const first = activity.body.activity[0];
  assert.ok(first.market.slug && first.user.username && first.outcomeLabel);
  assert.ok(['buy', 'sell'].includes(first.side), 'settlements are not shown as trades');

  const stats = await call('/api/stats');
  assert.ok(stats.body.totalVolume > 0);
  assert.ok(stats.body.traders > 0);
});
