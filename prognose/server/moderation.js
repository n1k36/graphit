/**
 * Moderation.
 *
 * Anyone can open a market on any question and write a comment under it, which
 * is the whole liability of a user-generated prediction market. This module is
 * the intake queue and the set of actions a moderator can take.
 *
 * Two rules shape the design:
 *
 * 1. **Nothing is deleted outright.** Markets hold other people's money, so a
 *    bad one is hidden from listings and frozen for trading — an admin still
 *    has to settle or cancel it so positions resolve. Comments are soft
 *    deleted, leaving the thread readable.
 * 2. **Every action is recorded against the report** that prompted it, with
 *    who did it and when, so moderation is auditable rather than a series of
 *    silent disappearances.
 */
import { nowIso, transaction } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { notify } from './engagement.js';

export const REPORT_REASONS = {
  illegal: 'Illegal or promotes crime',
  harassment: 'Targets or harasses a private person',
  hateful: 'Hateful or abusive',
  sexual: 'Sexual content involving minors or non-consent',
  violence: 'Encourages violence or self-harm',
  unresolvable: 'Cannot be settled objectively',
  spam: 'Spam or a duplicate',
  other: 'Something else',
};

export const MODERATION_ACTIONS = {
  dismiss: 'No action needed',
  hide_market: 'Hide the market and freeze trading',
  unhide_market: 'Restore the market',
  delete_comment: 'Remove the comment',
  suspend_user: 'Suspend the author',
};

/* ------------------------------------------------------------------ *
 * Suspensions
 * ------------------------------------------------------------------ */

export function suspensionOf(db, userId) {
  const row = db.prepare('SELECT suspended_until, suspended_note FROM users WHERE id = ?').get(userId);
  if (!row?.suspended_until) return null;
  if (new Date(row.suspended_until).getTime() <= Date.now()) return null;
  return { until: row.suspended_until, note: row.suspended_note };
}

/** Throw if this account is currently suspended. Called before any write. */
export function assertNotSuspended(db, userId) {
  const suspension = suspensionOf(db, userId);
  if (suspension) {
    throw forbidden(
      `Your account is suspended until ${new Date(suspension.until).toLocaleDateString('en-US')}` +
        (suspension.note ? `: ${suspension.note}` : '.'),
    );
  }
}

export function suspendUser(db, moderator, userId, { days = 7, note = '' } = {}) {
  if (!moderator.isAdmin) throw forbidden('Admins only.');
  const target = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(Number(userId));
  if (!target) throw notFound('No such user.');
  if (target.is_admin) throw badRequest('Admins cannot be suspended from here.');

  const length = Number(days);
  if (!Number.isFinite(length) || length <= 0 || length > 3650) throw badRequest('Choose between 1 and 3650 days.');
  const until = new Date(Date.now() + length * 86400_000).toISOString();

  db.prepare('UPDATE users SET suspended_until = ?, suspended_note = ? WHERE id = ?').run(until, String(note).slice(0, 300), target.id);
  notify(db, target.id, {
    kind: 'moderation',
    title: 'Your account has been suspended',
    body: note || `You cannot trade or post until ${new Date(until).toLocaleDateString('en-US')}.`,
    href: '#/portfolio',
  });
  return { userId: target.id, until };
}

export function liftSuspension(db, moderator, userId) {
  if (!moderator.isAdmin) throw forbidden('Admins only.');
  db.prepare("UPDATE users SET suspended_until = NULL, suspended_note = '' WHERE id = ?").run(Number(userId));
  return { userId: Number(userId), until: null };
}

/* ------------------------------------------------------------------ *
 * Reports
 * ------------------------------------------------------------------ */

