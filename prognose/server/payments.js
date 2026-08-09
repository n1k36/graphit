import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { getSettings, nowIso, transaction } from './db.js';
import { badRequest, forbidden, notFound, HttpError } from './errors.js';
import { creditUser, debitUser, platformEntry, balances } from './ledger.js';
import { notify } from './engagement.js';
import { wiseProvider, wiseConfig, fetchStatement, matchDeposits } from './providers/wise.js';
import { stripeProvider } from './providers/stripe.js';

/* ------------------------------------------------------------------ *
 * Provider adapters
 *
 * A provider turns "this user wants to add $50" into a checkout the user
 * completes elsewhere, and later tells us it succeeded. Swapping the mock
 * for Stripe means implementing these three methods against their API —
 * nothing outside this file needs to change.
 * ------------------------------------------------------------------ */

const MOCK_SECRET = process.env.PAYMENTS_WEBHOOK_SECRET || 'dev-webhook-secret';

const mockProvider = {
  name: 'mock',
  /** Sandbox checkout: a page in this app that posts the webhook back to us. */
  async createCheckout({ reference, amount }) {
    return { checkoutUrl: `/checkout?ref=${encodeURIComponent(reference)}&amount=${amount}`, providerRef: `mock_${reference}` };
  },
  /** Verify a webhook signature. */
  verify(rawBody, signature) {
    const expected = createHmac('sha256', MOCK_SECRET).update(rawBody).digest('hex');
    const a = Buffer.from(String(signature ?? ''), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  },
  /** Translate a webhook body into a deposit outcome. */
  parseWebhook(body) {
    if (!body?.reference) return null;
    return { reference: body.reference, failed: body.status === 'failed' };
  },
  /** Send money out. The mock marks it paid immediately. */
  async payout({ amount, destination }) {
    return { ok: true, providerRef: `mock_payout_${Date.now()}_${Math.round(amount)}`, destination };
  },
};

const providers = { mock: mockProvider, stripe: stripeProvider, wise: wiseProvider };

/** Provider handling deposits. */
export function activeProvider() {
  return providers[process.env.PAYMENTS_PROVIDER || 'mock'] ?? mockProvider;
}

/**
 * Provider handling payouts, which is often a different one. Stripe is the
 * best way to take card money in and cannot send it back out without Connect;
 * Wise is the reverse. Running Stripe in and Wise out is a normal setup, so
 * PAYOUT_PROVIDER can differ from PAYMENTS_PROVIDER.
 */
export function activePayoutProvider() {
  return providers[process.env.PAYOUT_PROVIDER || process.env.PAYMENTS_PROVIDER || 'mock'] ?? mockProvider;
}

export const signWebhook = (rawBody) => createHmac('sha256', MOCK_SECRET).update(rawBody).digest('hex');

/* ------------------------------------------------------------------ *
 * Deposits
 * ------------------------------------------------------------------ */

function assertPlayable(db, userId) {
  const profile = db.prepare('SELECT excluded_until FROM profiles WHERE user_id = ?').get(userId);
  if (profile?.excluded_until && new Date(profile.excluded_until).getTime() > Date.now()) {
    throw forbidden(`Your account is self-excluded until ${new Date(profile.excluded_until).toLocaleDateString('en-US')}.`);
  }
}

function depositedInLast24h(db, userId) {
  const since = new Date(Date.now() - 86400_000).toISOString();
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM payment_intents
         WHERE user_id = ? AND status = 'succeeded' AND completed_at >= ?`,
      )
      .get(userId, since).total ?? 0
  );
}

export async function createDeposit(db, user, amount) {
  const settings = getSettings(db);
  const value = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(value) || value <= 0) throw badRequest('Enter an amount to deposit.');
  if (value < settings.minDeposit) throw badRequest(`The minimum deposit is $${settings.minDeposit}.`);
  if (value > settings.maxDeposit) throw badRequest(`The maximum single deposit is $${settings.maxDeposit}.`);
  assertPlayable(db, user.id);

  const profile = db.prepare('SELECT deposit_limit FROM profiles WHERE user_id = ?').get(user.id);
  const cap = profile?.deposit_limit ?? settings.dailyDepositLimit;
  const already = depositedInLast24h(db, user.id);
  if (already + value > cap) {
    throw badRequest(`That would pass your 24-hour deposit limit of $${cap.toFixed(2)} (you have added $${already.toFixed(2)}).`);
  }

  const provider = activeProvider();
  const reference = `dep_${randomBytes(12).toString('hex')}`;
  const { checkoutUrl, providerRef } = await provider.createCheckout({ reference, amount: value, user });

  db.prepare(
    `INSERT INTO payment_intents (reference, user_id, amount, provider, status, checkout_url, provider_ref, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(reference, user.id, value, provider.name, checkoutUrl, providerRef, nowIso());

  return { reference, amount: value, provider: provider.name, checkoutUrl };
}

/**
 * Credit a completed deposit. Idempotent by payment reference: a webhook
 * replayed ten times still credits the account exactly once.
 */
export function settleDeposit(db, reference, { failed = false, receivedAmount = null } = {}) {
  return transaction(db, () => {
    const intent = db.prepare('SELECT * FROM payment_intents WHERE reference = ?').get(String(reference ?? ''));
    if (!intent) throw notFound('Unknown payment reference.');
    if (intent.status !== 'pending') return { intent, alreadyProcessed: true };

    if (failed) {
      db.prepare("UPDATE payment_intents SET status = 'failed', completed_at = ? WHERE id = ?").run(nowIso(), intent.id);
      return { intent, failed: true };
    }

    // With a bank transfer the payer types the amount, so what arrives is not
    // always what was asked for. Credit what actually landed.
    const credited =
      Number.isFinite(receivedAmount) && receivedAmount > 0 ? Math.round(receivedAmount * 100) / 100 : intent.amount;
    db.prepare("UPDATE payment_intents SET status = 'succeeded', amount = ?, completed_at = ? WHERE id = ?").run(
      credited,
      nowIso(),
      intent.id,
    );
    creditUser(db, intent.user_id, credited, {
      kind: 'deposit',
      ref: intent.reference,
      memo: `Deposit via ${intent.provider}`,
    });
    db.prepare('UPDATE profiles SET deposited = deposited + ? WHERE user_id = ?').run(credited, intent.user_id);
    notify(db, intent.user_id, {
      kind: 'deposit',
      title: 'Deposit confirmed',
      body: `$${credited.toFixed(2)} is ready to trade.`,
      href: '#/wallet',
      amount: credited,
    });
    return { intent, credited };
  });
}

/**
 * Bank-transfer reconciliation: ask the provider for its recent statement and
 * settle any pending intent whose reference appears in it.
 *
 * Safe to run repeatedly and on a timer — settleDeposit is idempotent, so an
 * already-booked credit is skipped. This is the real safety net: a missed
 * webhook must never mean a customer's money disappears.
 */
export async function reconcileDeposits(db, { days = 7, fetchImpl = fetch } = {}) {
  if (activeProvider().name !== 'wise') return { skipped: 'reconciliation only applies to bank-transfer providers' };
  const pending = db
    .prepare("SELECT reference, amount, user_id FROM payment_intents WHERE status = 'pending' AND provider = 'wise'")
    .all();
  if (!pending.length) return { pending: 0, scanned: 0, settled: [] };

  const transactions = await fetchStatement(wiseConfig(), { days, fetchImpl });
  const settled = [];
  for (const match of matchDeposits(pending, transactions)) {
    const result = settleDeposit(db, match.reference, { receivedAmount: match.received });
    if (!result.alreadyProcessed) settled.push({ reference: match.reference, credited: result.credited });
  }
  return { pending: pending.length, scanned: transactions.length, settled };
}

/** Bank details a payer needs, for the in-app transfer instructions page. */
export function depositInstructions() {
  if (activeProvider().name !== 'wise') return null;
  const { account, currency } = wiseConfig();
  return { ...account, currency };
}

/* ------------------------------------------------------------------ *
 * Withdrawals
 * ------------------------------------------------------------------ */

/** How much of a user's cash is actually withdrawable right now. */
export function withdrawableAmount(db, userId) {
  const settings = getSettings(db);
  const { cash } = balances(db, userId);
  const profile = db.prepare('SELECT wagered, bonus_granted FROM profiles WHERE user_id = ?').get(userId);
  const required = (profile?.bonus_granted ?? 0) * settings.wageringMultiplier;
  const wagered = profile?.wagered ?? 0;
  const remaining = Math.max(0, required - wagered);
  return {
    cash,
    withdrawable: remaining > 0 ? 0 : cash,
    wagered,
    wageringRequired: required,
    wageringRemaining: Math.round(remaining * 100) / 100,
  };
}

export function requestWithdrawal(db, user, amount, destination) {
  return transaction(db, () => {
    const settings = getSettings(db);
    const value = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(value) || value <= 0) throw badRequest('Enter an amount to withdraw.');
    if (value < settings.minWithdrawal) throw badRequest(`The minimum withdrawal is $${settings.minWithdrawal}.`);

    const status = withdrawableAmount(db, user.id);
    if (status.wageringRemaining > 0) {
      throw badRequest(
        `Bonus funds need $${status.wageringRemaining.toFixed(2)} more in trading volume before cash can be withdrawn.`,
      );
    }
    if (value > status.withdrawable + 1e-9) {
      throw badRequest(`You can withdraw up to $${status.withdrawable.toFixed(2)}.`);
    }
    const target = String(destination ?? '').trim().slice(0, 200);
    if (!target) throw badRequest('Tell us where to send it.');

    const fee = Math.round((value * settings.withdrawalFeeRate + settings.withdrawalFeeFlat) * 100) / 100;
    const net = Math.round((value - fee) * 100) / 100;
    if (net <= 0) throw badRequest('That amount does not cover the withdrawal fee.');

    // Debit immediately so the money cannot be spent twice while pending.
    debitUser(db, user.id, value, { kind: 'withdrawal_hold', memo: `Withdrawal to ${target}` });
    if (fee > 0) platformEntry(db, fee, { kind: 'withdrawal_fee', userId: user.id, memo: 'Withdrawal fee' });

    const info = db
      .prepare(
        `INSERT INTO withdrawals (user_id, amount, fee, net, destination, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(user.id, value, fee, net, target, nowIso());
    return { id: Number(info.lastInsertRowid), amount: value, fee, net, status: 'pending' };
  });
}

export async function decideWithdrawal(db, admin, id, approve, note = '') {
  if (!admin.isAdmin) throw forbidden('Only an admin can settle withdrawals.');
  const row = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(Number(id));
  if (!row) throw notFound('No such withdrawal.');
  if (row.status !== 'pending') throw badRequest('That withdrawal has already been settled.');

  if (approve) {
    const result = await activePayoutProvider().payout({
      amount: row.net,
      destination: parseDestination(db, row),
    });
    if (!result?.ok) throw new HttpError(502, 'The payment provider refused the payout.');
  }

  return transaction(db, () => {
    if (approve) {
      db.prepare("UPDATE withdrawals SET status = 'paid', settled_at = ?, note = ? WHERE id = ?").run(nowIso(), note, row.id);
      db.prepare('UPDATE profiles SET withdrawn = withdrawn + ? WHERE user_id = ?').run(row.net, row.user_id);
      notify(db, row.user_id, {
        kind: 'withdrawal',
        title: 'Withdrawal sent',
        body: `$${row.net.toFixed(2)} is on its way to ${row.destination}.`,
        href: '#/wallet',
        amount: row.net,
      });
    } else {
      // Rejected: hand the money back, including any fee we booked.
      creditUser(db, row.user_id, row.amount, { kind: 'withdrawal_refund', memo: 'Withdrawal rejected' });
      if (row.fee > 0) platformEntry(db, -row.fee, { kind: 'withdrawal_fee', userId: row.user_id, memo: 'Fee refunded' });
      db.prepare("UPDATE withdrawals SET status = 'rejected', settled_at = ?, note = ? WHERE id = ?").run(nowIso(), note, row.id);
      notify(db, row.user_id, {
        kind: 'withdrawal',
        title: 'Withdrawal declined',
        body: note || 'Your funds have been returned to your balance.',
        href: '#/wallet',
        amount: row.amount,
      });
    }
    return { id: row.id, status: approve ? 'paid' : 'rejected' };
  });
}

/**
 * Turn the free-text payout destination into the fields a bank rail needs.
 * People type things like "Max Mustermann, DE89 3704 0044 0532 0130 00".
 */
export function parseDestination(db, row) {
  const raw = String(row.destination ?? '');
  const compact = raw.replace(/\s+/g, '');
  const iban = /([A-Z]{2}[0-9]{2}[A-Z0-9]{10,30})/i.exec(compact)?.[1]?.toUpperCase() ?? null;
  const name = raw.replace(/[A-Z]{2}[0-9]{2}[A-Z0-9 ]{10,40}/i, '').replace(/[,;]/g, ' ').trim();
  const username = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id)?.username ?? 'Customer';
  return {
    raw,
    iban,
    accountHolderName: name || username,
    reference: `Payout ${row.id}`,
    // Wise deduplicates on this, so a retried approval cannot pay out twice.
    idempotencyKey: `withdrawal-${row.id}`,
  };
}

export function listWithdrawals(db, { status = 'pending', limit = 100 } = {}) {
  const rows =
    status === 'all'
      ? db.prepare('SELECT w.*, u.username FROM withdrawals w JOIN users u ON u.id = w.user_id ORDER BY w.id DESC LIMIT ?').all(limit)
      : db
          .prepare('SELECT w.*, u.username FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = ? ORDER BY w.id DESC LIMIT ?')
          .all(status, limit);
  return rows.map((r) => ({
    id: r.id,
    user: { id: r.user_id, username: r.username },
    amount: r.amount,
    fee: r.fee,
    net: r.net,
    destination: r.destination,
    status: r.status,
    note: r.note,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  }));
}

export function userPayments(db, userId, limit = 50) {
  return {
    deposits: db
      .prepare('SELECT reference, amount, provider, status, created_at, completed_at FROM payment_intents WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, limit)
      .map((r) => ({
        reference: r.reference,
        amount: r.amount,
        provider: r.provider,
        status: r.status,
        createdAt: r.created_at,
        completedAt: r.completed_at,
      })),
    withdrawals: db
      .prepare('SELECT id, amount, fee, net, destination, status, created_at, settled_at FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, limit)
      .map((r) => ({
        id: r.id,
        amount: r.amount,
        fee: r.fee,
        net: r.net,
        destination: r.destination,
        status: r.status,
        createdAt: r.created_at,
        settledAt: r.settled_at,
      })),
  };
}
