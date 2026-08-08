import { randomBytes } from 'node:crypto';
import { getSettings, nowIso, today, transaction } from './db.js';
import { badRequest } from './errors.js';
import { creditUser } from './ledger.js';

/* ------------------------------------------------------------------ *
 * Levels
 * ------------------------------------------------------------------ */

export const LEVELS = [
  { level: 1, name: 'Rookie', xp: 0 },
  { level: 2, name: 'Punter', xp: 250 },
  { level: 3, name: 'Sharp', xp: 1_000 },
  { level: 4, name: 'Forecaster', xp: 3_000 },
  { level: 5, name: 'Analyst', xp: 8_000 },
  { level: 6, name: 'Whale', xp: 20_000 },
  { level: 7, name: 'Oracle', xp: 50_000 },
  { level: 8, name: 'Legend', xp: 120_000 },
];

export function levelFor(xp) {
  let current = LEVELS[0];
  for (const tier of LEVELS) if (xp >= tier.xp) current = tier;
  const next = LEVELS.find((t) => t.xp > xp) ?? null;
  const span = next ? next.xp - current.xp : 1;
  return {
    ...current,
    xp,
    nextLevelXp: next?.xp ?? null,
    nextName: next?.name ?? null,
    progress: next ? Math.min(1, (xp - current.xp) / span) : 1,
  };
}

/** One XP per dollar of notional traded. */
export function addXp(db, userId, amount) {
  if (!(amount > 0)) return;
  db.prepare('UPDATE profiles SET xp = xp + ? WHERE user_id = ?').run(amount, userId);
}

/* ------------------------------------------------------------------ *
 * Profiles
 * ------------------------------------------------------------------ */

export function ensureProfile(db, userId) {
  const existing = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
  if (existing) return existing;
  db.prepare('INSERT INTO profiles (user_id, referral_code) VALUES (?, ?)').run(userId, newReferralCode(db));
  return db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
}

function newReferralCode(db) {
  for (let i = 0; i < 20; i++) {
    const code = randomBytes(4).toString('hex').toUpperCase();
    if (!db.prepare('SELECT 1 FROM profiles WHERE referral_code = ?').get(code)) return code;
  }
  return randomBytes(8).toString('hex').toUpperCase();
}

export function getProfile(db, userId) {
  const profile = ensureProfile(db, userId);
  return {
    xp: profile.xp,
    level: levelFor(profile.xp),
    wagered: profile.wagered,
    deposited: profile.deposited,
    withdrawn: profile.withdrawn,
    bonusGranted: profile.bonus_granted,
    streak: profile.streak,
    bestStreak: profile.best_streak,
    lastBonusDay: profile.last_bonus_day,
    referralCode: profile.referral_code,
    referredBy: profile.referred_by,
    wins: profile.wins,
    losses: profile.losses,
    depositLimit: profile.deposit_limit,
    excludedUntil: profile.excluded_until,
    bonusReady: profile.last_bonus_day !== today() && !isExcluded(profile),
  };
}

const isExcluded = (profile) =>
  !!profile?.excluded_until && new Date(profile.excluded_until).getTime() > Date.now();

/* ------------------------------------------------------------------ *
 * Daily bonus and streaks
 * ------------------------------------------------------------------ */

/** Yesterday's date string, for streak continuity. */
const yesterday = () => new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

export function claimDailyBonus(db, user) {
  return transaction(db, () => {
    const settings = getSettings(db);
    const profile = ensureProfile(db, user.id);
    if (isExcluded(profile)) throw badRequest('Your account is currently self-excluded.');
    const day = today();
    if (profile.last_bonus_day === day) throw badRequest('You have already claimed today. Come back tomorrow.');

    const streak = profile.last_bonus_day === yesterday() ? profile.streak + 1 : 1;
    const best = Math.max(streak, profile.best_streak);
    const amount = Math.min(settings.dailyBonusBase * streak, settings.dailyBonusMax);

    db.prepare('UPDATE profiles SET streak = ?, best_streak = ?, last_bonus_day = ? WHERE user_id = ?').run(
      streak,
      best,
      day,
      user.id,
    );
    creditUser(db, user.id, amount, { kind: 'daily_bonus', memo: `Day ${streak} streak bonus` }, { toBonus: true });
    addXp(db, user.id, amount);
    grant(db, user.id, streak >= 7 ? 'streak_7' : null);

    return { amount, streak, bestStreak: best, nextAt: `${day}T24:00:00` };
  });
}

