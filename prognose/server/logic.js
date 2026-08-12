import { getSettings, nowIso, totalFeeRate, transaction } from './db.js';
import { HttpError, badRequest, forbidden, notFound } from './errors.js';
import * as lmsr from './lmsr.js';
import { getUser } from './auth.js';
import { creditUser, debitUser, platformEntry } from './ledger.js';
import { publish } from './events.js';
import { assertNotSuspended } from './moderation.js';
import {
  addXp,
  assertNotExcluded,
  checkTradeMilestones,
  getProfile,
  grant,
  levelFor,
  notify,
  trendingVolume,
} from './engagement.js';

export const CATEGORIES = ['Politics', 'Crypto', 'Sports', 'Tech', 'Economics', 'Culture', 'Science', 'Other'];

/**
 * Every market carries a short ticker symbol rather than a picture. A creator
 * can set their own; left blank, it falls back to the category's code, so a
 * market always has something to identify it by in a list or on the tape.
 */
export const CATEGORY_SYMBOLS = {
  Politics: 'POL',
  Crypto: 'CRYPTO',
  Sports: 'SPORT',
  Tech: 'TECH',
  Economics: 'ECON',
  Culture: 'CULT',
  Science: 'SCI',
  Other: 'GEN',
};

/** Uppercase letters and digits only, at most six — it has to fit in a chip. */
export function normaliseSymbol(input, category) {
  const cleaned = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return cleaned || CATEGORY_SYMBOLS[category] || 'GEN';
}

/** Round money to 4dp and shares to 6dp so stored floats stay tidy. */
const money = (x) => Math.round(x * 1e4) / 1e4;
const shares = (x) => Math.round(x * 1e6) / 1e6;
const DUST = 1e-6;

/* ------------------------------------------------------------------ *
 * Reading markets
 * ------------------------------------------------------------------ */

export function serializeMarket(db, row, { includeTraders = false, creators = null } = {}) {
  const q = JSON.parse(row.q);
  const labels = JSON.parse(row.outcomes);
  const priceVector = lmsr.prices(q, row.b);
  const closed = row.status === 'open' && new Date(row.closes_at).getTime() <= Date.now();
  // `creators` lets a list view preload every author in one query instead of
  // one lookup per row.
  const creator =
    creators?.get(row.creator_id) ?? db.prepare('SELECT username, avatar FROM users WHERE id = ?').get(row.creator_id);

  const market = {
    id: row.id,
    slug: row.slug,
    question: row.question,
    description: row.description,
    category: row.category,
    symbol: row.symbol,
    outcomes: labels.map((label, i) => ({ index: i, label, price: priceVector[i], shares: q[i] })),
    q,
    b: row.b,
    subsidy: row.subsidy,
    volume: row.volume,
    tradeCount: row.trade_count,
    liquidity: row.b,
    feeRate: totalFeeRate(getSettings(db)),
    creator: creator ? { id: row.creator_id, username: creator.username, avatar: creator.avatar } : null,
    createdAt: row.created_at,
    closesAt: row.closes_at,
    status: row.status,
    closed,
    tradable: row.status === 'open' && !closed,
    resolvedOutcome: row.resolved_outcome,
    resolvedAt: row.resolved_at,
    featured: !!row.featured,
    hidden: !!row.hidden,
    isBinary: labels.length === 2 && labels[0].toLowerCase() === 'yes',
  };

  if (includeTraders) {
    market.traders = db
      .prepare('SELECT COUNT(DISTINCT user_id) AS n FROM trades WHERE market_id = ?')
      .get(row.id).n;
  }
  return market;
}

