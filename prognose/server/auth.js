import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { CONFIG, nowIso } from './db.js';
import { HttpError } from './errors.js';

const KEY_LEN = 64;
const AVATAR_COLORS = ['#4f8cff', '#22c55e', '#f97316', '#a855f7', '#ec4899', '#14b8a6', '#eab308', '#ef4444'];

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

export function createUser(db, username, password, { isAdmin = false } = {}) {
  validateCredentials(username, password);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw new HttpError(409, 'That username is already taken.');
  const { salt, hash } = hashPassword(password);
  const avatar = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, salt, balance, is_admin, avatar, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(username, hash, salt, CONFIG.startingBalance, isAdmin ? 1 : 0, avatar, nowIso());
  return getUser(db, Number(info.lastInsertRowid));
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
  const row = db
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
    .get(token);
  return row ? publicUser(row) : null;
}

export function getUser(db, id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? publicUser(row) : null;
}

export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    balance: row.balance,
    realizedPnl: row.realized_pnl,
    isAdmin: !!row.is_admin,
    avatar: row.avatar,
    createdAt: row.created_at,
  };
}

/** Token from `Authorization: Bearer <token>`. */
export function tokenFromRequest(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}