/* ------------------------------------------------------------------ *
 * Referrals
 * ------------------------------------------------------------------ */

export function applyReferral(db, newUserId, code) {
  if (!code) return null;
  const referrer = db.prepare('SELECT user_id FROM profiles WHERE referral_code = ?').get(String(code).toUpperCase().trim());
  if (!referrer || referrer.user_id === newUserId) return null;
  const settings = getSettings(db);
  db.prepare('UPDATE profiles SET referred_by = ? WHERE user_id = ?').run(referrer.user_id, newUserId);
  creditUser(db, referrer.user_id, settings.referralBonus, { kind: 'referral', memo: 'Referral bonus' }, { toBonus: true });
  creditUser(db, newUserId, settings.referralBonus, { kind: 'referral', memo: 'Welcome referral bonus' }, { toBonus: true });
  notify(db, referrer.user_id, {
    kind: 'referral',
    title: 'Referral bonus',
    body: `Someone joined with your code. $${settings.referralBonus.toFixed(2)} added to your balance.`,
    href: '#/wallet',
    amount: settings.referralBonus,
  });
  grant(db, referrer.user_id, 'recruiter');
  return referrer.user_id;
}

export function referralStats(db, userId) {
  const profile = ensureProfile(db, userId);
  const invited = db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE referred_by = ?').get(userId).n;
  const earned = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE user_id = ? AND kind = 'referral' AND amount > 0")
    .get(userId).total;
  return { code: profile.referral_code, invited, earned: Math.round(earned * 100) / 100 };
}

/* ------------------------------------------------------------------ *
 * Achievements
 * ------------------------------------------------------------------ */

export const ACHIEVEMENTS = {
  first_trade: { icon: '🎯', title: 'First Blood', hint: 'Place your first trade' },
  first_win: { icon: '🏆', title: 'Called It', hint: 'Win a settled market' },
  market_maker: { icon: '🏗️', title: 'Market Maker', hint: 'Create a market' },
  streak_7: { icon: '🔥', title: 'Week Strong', hint: 'Claim seven days in a row' },
  volume_1k: { icon: '💸', title: 'Volume Dealer', hint: 'Trade $1,000 of notional' },
  volume_10k: { icon: '🐋', title: 'Whale', hint: 'Trade $10,000 of notional' },
  recruiter: { icon: '📣', title: 'Recruiter', hint: 'Bring a friend on board' },
  diversified: { icon: '🧩', title: 'Diversified', hint: 'Hold positions in five markets' },
};

/** Award an achievement once. Returns it if it was newly earned. */
export function grant(db, userId, key) {
  if (!key || !ACHIEVEMENTS[key]) return null;
  const existing = db.prepare('SELECT 1 FROM achievements WHERE user_id = ? AND key = ?').get(userId, key);
  if (existing) return null;
  db.prepare('INSERT INTO achievements (user_id, key, earned_at) VALUES (?, ?, ?)').run(userId, key, nowIso());
  const meta = ACHIEVEMENTS[key];
  notify(db, userId, { kind: 'achievement', title: `${meta.icon} ${meta.title}`, body: meta.hint, href: '#/portfolio' });
  return { key, ...meta };
}

export function listAchievements(db, userId) {
  const earned = new Map(
    db.prepare('SELECT key, earned_at FROM achievements WHERE user_id = ?').all(userId).map((r) => [r.key, r.earned_at]),
  );
  return Object.entries(ACHIEVEMENTS).map(([key, meta]) => ({
    key,
    ...meta,
    earnedAt: earned.get(key) ?? null,
    earned: earned.has(key),
  }));
}

