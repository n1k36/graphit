import { CONFIG, nowIso, transaction } from './db.js';
import { HttpError, badRequest, forbidden, notFound } from './errors.js';
import * as lmsr from './lmsr.js';
import { getUser } from './auth.js';

export const CATEGORIES = ['Politics', 'Crypto', 'Sports', 'Tech', 'Economics', 'Culture', 'Science', 'Other'];

/** Round money to 4dp and shares to 6dp so stored floats stay tidy. */
const money = (x) => Math.round(x * 1e4) / 1e4;
const shares = (x) => Math.round(x * 1e6) / 1e6;
const DUST = 1e-6;

/* ------------------------------------------------------------------ *
 * Reading markets
 * ------------------------------------------------------------------ */

export function serializeMarket(db, row, { includeTraders = false } = {}) {
  const q = JSON.parse(row.q);
  const labels = JSON.parse(row.outcomes);
  const priceVector = lmsr.prices(q, row.b);
  const closed = row.status === 'open' && new Date(row.closes_at).getTime() <= Date.now();
  const creator = db.prepare('SELECT username, avatar FROM users WHERE id = ?').get(row.creator_id);

  const market = {
    id: row.id,
    slug: row.slug,
    question: row.question,
    description: row.description,
    category: row.category,
    emoji: row.emoji,
    outcomes: labels.map((label, i) => ({ index: i, label, price: priceVector[i], shares: q[i] })),
    q,
    b: row.b,
    subsidy: row.subsidy,
    volume: row.volume,
    tradeCount: row.trade_count,
    liquidity: row.b,
    feeRate: CONFIG.feeRate,
    creator: creator ? { id: row.creator_id, username: creator.username, avatar: creator.avatar } : null,
    createdAt: row.created_at,
    closesAt: row.closes_at,
    status: row.status,
    closed,
    tradable: row.status === 'open' && !closed,
    resolvedOutcome: row.resolved_outcome,
    resolvedAt: row.resolved_at,
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

  const sql = `SELECT * FROM markets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`;
  const rows = db.prepare(sql).all(...params, Math.min(Number(limit) || 200, 500));
  const sparkStmt = db.prepare(
    "SELECT prices FROM trades WHERE market_id = ? AND side IN ('buy','sell') ORDER BY id DESC LIMIT 40",
  );
  return rows.map((row) => {
    const market = serializeMarket(db, row);
    const n = market.outcomes.length;
    const recent = sparkStmt.all(row.id).reverse();
    market.spark = [1 / n, ...recent.map((t) => JSON.parse(t.prices)[0])];
    return market;
  });
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
  const emoji = String(input.emoji ?? '').trim().slice(0, 8);

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

  const subsidy = Number(input.subsidy ?? CONFIG.defaultSubsidy);
  if (!Number.isFinite(subsidy) || subsidy < CONFIG.minSubsidy || subsidy > CONFIG.maxSubsidy) {
    throw badRequest(`The liquidity subsidy must be between $${CONFIG.minSubsidy} and $${CONFIG.maxSubsidy}.`);
  }

  return transaction(db, () => {
    const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id);
    if (!fresh || fresh.balance < subsidy) {
      throw badRequest(`You need $${subsidy.toFixed(2)} to subsidise this market; your balance is $${(fresh?.balance ?? 0).toFixed(2)}.`);
    }
    const b = lmsr.liquidityForSubsidy(subsidy, outcomes.length);
    const slug = uniqueSlug(db, slugify(question));
    const info = db
      .prepare(
        `INSERT INTO markets (slug, question, description, category, emoji, outcomes, q, b, subsidy,
                              creator_id, created_at, closes_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        slug,
        question,
        description,
        category,
        emoji,
        JSON.stringify(outcomes),
        JSON.stringify(new Array(outcomes.length).fill(0)),
        b,
        money(subsidy),
        user.id,
        nowIso(),
        closesAt.toISOString(),
      );
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(money(subsidy), user.id);
    return serializeMarket(db, marketRowById(db, Number(info.lastInsertRowid)));
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
      size = lmsr.sharesForBudget(q, row.b, outcome, budget / (1 + CONFIG.feeRate));
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
  const quote = lmsr.quote(q, row.b, outcome, side, size, CONFIG.feeRate);
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
  return transaction(db, () => {
    const row = marketRowById(db, marketId);
    if (row.status !== 'open') throw badRequest('This market has already been settled.');
    if (new Date(row.closes_at).getTime() <= Date.now()) throw badRequest('This market is closed for trading.');

    const { outcome, side, size, q, labels } = parseTradeInput(db, row, user.id, input);
    if (size <= 0) throw badRequest('That trade rounds to zero shares.');

    const quote = lmsr.quote(q, row.b, outcome, side, size, CONFIG.feeRate);
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

    const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id);
    if (side === 'buy' && fresh.balance < cashDelta - 1e-9) {
      throw badRequest(`Not enough balance: this costs $${cashDelta.toFixed(2)} and you have $${fresh.balance.toFixed(2)}.`);
    }

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

    db.prepare('UPDATE users SET balance = balance - ?, realized_pnl = realized_pnl + ? WHERE id = ?').run(
      cashDelta,
      realized,
      user.id,
    );
    // Trading fees go to whoever created the market.
    if (fee > 0) db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(fee, row.creator_id);

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

    return {
      market: serializeMarket(db, marketRowById(db, row.id)),
      user: getUser(db, user.id),
      fill: {
        side,
        outcome,
        outcomeLabel: labels[outcome],
        shares: shares(size),
        cost: Math.abs(cashDelta),
        fee,
        avgPrice,
        realized,
      },
      position: { shares: newShares, costBasis: newBasis },
    };
  });
}

/* ------------------------------------------------------------------ *
 * Settlement
 * ------------------------------------------------------------------ */

/**
 * Settle a market. `outcome` is the winning index, or null to cancel the
 * market and refund every holder at the last traded price.
 */
export function resolveMarket(db, user, marketId, outcome) {
  return transaction(db, () => {
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
    for (const pos of positions) {
      const payout = money(pos.shares * finalPrices[pos.outcome]);
      const realized = money(payout - pos.cost_basis);
      totalPayout += payout;
      db.prepare('UPDATE users SET balance = balance + ?, realized_pnl = realized_pnl + ? WHERE id = ?').run(
        payout,
        realized,
        pos.user_id,
      );
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

    // The creator gets their subsidy back, plus whatever the AMM took in and
    // did not have to pay out (this can be a loss, bounded by the subsidy).
    const creatorReturn = money(row.subsidy + row.collected - totalPayout);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(creatorReturn, row.creator_id);

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
    };
  });
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
      `SELECT p.*, m.slug, m.question, m.emoji, m.outcomes, m.q, m.b, m.status, m.closes_at, m.resolved_outcome
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
      emoji: r.emoji,
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
  return {
    user,
    positions,
    history,
    summary: {
      balance: money(user.balance),
      invested: money(invested),
      positionValue: money(value),
      creatorEquity: equity,
      netWorth: money(user.balance + value + equity),
      unrealized: money(value - invested),
      realized: money(user.realizedPnl),
      profit: money(user.balance + value + equity - CONFIG.startingBalance),
    },
  };
}

export function leaderboard(db, limit = 50) {
  const markets = new Map(
    db.prepare("SELECT id, q, b FROM markets").all().map((m) => [m.id, lmsr.prices(JSON.parse(m.q), m.b)]),
  );
  const users = db.prepare('SELECT * FROM users ORDER BY id').all();
  const positions = db.prepare('SELECT * FROM positions').all();
  const valueByUser = new Map();
  for (const p of positions) {
    const price = markets.get(p.market_id)?.[p.outcome] ?? 0;
    valueByUser.set(p.user_id, (valueByUser.get(p.user_id) ?? 0) + p.shares * price);
  }
  return users
    .map((u) => {
      const value = valueByUser.get(u.id) ?? 0;
      const equity = creatorEquity(db, u.id);
      return {
        id: u.id,
        username: u.username,
        avatar: u.avatar,
        balance: money(u.balance),
        positionValue: money(value),
        creatorEquity: equity,
        netWorth: money(u.balance + value + equity),
        profit: money(u.balance + value + equity - CONFIG.startingBalance),
        realized: money(u.realized_pnl),
        marketsCreated: db.prepare('SELECT COUNT(*) AS n FROM markets WHERE creator_id = ?').get(u.id).n,
        trades: db.prepare('SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND side != ?').get(u.id, 'settle').n,
      };
    })
    .sort((a, b) => b.netWorth - a.netWorth)
    .slice(0, limit)
    .map((u, i) => ({ ...u, rank: i + 1 }));
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
      body: c.body,
      createdAt: c.created_at,
      user: { id: c.user_id, username: c.username, avatar: c.avatar },
    }));
}

export function addComment(db, user, marketId, body) {
  const text = String(body ?? '').trim();
  if (!text) throw badRequest('Write something first.');
  if (text.length > 1000) throw badRequest('Comments are limited to 1000 characters.');
  marketRowById(db, marketId);
  const info = db
    .prepare('INSERT INTO comments (market_id, user_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(marketId, user.id, text, nowIso());
  return listComments(db, marketId).find((c) => c.id === Number(info.lastInsertRowid));
}