export function listMarkets(db, opts = {}) {
  const { search = '', category = '', status = 'all', sort = 'volume', limit = 200 } = opts;
  const where = [];
  const params = [];
  if (search) {
    where.push('(question LIKE ? OR description LIKE ? OR category LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (category && category !== 'All') {
    where.push('category = ?');
    params.push(category);
  }
  // Hidden markets are gone from every listing, for everyone.
  where.push('hidden = 0');
  const now = nowIso();
  if (status === 'open') {
    where.push("status = 'open' AND closes_at > ?");
    params.push(now);
  } else if (status === 'closed') {
    where.push("status = 'open' AND closes_at <= ?");
    params.push(now);
  } else if (status === 'resolved') {
    where.push("status IN ('resolved','cancelled')");
  }

  const order =
    {
      volume: 'volume DESC, id DESC',
      newest: 'id DESC',
      closing: "CASE WHEN status = 'open' THEN 0 ELSE 1 END, closes_at ASC",
      activity: 'trade_count DESC, id DESC',
    }[sort] || 'volume DESC, id DESC';

  // Featured markets are pinned above whatever sort is active.
  const sql = `SELECT * FROM markets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY featured DESC, ${order} LIMIT ?`;
  const rows = db.prepare(sql).all(...params, Math.min(Number(limit) || 200, 500));

  // Preload everything the rows need, so serialising N markets stays O(1) in
  // queries rather than O(N).
  const ids = rows.map((r) => r.id);
  const creators = new Map(
    ids.length
      ? db
          .prepare(
            `SELECT id, username, avatar FROM users WHERE id IN (SELECT DISTINCT creator_id FROM markets WHERE id IN (${ids.map(() => '?').join(',')}))`,
          )
          .all(...ids)
          .map((u) => [u.id, u])
      : [],
  );
  const sparks = new Map();
  if (ids.length) {
    // One pass over recent trades, bucketed per market, newest last.
    for (const t of db
      .prepare(
        `SELECT market_id, prices FROM trades
         WHERE market_id IN (${ids.map(() => '?').join(',')}) AND side IN ('buy','sell')
         ORDER BY id`,
      )
      .all(...ids)) {
      const bucket = sparks.get(t.market_id) ?? [];
      bucket.push(JSON.parse(t.prices)[0]);
      if (bucket.length > 40) bucket.shift();
      sparks.set(t.market_id, bucket);
    }
  }
  const trending = trendingVolume(db);
  const hotThreshold = Math.max(50, [...trending.values()].map((t) => t.volume).sort((a, b) => b - a)[2] ?? 0);
  const list = rows.map((row) => {
    const market = serializeMarket(db, row, { creators });
    const n = market.outcomes.length;
    market.spark = [1 / n, ...(sparks.get(row.id) ?? [])];
    const hot = trending.get(row.id);
    market.volume24h = money(hot?.volume ?? 0);
    market.trades24h = hot?.trades ?? 0;
    market.hot = market.status === 'open' && !market.closed && (hot?.volume ?? 0) >= hotThreshold && hotThreshold > 0;
    return market;
  });
  if (opts.sort === 'hot') list.sort((a, b) => Number(b.featured) - Number(a.featured) || b.volume24h - a.volume24h);
  return list;
}

export function marketRowBySlug(db, slug) {
  const row = db.prepare('SELECT * FROM markets WHERE slug = ?').get(String(slug));
  if (!row) throw notFound('No such market.');
  return row;
}

export function marketRowById(db, id) {
  const row = db.prepare('SELECT * FROM markets WHERE id = ?').get(Number(id));
  if (!row) throw notFound('No such market.');
  return row;
}

/** Price history for the chart, derived from the trade log. */
export function marketHistory(db, marketId) {
  const row = marketRowById(db, marketId);
  const labels = JSON.parse(row.outcomes);
  const opening = lmsr.prices(new Array(labels.length).fill(0), row.b);
  const points = [{ t: row.created_at, prices: opening }];
  const trades = db
    .prepare("SELECT created_at, prices FROM trades WHERE market_id = ? AND side IN ('buy','sell') ORDER BY id")
    .all(marketId);
  for (const t of trades) points.push({ t: t.created_at, prices: JSON.parse(t.prices) });
  if (row.status === 'resolved' && row.resolved_outcome !== null) {
    points.push({
      t: row.resolved_at,
      prices: labels.map((_, i) => (i === row.resolved_outcome ? 1 : 0)),
    });
  }
  return { labels, points };
}

/**
 * Biggest positions in a market. Social proof: seeing who is on each side,
 * and how heavily, is what makes a market feel worth having an opinion about.
 */
export function marketHolders(db, marketId, limit = 6) {
  const row = marketRowById(db, marketId);
  const labels = JSON.parse(row.outcomes);
  const prices = lmsr.prices(JSON.parse(row.q), row.b);
  return db
    .prepare(
      `SELECT p.outcome, p.shares, p.cost_basis, u.id, u.username, u.avatar
       FROM positions p JOIN users u ON u.id = p.user_id
       WHERE p.market_id = ? ORDER BY p.shares DESC LIMIT ?`,
    )
    .all(marketId, limit)
    .map((h) => ({
      user: { id: h.id, username: h.username, avatar: h.avatar },
      outcome: h.outcome,
      outcomeLabel: labels[h.outcome],
      shares: h.shares,
      value: money(h.shares * prices[h.outcome]),
      unrealized: money(h.shares * prices[h.outcome] - h.cost_basis),
    }));
}

export function marketTrades(db, marketId, limit = 30) {
  return db
    .prepare(
      `SELECT t.*, u.username, u.avatar FROM trades t
       JOIN users u ON u.id = t.user_id
       WHERE t.market_id = ? ORDER BY t.id DESC LIMIT ?`,
    )
    .all(marketId, limit)
    .map(serializeTrade);
}

function serializeTrade(t) {
  return {
    id: t.id,
    marketId: t.market_id,
    user: { id: t.user_id, username: t.username, avatar: t.avatar },
    outcome: t.outcome,
    side: t.side,
    shares: t.shares,
    cost: t.cost,
    fee: t.fee,
    avgPrice: t.avg_price,
    createdAt: t.created_at,
    marketQuestion: t.question,
    marketSlug: t.slug,
    outcomes: t.outcomes ? JSON.parse(t.outcomes) : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Creating markets
 * ------------------------------------------------------------------ */

export function slugify(question) {
  const base =
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60)
      .replace(/-+$/, '') || 'market';
  return base;
}

function uniqueSlug(db, base) {
  let slug = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM markets WHERE slug = ?').get(slug)) slug = `${base}-${n++}`;
  return slug;
}

export function createMarket(db, user, input) {
  const question = String(input.question ?? '').trim();
  if (question.length < 8 || question.length > 200) {
    throw badRequest('The question must be between 8 and 200 characters.');
  }
  const description = String(input.description ?? '').trim().slice(0, 5000);
  const category = CATEGORIES.includes(input.category) ? input.category : 'Other';
  const symbol = normaliseSymbol(input.symbol, category);

  let outcomes = Array.isArray(input.outcomes) && input.outcomes.length ? input.outcomes : ['Yes', 'No'];
  outcomes = outcomes.map((o) => String(o ?? '').trim()).filter(Boolean);
  if (outcomes.length < 2 || outcomes.length > 8) throw badRequest('A market needs between 2 and 8 outcomes.');
  if (outcomes.some((o) => o.length > 40)) throw badRequest('Outcome labels are limited to 40 characters.');
  if (new Set(outcomes.map((o) => o.toLowerCase())).size !== outcomes.length) {
    throw badRequest('Outcome labels must be unique.');
  }

  const closesAt = new Date(input.closesAt ?? '');
  if (Number.isNaN(closesAt.getTime())) throw badRequest('Give a valid close date.');
  if (closesAt.getTime() <= Date.now()) throw badRequest('The close date has to be in the future.');
  if (closesAt.getTime() > Date.now() + 5 * 365 * 24 * 3600 * 1000) {
    throw badRequest('The close date cannot be more than 5 years out.');
  }

  const settings = getSettings(db);
  const subsidy = Number(input.subsidy ?? settings.defaultSubsidy);
  if (!Number.isFinite(subsidy) || subsidy < settings.minSubsidy || subsidy > settings.maxSubsidy) {
    throw badRequest(`The liquidity subsidy must be between $${settings.minSubsidy} and $${settings.maxSubsidy}.`);
  }
  const listingFee = settings.listingFee;

  return transaction(db, () => {
    assertNotExcluded(db, user.id);
    assertNotSuspended(db, user.id);
    const fresh = db.prepare('SELECT balance, bonus_balance FROM users WHERE id = ?').get(user.id);
    const available = (fresh?.balance ?? 0) + (fresh?.bonus_balance ?? 0);
    const required = subsidy + listingFee;
    if (available < required) {
      throw badRequest(`You need $${required.toFixed(2)} to open this market; your balance is $${available.toFixed(2)}.`);
    }
    const b = lmsr.liquidityForSubsidy(subsidy, outcomes.length);
    const slug = uniqueSlug(db, slugify(question));
    const info = db
      .prepare(
        `INSERT INTO markets (slug, question, description, category, symbol, outcomes, q, b, subsidy,
                              creator_id, created_at, closes_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        slug,
        question,
        description,
        category,
        symbol,
        JSON.stringify(outcomes),
        JSON.stringify(new Array(outcomes.length).fill(0)),
        b,
        money(subsidy),
        user.id,
        nowIso(),
        closesAt.toISOString(),
      );
    const marketId = Number(info.lastInsertRowid);
    debitUser(db, user.id, money(subsidy), { kind: 'subsidy', marketId, memo: 'Liquidity posted' });
    if (listingFee > 0) {
      debitUser(db, user.id, money(listingFee), { kind: 'listing_fee', marketId, memo: 'Market listing fee' });
      platformEntry(db, money(listingFee), { kind: 'listing_fee', userId: user.id, marketId, memo: 'Market listing fee' });
    }
    grant(db, user.id, 'market_maker');
    return serializeMarket(db, marketRowById(db, marketId));
  });
}

/* ------------------------------------------------------------------ *
 * Trading
 * ------------------------------------------------------------------ */

function parseTradeInput(db, row, userId, input) {
  const labels = JSON.parse(row.outcomes);
  const q = JSON.parse(row.q);
  const outcome = Number(input.outcome);
  if (!Number.isInteger(outcome) || outcome < 0 || outcome >= labels.length) {
    throw badRequest('Pick a valid outcome.');
  }
  const side = input.side === 'sell' ? 'sell' : 'buy';

  let size;
  if (side === 'buy') {
    if (input.budget != null) {
      const budget = Number(input.budget);
      if (!Number.isFinite(budget) || budget <= 0) throw badRequest('Enter an amount greater than zero.');
      if (budget > 1e9) throw badRequest('That amount is too large.');
      size = lmsr.sharesForBudget(q, row.b, outcome, budget / (1 + totalFeeRate(getSettings(db))));
    } else {
      size = Number(input.shares);
      if (!Number.isFinite(size) || size <= 0) throw badRequest('Enter a share count greater than zero.');
      if (size > 1e9) throw badRequest('That trade is too large.');
    }
  } else {
    const held = userId
      ? db.prepare('SELECT shares FROM positions WHERE user_id = ? AND market_id = ? AND outcome = ?')
          .get(userId, row.id, outcome)?.shares ?? 0
      : Number(input.shares) || 0;
    size = input.sellAll ? held : Number(input.shares);
    if (!Number.isFinite(size) || size <= 0) throw badRequest('Enter a share count greater than zero.');
    if (userId) {
      if (held <= 0) throw badRequest('You do not hold any shares of that outcome.');
      if (size > held + DUST) throw badRequest(`You only hold ${held.toFixed(2)} shares of that outcome.`);
      size = Math.min(size, held);
    }
  }
  return { outcome, side, size: shares(size), q, labels };
}

export function quoteTrade(db, marketId, input, userId = null) {
  const row = marketRowById(db, marketId);
  const { outcome, side, size, q, labels } = parseTradeInput(db, row, userId, input);
  const quote = lmsr.quote(q, row.b, outcome, side, size, totalFeeRate(getSettings(db)));
  return {
    side,
    outcome,
    outcomeLabel: labels[outcome],
    shares: shares(quote.shares),
    cost: money(Math.abs(quote.cost)),
    fee: money(quote.fee),
    /** Cash out of the user's pocket; negative when selling. */
    cashDelta: money(quote.cashDelta),
    /** All-in price per share, fee included. */
    avgPrice: quote.shares > 0 ? Math.abs(quote.cashDelta) / quote.shares : 0,
    priceBefore: quote.pricesBefore[outcome],
    priceAfter: quote.pricesAfter[outcome],
    pricesAfter: quote.pricesAfter,
    /** What the shares pay if this outcome happens. */
    payout: side === 'buy' ? money(quote.shares) : 0,
    profitIfCorrect: side === 'buy' ? money(quote.shares - quote.cashDelta) : 0,
  };
}

export function executeTrade(db, user, marketId, input) {
  const result = transaction(db, () => {
    const row = marketRowById(db, marketId);
    if (row.status !== 'open') throw badRequest('This market has already been settled.');
    if (row.hidden) throw badRequest('This market is under review and trading is frozen.');
    if (new Date(row.closes_at).getTime() <= Date.now()) throw badRequest('This market is closed for trading.');

    assertNotExcluded(db, user.id);
    assertNotSuspended(db, user.id);
    const { outcome, side, size, q, labels } = parseTradeInput(db, row, user.id, input);
    if (size <= 0) throw badRequest('That trade rounds to zero shares.');

    const settings = getSettings(db);
    const quote = lmsr.quote(q, row.b, outcome, side, size, totalFeeRate(settings));
    const cashDelta = money(quote.cashDelta); // > 0 when buying, < 0 when selling
    const fee = money(quote.fee);
    const notional = money(Math.abs(quote.cost));
    const avgPrice = Math.abs(cashDelta) / size; // all-in price per share, fee included

    // Slippage guard: the client previews a price, and we refuse to fill a
    // materially worse one (someone else may have traded in between).
    if (input.expectedCost != null) {
      const expected = Math.abs(Number(input.expectedCost));
      const tolerance = Math.min(Math.max(Number(input.slippage ?? 0.02), 0), 0.5);
      if (Number.isFinite(expected) && expected > 0) {
        const actual = Math.abs(cashDelta);
        const worse = side === 'buy' ? actual > expected * (1 + tolerance) : actual < expected * (1 - tolerance);
        if (worse) {
          throw new HttpError(409, 'The price moved while you were trading. Review the new quote and try again.');
        }
      }
    }

    const fresh = db.prepare('SELECT balance, bonus_balance FROM users WHERE id = ?').get(user.id);
    const available = money(fresh.balance + fresh.bonus_balance);
    if (side === 'buy' && available < cashDelta - 1e-9) {
      throw badRequest(`Not enough balance: this costs $${cashDelta.toFixed(2)} and you have $${available.toFixed(2)}.`);
    }

    // Split the fee between the house and the market's creator.
    const share = totalFeeRate(settings) > 0 ? settings.platformFeeRate / totalFeeRate(settings) : 0;
    const platformFee = money(fee * share);
    const creatorFee = money(fee - platformFee);

    // Position accounting.
    const posRow =
      db.prepare('SELECT * FROM positions WHERE user_id = ? AND market_id = ? AND outcome = ?')
        .get(user.id, row.id, outcome) ?? { shares: 0, cost_basis: 0 };
    let realized = 0;
    let newShares;
    let newBasis;
    if (side === 'buy') {
      newShares = shares(posRow.shares + size);
      newBasis = money(posRow.cost_basis + cashDelta);
    } else {
      const proceeds = -cashDelta; // positive cash received
      const fraction = posRow.shares > 0 ? Math.min(size / posRow.shares, 1) : 1;
      const basisSold = money(posRow.cost_basis * fraction);
      realized = money(proceeds - basisSold);
      newShares = shares(posRow.shares - size);
      newBasis = money(posRow.cost_basis - basisSold);
      if (newShares <= DUST) {
        // Sweep dust so a fully closed position leaves no residue behind.
        realized = money(realized - newBasis);
        newShares = 0;
        newBasis = 0;
      }
    }

    if (newShares > 0) {
      db.prepare(
        `INSERT INTO positions (user_id, market_id, outcome, shares, cost_basis) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, market_id, outcome) DO UPDATE SET shares = excluded.shares, cost_basis = excluded.cost_basis`,
      ).run(user.id, row.id, outcome, newShares, newBasis);
    } else {
      db.prepare('DELETE FROM positions WHERE user_id = ? AND market_id = ? AND outcome = ?').run(
        user.id,
        row.id,
        outcome,
      );
    }

    // Money movement, every leg booked to the ledger.
    if (cashDelta > 0) {
      debitUser(db, user.id, cashDelta, { kind: 'trade_buy', marketId: row.id, memo: `Buy ${labels[outcome]}` });
    } else if (cashDelta < 0) {
      creditUser(db, user.id, -cashDelta, { kind: 'trade_sell', marketId: row.id, memo: `Sell ${labels[outcome]}` });
    }
    db.prepare('UPDATE users SET realized_pnl = realized_pnl + ? WHERE id = ?').run(realized, user.id);

    if (platformFee > 0) {
      platformEntry(db, platformFee, { kind: 'trading_fee', userId: user.id, marketId: row.id, memo: 'Platform trading fee' });
    }
    if (creatorFee > 0) {
      creditUser(db, row.creator_id, creatorFee, { kind: 'creator_fee', marketId: row.id, memo: 'Creator trading fee' });
    }

    // Engagement: turnover drives XP, levels, achievements and the wagering
    // requirement that gates withdrawals of bonus money.
    db.prepare('UPDATE profiles SET wagered = wagered + ? WHERE user_id = ?').run(notional, user.id);
    addXp(db, user.id, notional);

    const nextQ = quote.q.map(shares);
    db.prepare(
      `UPDATE markets SET q = ?, collected = collected + ?, volume = volume + ?, trade_count = trade_count + 1
       WHERE id = ?`,
    ).run(JSON.stringify(nextQ), money(quote.cost), notional, row.id);

    db.prepare(
      `INSERT INTO trades (market_id, user_id, outcome, side, shares, cost, fee, avg_price, prices, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      user.id,
      outcome,
      side,
      shares(size),
      cashDelta,
      fee,
      avgPrice,
      JSON.stringify(quote.pricesAfter),
      nowIso(),
    );

    const unlocked = checkTradeMilestones(db, user.id);

    return {
      market: serializeMarket(db, marketRowById(db, row.id)),
      user: getUser(db, user.id),
      unlocked,
      fill: {
        side,
        outcome,
        outcomeLabel: labels[outcome],
        shares: shares(size),
        cost: Math.abs(cashDelta),
        fee,
        platformFee,
        creatorFee,
        avgPrice,
        realized,
      },
      position: { shares: newShares, costBasis: newBasis },
    };
  });

  // Only after the commit, so nobody is told about a trade that rolled back.
  publish('trade', {
    slug: result.market.slug,
    marketId: result.market.id,
    prices: result.market.outcomes.map((o) => o.price),
    volume: result.market.volume,
    fill: {
      side: result.fill.side,
      outcomeLabel: result.fill.outcomeLabel,
      shares: result.fill.shares,
      cost: result.fill.cost,
      price: result.fill.avgPrice,
    },
    user: { username: user.username, avatar: user.avatar },
    market: { slug: result.market.slug, question: result.market.question, symbol: result.market.symbol },
  });
  return result;
}

/* ------------------------------------------------------------------ *
 * Settlement
 * ------------------------------------------------------------------ */

/**
 * Settle a market. `outcome` is the winning index, or null to cancel the
 * market and refund every holder at the last traded price.
 */
export function resolveMarket(db, user, marketId, outcome) {
  const result = transaction(db, () => {
    const row = marketRowById(db, marketId);
    if (row.status !== 'open') throw badRequest('This market has already been settled.');
    if (row.creator_id !== user.id && !user.isAdmin) {
      throw forbidden('Only the market creator can settle this market.');
    }
    const labels = JSON.parse(row.outcomes);
    const q = JSON.parse(row.q);
    const cancelled = outcome === null || outcome === undefined || outcome === '';
    let winner = null;
    if (!cancelled) {
      winner = Number(outcome);
      if (!Number.isInteger(winner) || winner < 0 || winner >= labels.length) {
        throw badRequest('Pick a valid winning outcome.');
      }
    }
    const finalPrices = cancelled ? lmsr.prices(q, row.b) : labels.map((_, i) => (i === winner ? 1 : 0));

    const positions = db.prepare('SELECT * FROM positions WHERE market_id = ?').all(row.id);
    let totalPayout = 0;
    const at = nowIso();
    const perUser = new Map();
    for (const pos of positions) {
      const payout = money(pos.shares * finalPrices[pos.outcome]);
      const realized = money(payout - pos.cost_basis);
      totalPayout += payout;
      if (payout > 0) {
        creditUser(db, pos.user_id, payout, {
          kind: cancelled ? 'refund' : 'payout',
          marketId: row.id,
          memo: cancelled ? 'Market cancelled' : `Settled ${labels[pos.outcome]}`,
        });
      }
      db.prepare('UPDATE users SET realized_pnl = realized_pnl + ? WHERE id = ?').run(realized, pos.user_id);
      const tally = perUser.get(pos.user_id) ?? { payout: 0, realized: 0 };
      tally.payout += payout;
      tally.realized += realized;
      perUser.set(pos.user_id, tally);
      db.prepare(
        `INSERT INTO trades (market_id, user_id, outcome, side, shares, cost, fee, avg_price, prices, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        pos.user_id,
        pos.outcome,
        'settle',
        pos.shares,
        money(-payout),
        0,
        finalPrices[pos.outcome],
        JSON.stringify(finalPrices),
        at,
      );
    }
    db.prepare('DELETE FROM positions WHERE market_id = ?').run(row.id);

    // Tell everyone how they did — this is what pulls people back in.
    for (const [userId, tally] of perUser) {
      const won = tally.realized >= 0;
      db.prepare(`UPDATE profiles SET wins = wins + ?, losses = losses + ? WHERE user_id = ?`).run(
        won ? 1 : 0,
        won ? 0 : 1,
        userId,
      );
      if (won && !cancelled) grant(db, userId, 'first_win');
      notify(db, userId, {
        kind: won ? 'win' : 'loss',
        title: cancelled
          ? 'Market cancelled'
          : won
            ? `You won $${money(tally.payout).toFixed(2)}`
            : 'Market settled against you',
        body: `${row.question} — settled ${cancelled ? 'as cancelled' : labels[winner]}.`,
        href: `#/market/${row.slug}`,
        amount: money(tally.realized),
      });
    }

    // The creator gets their subsidy back, plus whatever the AMM took in and
    // did not have to pay out (this can be a loss, bounded by the subsidy).
    const creatorReturn = money(row.subsidy + row.collected - totalPayout);
    if (creatorReturn > 0) {
      creditUser(db, row.creator_id, creatorReturn, {
        kind: 'subsidy_return',
        marketId: row.id,
        memo: 'Liquidity returned at settlement',
      });
    } else if (creatorReturn < 0) {
      debitUser(db, row.creator_id, -creatorReturn, {
        kind: 'subsidy_return',
        marketId: row.id,
        memo: 'Market maker shortfall',
      });
    }

    db.prepare('UPDATE markets SET status = ?, resolved_outcome = ?, resolved_at = ? WHERE id = ?').run(
      cancelled ? 'cancelled' : 'resolved',
      cancelled ? null : winner,
      at,
      row.id,
    );

    return {
      market: serializeMarket(db, marketRowById(db, row.id)),
      totalPayout: money(totalPayout),
      creatorReturn,
      paidUsers: [...perUser.keys()],
      topWinner: (() => {
        let best = null;
        for (const [userId, tally] of perUser) {
          if (tally.realized > 0 && (!best || tally.realized > best.realized)) best = { userId, ...tally };
        }
        if (!best) return null;
        const who = db.prepare('SELECT username, avatar FROM users WHERE id = ?').get(best.userId);
        return { username: who.username, avatar: who.avatar, won: money(best.realized) };
      })(),
    };
  });

  publish('settled', {
    slug: result.market.slug,
    marketId: result.market.id,
    status: result.market.status,
    resolvedOutcome: result.market.resolvedOutcome,
    question: result.market.question,
    symbol: result.market.symbol,
    topWinner: result.topWinner,
  });
  return result;
}

/* ------------------------------------------------------------------ *
 * Portfolio, activity, leaderboard
 * ------------------------------------------------------------------ */

/**
 * Mark-to-market value of the AMM positions a user is on the hook for as a
 * market creator: the subsidy they posted plus cash the AMM took in, minus
 * what it currently owes share holders. Returned to them at settlement.
 */
export function creatorEquity(db, userId) {
  const rows = db
    .prepare("SELECT subsidy, collected, q, b FROM markets WHERE creator_id = ? AND status = 'open'")
    .all(userId);
  let total = 0;
  for (const r of rows) {
    const q = JSON.parse(r.q);
    const p = lmsr.prices(q, r.b);
    total += r.subsidy + r.collected - q.reduce((sum, x, i) => sum + x * p[i], 0);
  }
  return money(total);
}

export function portfolio(db, userId) {
  const user = getUser(db, userId);
  if (!user) throw notFound('No such user.');
  const rows = db
    .prepare(
      `SELECT p.*, m.slug, m.question, m.symbol, m.outcomes, m.q, m.b, m.status, m.closes_at, m.resolved_outcome
       FROM positions p JOIN markets m ON m.id = p.market_id
       WHERE p.user_id = ? ORDER BY p.market_id DESC`,
    )
    .all(userId);

  let invested = 0;
  let value = 0;
  const positions = rows.map((r) => {
    const price = lmsr.prices(JSON.parse(r.q), r.b)[r.outcome];
    const marketValue = money(r.shares * price);
    invested += r.cost_basis;
    value += marketValue;
    return {
      marketId: r.market_id,
      slug: r.slug,
      question: r.question,
      symbol: r.symbol,
      outcome: r.outcome,
      outcomeLabel: JSON.parse(r.outcomes)[r.outcome],
      shares: r.shares,
      costBasis: money(r.cost_basis),
      avgPrice: r.shares > 0 ? r.cost_basis / r.shares : 0,
      price,
      value: marketValue,
      unrealized: money(marketValue - r.cost_basis),
      status: r.status,
      closesAt: r.closes_at,
    };
  });

  const history = db
    .prepare(
      `SELECT t.*, m.question, m.slug, m.outcomes FROM trades t JOIN markets m ON m.id = t.market_id
       WHERE t.user_id = ? ORDER BY t.id DESC LIMIT 100`,
    )
    .all(userId)
    .map((t) => ({ ...serializeTrade({ ...t, username: user.username, avatar: user.avatar }) }));

  const equity = creatorEquity(db, userId);
  const profile = getProfile(db, userId);
  const netWorth = money(user.balance + value + equity);
  // What the account has actually been funded with: deposits and promo credit,
  // less anything already taken out. Profit is everything above that line.
  const funded = money(profile.deposited + profile.bonusGranted - profile.withdrawn);
  return {
    user,
    positions,
    history,
    profile,
    summary: {
      balance: money(user.balance),
      cash: money(user.cashBalance),
      bonus: money(user.bonusBalance),
      invested: money(invested),
      positionValue: money(value),
      creatorEquity: equity,
      netWorth,
      funded,
      unrealized: money(value - invested),
      realized: money(user.realizedPnl),
      profit: money(netWorth - funded),
    },
  };
}

/**
 * Leaderboard, in a fixed number of queries regardless of user count.
 *
 * The previous version issued ~4 statements per user (creator equity, market
 * count, trade count), which is fine for five accounts and fatal for ten
 * thousand. Everything below is aggregated set-wise instead.
 */
export function leaderboard(db, limit = 50) {
  const priceByMarket = new Map(
    db
      .prepare('SELECT id, q, b, subsidy, collected, status FROM markets')
      .all()
      .map((m) => [m.id, { ...m, prices: lmsr.prices(JSON.parse(m.q), m.b) }]),
  );

  // Mark every position to market in one pass.
  const positionValue = new Map();
  for (const p of db.prepare('SELECT user_id, market_id, outcome, shares FROM positions').all()) {
    const price = priceByMarket.get(p.market_id)?.prices?.[p.outcome] ?? 0;
    positionValue.set(p.user_id, (positionValue.get(p.user_id) ?? 0) + p.shares * price);
  }

  // Creator equity: subsidy plus cash taken in, less what the AMM still owes.
  const equityByUser = new Map();
  const marketsByUser = new Map();
  for (const row of db.prepare('SELECT id, creator_id, status FROM markets').all()) {
    marketsByUser.set(row.creator_id, (marketsByUser.get(row.creator_id) ?? 0) + 1);
    if (row.status !== 'open') continue;
    const m = priceByMarket.get(row.id);
    const q = JSON.parse(m.q);
    const owed = q.reduce((sum, x, i) => sum + x * m.prices[i], 0);
    equityByUser.set(row.creator_id, (equityByUser.get(row.creator_id) ?? 0) + m.subsidy + m.collected - owed);
  }

  const tradesByUser = new Map(
    db
      .prepare("SELECT user_id, COUNT(*) AS n FROM trades WHERE side != 'settle' GROUP BY user_id")
      .all()
      .map((r) => [r.user_id, r.n]),
  );

  const users = db
    .prepare(
      `SELECT u.id, u.username, u.avatar, u.balance, u.bonus_balance, u.realized_pnl,
              p.deposited, p.bonus_granted, p.withdrawn, p.xp, p.streak, p.wins, p.losses
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id`,
    )
    .all();

  return users
    .map((u) => {
      const value = positionValue.get(u.id) ?? 0;
      const equity = equityByUser.get(u.id) ?? 0;
      const balance = u.balance + (u.bonus_balance ?? 0);
      const netWorth = money(balance + value + equity);
      const funded = money((u.deposited ?? 0) + (u.bonus_granted ?? 0) - (u.withdrawn ?? 0));
      return {
        id: u.id,
        username: u.username,
        avatar: u.avatar,
        balance: money(balance),
        positionValue: money(value),
        creatorEquity: money(equity),
        netWorth,
        level: levelFor(u.xp ?? 0),
        streak: u.streak ?? 0,
        wins: u.wins ?? 0,
        losses: u.losses ?? 0,
        /** Return on what the account was funded with, so whales and small
         *  accounts can be compared on the same axis. */
        roi: funded > 0 ? (netWorth - funded) / funded : 0,
        profit: money(netWorth - funded),
        realized: money(u.realized_pnl),
        marketsCreated: marketsByUser.get(u.id) ?? 0,
        trades: tradesByUser.get(u.id) ?? 0,
      };
    })
    .sort((a, b) => b.netWorth - a.netWorth)
    .slice(0, limit)
    .map((u, i) => ({ ...u, rank: i + 1 }));
}

/** Every open position the user holds, grouped by market id. */
export function holdingsByMarket(db, userId) {
  const out = {};
  for (const row of db
    .prepare(
      `SELECT p.market_id, p.outcome, p.shares, p.cost_basis, m.outcomes
       FROM positions p JOIN markets m ON m.id = p.market_id WHERE p.user_id = ?`,
    )
    .all(userId)) {
    (out[row.market_id] ??= []).push({
      outcome: row.outcome,
      outcomeLabel: JSON.parse(row.outcomes)[row.outcome],
      shares: row.shares,
      costBasis: money(row.cost_basis),
    });
  }
  return out;
}

export function userPositionsFor(db, userId, marketId) {
  if (!userId) return [];
  return db
    .prepare('SELECT outcome, shares, cost_basis FROM positions WHERE user_id = ? AND market_id = ?')
    .all(userId, marketId)
    .map((p) => ({ outcome: p.outcome, shares: p.shares, costBasis: money(p.cost_basis) }));
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

export function listComments(db, marketId) {
  return db
    .prepare(
      `SELECT c.*, u.username, u.avatar FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.market_id = ? ORDER BY c.id DESC LIMIT 200`,
    )
    .all(marketId)
    .map((c) => ({
      id: c.id,
      body: c.deleted ? '' : c.body,
      removed: !!c.deleted,
      createdAt: c.created_at,
      user: c.deleted ? { id: null, username: '—', avatar: '#5c6880' } : { id: c.user_id, username: c.username, avatar: c.avatar },
    }));
}

export function addComment(db, user, marketId, body) {
  assertNotSuspended(db, user.id);
  const text = String(body ?? '').trim();
  if (!text) throw badRequest('Write something first.');
  if (text.length > 1000) throw badRequest('Comments are limited to 1000 characters.');
  marketRowById(db, marketId);
  const info = db
    .prepare('INSERT INTO comments (market_id, user_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(marketId, user.id, text, nowIso());
  return listComments(db, marketId).find((c) => c.id === Number(info.lastInsertRowid));
}
