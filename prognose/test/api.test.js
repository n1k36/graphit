import test from 'node:test';
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { openDb, CONFIG } from '../server/db.js';
import { createServer } from '../server/server.js';
import * as lmsr from '../server/lmsr.js';

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
  assert.equal(user.balance, CONFIG.startingBalance);
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
  assert.equal(me.body.user.balance, CONFIG.startingBalance - 100);
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

test('the fee is paid to the market creator', async () => {
  const { token: creatorToken } = await signup('mm2');
  const market = await newMarket(creatorToken, { question: 'Does the creator earn the trading fee?' });
  const before = (await call('/api/me', { token: creatorToken })).body.user.balance;

  const { token } = await signup('buyer2');
  const res = await call(`/api/markets/${market.slug}/trade`, {
    method: 'POST',
    body: { outcome: 1, side: 'buy', budget: 100 },
    token,
  });
  const after = (await call('/api/me', { token: creatorToken })).body.user.balance;
  assert.ok(Math.abs(after - before - res.body.fill.fee) < 1e-6);
  assert.ok(res.body.fill.fee > 0);
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
  assert.ok(Math.abs(winnerBalance - (CONFIG.startingBalance - 80 + win.body.fill.shares)) < 0.01);
  assert.ok(Math.abs(loserBalance - (CONFIG.startingBalance - 80)) < 0.01, 'the loser keeps nothing');
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
  assert.ok(balance > CONFIG.startingBalance - 5, `expected a near-full refund, balance was ${balance}`);
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
  const users = db.prepare('SELECT id, balance FROM users').all();
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
  const expected = users.length * CONFIG.startingBalance;
  assert.ok(Math.abs(total - expected) < 0.05, `system holds ${total.toFixed(4)}, expected ${expected}`);
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
