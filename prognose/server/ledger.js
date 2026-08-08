import { nowIso } from './db.js';
import { badRequest } from './errors.js';

/**
 * Double-entry-style money movement. Nothing in this app changes a balance
 * without writing a ledger row, so the treasury, a user's statement and the
 * revenue dashboard are all just queries over this one table.
 */

const round = (x) => Math.round(x * 1e4) / 1e4;

function write(db, { userId = null, account, kind, amount, balanceAfter = null, marketId = null, ref = null, memo = '' }) {
  db.prepare(
    `INSERT INTO ledger (user_id, account, kind, amount, balance_after, market_id, ref, memo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, account, kind, round(amount), balanceAfter === null ? null : round(balanceAfter), marketId, ref, memo, nowIso());
}

export function balances(db, userId) {
  const row = db.prepare('SELECT balance, bonus_balance FROM users WHERE id = ?').get(userId);
  if (!row) throw badRequest('No such account.');
  return { cash: row.balance, bonus: row.bonus_balance, total: round(row.balance + row.bonus_balance) };
}

/**
 * Take money from a user. Bonus credits are spent before real cash, which is
 * how every promo balance in the industry works.
 */
export function debitUser(db, userId, amount, entry) {
  const value = round(amount);
  if (value <= 0) return { fromBonus: 0, fromCash: 0 };
  const { cash, bonus, total } = balances(db, userId);
  if (total < value - 1e-9) throw badRequest('Not enough balance.');

  const fromBonus = round(Math.min(bonus, value));
  const fromCash = round(value - fromBonus);
  db.prepare('UPDATE users SET bonus_balance = bonus_balance - ?, balance = balance - ? WHERE id = ?').run(
    fromBonus,
    fromCash,
    userId,
  );
  if (fromBonus > 0) {
    write(db, { ...entry, userId, account: 'bonus', amount: -fromBonus, balanceAfter: round(bonus - fromBonus) });
  }
  if (fromCash > 0) {
    write(db, { ...entry, userId, account: 'cash', amount: -fromCash, balanceAfter: round(cash - fromCash) });
  }
  return { fromBonus, fromCash };
}

/** Give money to a user. Winnings and deposits land in withdrawable cash. */
export function creditUser(db, userId, amount, entry, { toBonus = false } = {}) {
  const value = round(amount);
  if (value <= 0) return;
  const { cash, bonus } = balances(db, userId);
  if (toBonus) {
    db.prepare('UPDATE users SET bonus_balance = bonus_balance + ? WHERE id = ?').run(value, userId);
    db.prepare('UPDATE profiles SET bonus_granted = bonus_granted + ? WHERE user_id = ?').run(value, userId);
    write(db, { ...entry, userId, account: 'bonus', amount: value, balanceAfter: round(bonus + value) });
  } else {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(value, userId);
    write(db, { ...entry, userId, account: 'cash', amount: value, balanceAfter: round(cash + value) });
  }
}

/** Book revenue (or a cost) to the platform treasury. */
export function platformEntry(db, amount, entry) {
  if (Math.abs(amount) < 1e-9) return;
  write(db, { ...entry, userId: entry.userId ?? null, account: 'platform', amount });
}

export function treasuryBalance(db) {
  return round(db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE account = 'platform'").get().total);
}

/** Revenue broken down by source, optionally since an ISO timestamp. */
export function revenueByKind(db, since = null) {
  const rows = since
    ? db
        .prepare("SELECT kind, SUM(amount) AS total, COUNT(*) AS n FROM ledger WHERE account = 'platform' AND created_at >= ? GROUP BY kind")
        .all(since)
    : db.prepare("SELECT kind, SUM(amount) AS total, COUNT(*) AS n FROM ledger WHERE account = 'platform' GROUP BY kind").all();
  return rows.map((r) => ({ kind: r.kind, total: round(r.total), count: r.n })).sort((a, b) => b.total - a.total);
}

/** Daily revenue series for the admin chart. */
export function revenueByDay(db, days = 30) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, SUM(amount) AS total
       FROM ledger WHERE account = 'platform' AND created_at >= ?
       GROUP BY day ORDER BY day`,
    )
    .all(since);
  return rows.map((r) => ({ day: r.day, total: round(r.total) }));
}

export function statement(db, userId, limit = 100) {
  return db
    .prepare(
      `SELECT l.*, m.question, m.slug FROM ledger l
       LEFT JOIN markets m ON m.id = l.market_id
       WHERE l.user_id = ? AND l.account IN ('cash','bonus')
       ORDER BY l.id DESC LIMIT ?`,
    )
    .all(userId, limit)
    .map((r) => ({
      id: r.id,
      account: r.account,
      kind: r.kind,
      amount: r.amount,
      balanceAfter: r.balance_after,
      memo: r.memo,
      marketQuestion: r.question,
      marketSlug: r.slug,
      createdAt: r.created_at,
    }));
}
