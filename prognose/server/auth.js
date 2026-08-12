import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { CONFIG, getSettings, nowIso } from './db.js';
import { HttpError } from './errors.js';
import { creditUser } from './ledger.js';
import { applyReferral, ensureProfile, getProfile, levelFor } from './engagement.js';

const KEY_LEN = 64;
const AVATAR_COLORS = ['#6ea8fe', '#3fb950', '#f5a524', '#b98cf5', '#e8739f', '#3ec9c0', '#c9c3b6', '#f0523f'];

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, KEY_LEN).toString('hex') };
}

export function verifyPassword(password, salt, expected) {
  const actual = scryptSync(password, salt, KEY_LEN);
  const target = Buffer.from(expected, 'hex');
  return target.length === actual.length && timingSafeEqual(actual, target);
}

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3-20 characters: letters, numbers or underscore.');
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    throw new HttpError(400, 'Password must be at least 6 characters.');
  }
}

export function createUser(db, username, password, { isAdmin = false, referralCode = null } = {}) {
  validateCredentials(username, password);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw new HttpError(409, 'That username is already taken.');
  const { salt, hash } = hashPassword(password);
  const avatar = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, salt, balance, bonus_balance, is_admin, avatar, created_at)
       VALUES (?, ?, ?, 0, 0, ?, ?, ?)`,
    )
    .run(username, hash, salt, isAdmin ? 1 : 0, avatar, nowIso());
  const id = Number(info.lastInsertRowid);
  ensureProfile(db, id);

  // The welcome balance is promo credit: playable immediately, withdrawable
  // only once it has been turned over (see payments.withdrawableAmount).
  const welcome = getSettings(db).welcomeBonus;
  if (welcome > 0) {
    creditUser(db, id, welcome, { kind: 'welcome_bonus', memo: 'Welcome bonus' }, { toBonus: true });
  }
  if (referralCode) applyReferral(db, id, referralCode);
  return getUser(db, id);
}

export function login(db, username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? ''));
  if (!row || !verifyPassword(String(password ?? ''), row.salt, row.password_hash)) {
    throw new HttpError(401, 'Wrong username or password.');
  }
  return getUser(db, row.id);
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, nowIso());
  return token;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function userForToken(db, token) {
  if (!token) return null;
  const cutoff = new Date(Date.now() - CONFIG.sessionDays * 86400_000).toISOString();
  const row = db
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.created_at > ?')
    .get(token, cutoff);
  return row ? publicUser(row, db) : null;
}

/** Delete sessions past their lifetime. Cheap; run on boot and on a timer. */
export function pruneSessions(db) {
  const cutoff = new Date(Date.now() - CONFIG.sessionDays * 86400_000).toISOString();
  return db.prepare('DELETE FROM sessions WHERE created_at <= ?').run(cutoff).changes;
}

export function getUser(db, id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? publicUser(row, db) : null;
}

export function publicUser(row, db = null) {
  const cash = row.balance;
  const bonus = row.bonus_balance ?? 0;
  const user = {
    id: row.id,
    username: row.username,
    /** Everything the user can trade with. */
    balance: Math.round((cash + bonus) * 1e4) / 1e4,
    cashBalance: cash,
    bonusBalance: bonus,
    realizedPnl: row.realized_pnl,
    isAdmin: !!row.is_admin,
    avatar: row.avatar,
    createdAt: row.created_at,
  };
  if (db) {
    const profile = getProfile(db, row.id);
    user.level = profile.level;
    user.xp = profile.xp;
    user.streak = profile.streak;
    user.bonusReady = profile.bonusReady;
    user.referralCode = profile.referralCode;
    user.excludedUntil = profile.excludedUntil;
  } else {
    user.level = levelFor(0);
  }
  return user;
}

/** Token from `Authorization: Bearer <token>`. */
export function tokenFromRequest(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}