/** Check the volume/diversity milestones after a trade. */
export function checkTradeMilestones(db, userId) {
  const profile = ensureProfile(db, userId);
  const fresh = [];
  fresh.push(grant(db, userId, 'first_trade'));
  if (profile.wagered >= 1000) fresh.push(grant(db, userId, 'volume_1k'));
  if (profile.wagered >= 10_000) fresh.push(grant(db, userId, 'volume_10k'));
  const markets = db.prepare('SELECT COUNT(DISTINCT market_id) AS n FROM positions WHERE user_id = ?').get(userId).n;
  if (markets >= 5) fresh.push(grant(db, userId, 'diversified'));
  return fresh.filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

export function notify(db, userId, { kind, title, body = '', href = '', amount = null }) {
  db.prepare(
    'INSERT INTO notifications (user_id, kind, title, body, href, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(userId, kind, title, body, href, amount, nowIso());
}

export function listNotifications(db, userId, limit = 30) {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
  return {
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(userId).n,
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      href: r.href,
      amount: r.amount,
      read: !!r.read,
      createdAt: r.created_at,
    })),
  };
}

export function markNotificationsRead(db, userId) {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Trending and the live ticker
 * ------------------------------------------------------------------ */

/** 24-hour volume per market, used for the 🔥 badge and the hot sort. */
export function trendingVolume(db) {
  const since = new Date(Date.now() - 86400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT market_id, SUM(ABS(cost)) AS volume, COUNT(*) AS trades FROM trades
       WHERE created_at >= ? AND side IN ('buy','sell') GROUP BY market_id`,
    )
    .all(since);
  return new Map(rows.map((r) => [r.market_id, { volume: r.volume, trades: r.trades }]));
}

/** Global trade feed for the ticker along the top of the app. */
export function liveActivity(db, limit = 25) {
  return db
    .prepare(
      `SELECT t.id, t.side, t.outcome, t.shares, t.cost, t.avg_price, t.created_at,
              u.username, u.avatar, m.slug, m.question, m.emoji, m.outcomes
       FROM trades t
       JOIN users u ON u.id = t.user_id
       JOIN markets m ON m.id = t.market_id
       WHERE t.side IN ('buy','sell')
       ORDER BY t.id DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({
      id: r.id,
      side: r.side,
      shares: r.shares,
      cost: Math.abs(r.cost),
      price: r.avg_price,
      outcomeLabel: JSON.parse(r.outcomes)[r.outcome],
      user: { username: r.username, avatar: r.avatar },
      market: { slug: r.slug, question: r.question, emoji: r.emoji },
      createdAt: r.created_at,
    }));
}

/** Headline numbers for the landing hero. */
export function platformStats(db) {
  const since = new Date(Date.now() - 86400_000).toISOString();
  return {
    totalVolume: db.prepare('SELECT COALESCE(SUM(volume), 0) AS v FROM markets').get().v,
    volume24h: db
      .prepare("SELECT COALESCE(SUM(ABS(cost)), 0) AS v FROM trades WHERE created_at >= ? AND side IN ('buy','sell')")
      .get(since).v,
    openMarkets: db.prepare("SELECT COUNT(*) AS n FROM markets WHERE status = 'open'").get().n,
    traders: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    trades24h: db.prepare("SELECT COUNT(*) AS n FROM trades WHERE created_at >= ? AND side IN ('buy','sell')").get(since).n,
  };
}

/* ------------------------------------------------------------------ *
 * Responsible play
 * ------------------------------------------------------------------ */

export function setLimits(db, userId, { depositLimit, excludeDays }) {
  ensureProfile(db, userId);
  if (depositLimit !== undefined) {
    const value = depositLimit === null || depositLimit === '' ? null : Number(depositLimit);
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw badRequest('Give a valid deposit limit.');
    db.prepare('UPDATE profiles SET deposit_limit = ? WHERE user_id = ?').run(value, userId);
  }
  if (excludeDays) {
    const days = Number(excludeDays);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) throw badRequest('Choose between 1 and 3650 days.');
    const until = new Date(Date.now() + days * 86400_000).toISOString();
    db.prepare('UPDATE profiles SET excluded_until = ? WHERE user_id = ?').run(until, userId);
  }
  return getProfile(db, userId);
}

export function assertNotExcluded(db, userId) {
  const profile = db.prepare('SELECT excluded_until FROM profiles WHERE user_id = ?').get(userId);
  if (isExcluded(profile)) {
    throw badRequest(`Your account is self-excluded until ${new Date(profile.excluded_until).toLocaleDateString('en-US')}.`);
  }
}