export function fileReport(db, user, { kind, targetId, reason, note = '' }) {
  if (!['market', 'comment'].includes(kind)) throw badRequest('Report a market or a comment.');
  if (!REPORT_REASONS[reason]) throw badRequest('Pick a reason from the list.');

  const id = Number(targetId);
  const exists =
    kind === 'market'
      ? db.prepare('SELECT 1 FROM markets WHERE id = ?').get(id)
      : db.prepare('SELECT 1 FROM comments WHERE id = ?').get(id);
  if (!exists) throw notFound('That has already been removed.');

  try {
    db.prepare(
      `INSERT INTO reports (kind, target_id, reporter_id, reason, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(kind, id, user.id, reason, String(note).slice(0, 500), nowIso());
  } catch (err) {
    // The unique constraint means a second report from the same person is a
    // no-op rather than an error — they have already been heard.
    if (String(err.message).includes('UNIQUE')) return { ok: true, alreadyReported: true };
    throw err;
  }
  return { ok: true };
}

/** Open reports, newest first, with enough context to judge without clicking. */
export function listReports(db, { status = 'open', limit = 100 } = {}) {
  const rows =
    status === 'all'
      ? db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit);

  return rows.map((r) => {
    const reporter = db.prepare('SELECT username FROM users WHERE id = ?').get(r.reporter_id);
    const target =
      r.kind === 'market'
        ? db
            .prepare('SELECT m.id, m.slug, m.question AS text, m.hidden, m.status, u.id AS author_id, u.username AS author FROM markets m JOIN users u ON u.id = m.creator_id WHERE m.id = ?')
            .get(r.target_id)
        : db
            .prepare('SELECT c.id, m.slug, c.body AS text, c.deleted, m.status, u.id AS author_id, u.username AS author FROM comments c JOIN users u ON u.id = c.user_id JOIN markets m ON m.id = c.market_id WHERE c.id = ?')
            .get(r.target_id);

    return {
      id: r.id,
      kind: r.kind,
      reason: r.reason,
      reasonLabel: REPORT_REASONS[r.reason] ?? r.reason,
      note: r.note,
      status: r.status,
      action: r.action,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      reporter: reporter?.username ?? 'unknown',
      /** How many distinct people flagged the same thing. */
      reportCount: db
        .prepare('SELECT COUNT(*) AS n FROM reports WHERE kind = ? AND target_id = ?')
        .get(r.kind, r.target_id).n,
      target: target
        ? {
            id: target.id,
            slug: target.slug,
            text: target.text,
            author: target.author,
            authorId: target.author_id,
            removed: !!(target.hidden || target.deleted),
            marketStatus: target.status,
          }
        : null,
    };
  });
}

export function reportCounts(db) {
  return {
    open: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n,
    total: db.prepare('SELECT COUNT(*) AS n FROM reports').get().n,
  };
}

/* ------------------------------------------------------------------ *
 * Acting on a report
 * ------------------------------------------------------------------ */

export function resolveReport(db, moderator, reportId, { action, note = '', days = 7 } = {}) {
  if (!moderator.isAdmin) throw forbidden('Admins only.');
  if (!MODERATION_ACTIONS[action]) throw badRequest('Pick a valid action.');

  return transaction(db, () => {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(reportId));
    if (!report) throw notFound('No such report.');
    if (report.status !== 'open') throw badRequest('That report has already been handled.');

    let affected = null;

    if (action === 'hide_market' || action === 'unhide_market') {
      if (report.kind !== 'market') throw badRequest('That action only applies to a market.');
      const hidden = action === 'hide_market' ? 1 : 0;
      db.prepare('UPDATE markets SET hidden = ? WHERE id = ?').run(hidden, report.target_id);
      const market = db.prepare('SELECT slug, question, creator_id FROM markets WHERE id = ?').get(report.target_id);
      affected = { market: market.slug, hidden: !!hidden };
      notify(db, market.creator_id, {
        kind: 'moderation',
        title: hidden ? 'Your market was hidden' : 'Your market was restored',
        body: hidden
          ? `"${market.question}" is no longer listed and cannot be traded. ${note || 'It breaks the content rules.'}`
          : `"${market.question}" is listed again.`,
        href: `#/market/${market.slug}`,
      });
    }

    if (action === 'delete_comment') {
      if (report.kind !== 'comment') throw badRequest('That action only applies to a comment.');
      db.prepare('UPDATE comments SET deleted = 1 WHERE id = ?').run(report.target_id);
      const comment = db.prepare('SELECT user_id FROM comments WHERE id = ?').get(report.target_id);
      affected = { comment: report.target_id };
      if (comment) {
        notify(db, comment.user_id, {
          kind: 'moderation',
          title: 'A comment of yours was removed',
          body: note || 'It broke the content rules.',
          href: '#/',
        });
      }
    }

    if (action === 'suspend_user') {
      const author =
        report.kind === 'market'
          ? db.prepare('SELECT creator_id AS id FROM markets WHERE id = ?').get(report.target_id)
          : db.prepare('SELECT user_id AS id FROM comments WHERE id = ?').get(report.target_id);
      if (!author) throw notFound('The author is already gone.');
      affected = suspendUser(db, moderator, author.id, { days, note });
    }

    db.prepare(
      "UPDATE reports SET status = ?, action = ?, resolved_by = ?, resolved_at = ? WHERE id = ?",
    ).run(action === 'dismiss' ? 'dismissed' : 'actioned', action, moderator.id, nowIso(), report.id);

    // One decision settles every report about the same thing.
    const swept = db
      .prepare(
        "UPDATE reports SET status = ?, action = ?, resolved_by = ?, resolved_at = ? WHERE kind = ? AND target_id = ? AND status = 'open'",
      )
      .run(action === 'dismiss' ? 'dismissed' : 'actioned', action, moderator.id, nowIso(), report.kind, report.target_id);

    return { id: report.id, action, affected, alsoResolved: swept.changes };
  });
}

/** Direct action from the market page, without waiting for someone to report it. */
export function setMarketHidden(db, moderator, marketId, hidden) {
  if (!moderator.isAdmin) throw forbidden('Admins only.');
  const market = db.prepare('SELECT id, slug, question, creator_id FROM markets WHERE id = ?').get(Number(marketId));
  if (!market) throw notFound('No such market.');
  db.prepare('UPDATE markets SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, market.id);
  notify(db, market.creator_id, {
    kind: 'moderation',
    title: hidden ? 'Your market was hidden' : 'Your market was restored',
    body: `"${market.question}"`,
    href: `#/market/${market.slug}`,
  });
  return { slug: market.slug, hidden: !!hidden };
}
