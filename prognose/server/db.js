import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything brand-related lives here so a rename is a one-line change. */
export const BRAND = {
  name: process.env.BRAND_NAME || 'Prophit',
  tagline: process.env.BRAND_TAGLINE || 'Wette auf alles.',
  currency: process.env.BRAND_CURRENCY || 'USD',
  symbol: '$',
};

/** Fixed constants. Anything an operator would want to tune lives in settings. */
export const CONFIG = {
  /** Play-money mode keeps deposits sandboxed and hands out a welcome balance. */
  demoMode: process.env.DEMO_MODE !== 'off',
  sessionDays: 30,
};

/**
 * Operator-tunable settings, editable at runtime from the admin panel.
 * These are the revenue and growth levers.
 */
export const DEFAULT_SETTINGS = {
  // --- revenue ---------------------------------------------------------
  /** Share of every trade's notional that goes to the platform treasury. */
  platformFeeRate: 0.006,
  /** Share of every trade's notional paid to whoever created the market. */
  creatorFeeRate: 0.004,
  /** One-off charge for listing a market. */
  listingFee: 0,
  /** Charged on withdrawals: percentage plus a flat amount. */
  withdrawalFeeRate: 0,
  withdrawalFeeFlat: 0,

  // --- payments --------------------------------------------------------
  minDeposit: 10,
  maxDeposit: 5000,
  minWithdrawal: 20,
  /** Bonus funds must be wagered this many times before cash can leave. */
  wageringMultiplier: 1,
  /** Hard cap on deposits per rolling 24h, per account. */
  dailyDepositLimit: 5000,

  // --- growth ----------------------------------------------------------
  welcomeBonus: 1000,
  dailyBonusBase: 5,
  dailyBonusMax: 50,
  referralBonus: 25,

  // --- markets ---------------------------------------------------------
  defaultSubsidy: 100,
  minSubsidy: 25,
  maxSubsidy: 1000,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  username        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT    NOT NULL,
  salt            TEXT    NOT NULL,
  balance         REAL    NOT NULL DEFAULT 0,   -- withdrawable cash
  bonus_balance   REAL    NOT NULL DEFAULT 0,   -- promo credits, playable but not withdrawable
  realized_pnl    REAL    NOT NULL DEFAULT 0,
  is_admin        INTEGER NOT NULL DEFAULT 0,
  avatar          TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS markets (
  id               INTEGER PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  question         TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  category         TEXT NOT NULL DEFAULT 'Other',
  emoji            TEXT NOT NULL DEFAULT '',
  outcomes         TEXT NOT NULL,
  q                TEXT NOT NULL,
  b                REAL NOT NULL,
  subsidy          REAL NOT NULL,
  collected        REAL NOT NULL DEFAULT 0,
  volume           REAL NOT NULL DEFAULT 0,
  trade_count      INTEGER NOT NULL DEFAULT 0,
  creator_id       INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL,
  closes_at        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  resolved_outcome INTEGER,
  resolved_at      TEXT,
  featured         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS positions (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market_id  INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  outcome    INTEGER NOT NULL,
  shares     REAL NOT NULL DEFAULT 0,
  cost_basis REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, market_id, outcome)
);

CREATE TABLE IF NOT EXISTS trades (
  id         INTEGER PRIMARY KEY,
  market_id  INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outcome    INTEGER NOT NULL,
  side       TEXT NOT NULL,
  shares     REAL NOT NULL,
  cost       REAL NOT NULL,
  fee        REAL NOT NULL,
  avg_price  REAL NOT NULL,
  prices     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY,
  market_id  INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

/* ---------------------------- money ---------------------------------- */

/*
 * Every movement of money is one row here, and nothing moves without one.
 * account is 'cash' | 'bonus' (per user) or 'platform' (treasury).
 * Platform revenue is simply SUM(amount) WHERE account = 'platform'.
 */
CREATE TABLE IF NOT EXISTS ledger (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  account       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  amount        REAL NOT NULL,
  balance_after REAL,
  market_id     INTEGER,
  ref           TEXT,
  memo          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id             INTEGER PRIMARY KEY,
  reference      TEXT NOT NULL UNIQUE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount         REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  provider       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',   -- pending | succeeded | failed | cancelled
  checkout_url   TEXT NOT NULL DEFAULT '',
  provider_ref   TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  completed_at   TEXT
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount       REAL NOT NULL,          -- gross, debited on request
  fee          REAL NOT NULL DEFAULT 0,
  net          REAL NOT NULL,          -- what the user actually receives
  destination  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | rejected
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  settled_at   TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

/* -------------------------- engagement -------------------------------- */

CREATE TABLE IF NOT EXISTS profiles (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp             REAL NOT NULL DEFAULT 0,
  wagered        REAL NOT NULL DEFAULT 0,
  deposited      REAL NOT NULL DEFAULT 0,
  withdrawn      REAL NOT NULL DEFAULT 0,
  bonus_granted  REAL NOT NULL DEFAULT 0,
  streak         INTEGER NOT NULL DEFAULT 0,
  best_streak    INTEGER NOT NULL DEFAULT 0,
  last_bonus_day TEXT NOT NULL DEFAULT '',
  referral_code  TEXT NOT NULL DEFAULT '',
  referred_by    INTEGER REFERENCES users(id),
  wins           INTEGER NOT NULL DEFAULT 0,
  losses         INTEGER NOT NULL DEFAULT 0,
  /* responsible play — required by every licensing regime */
  deposit_limit  REAL,
  excluded_until TEXT
);

CREATE TABLE IF NOT EXISTS achievements (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  earned_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  href       TEXT NOT NULL DEFAULT '',
  amount     REAL,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_market  ON trades(market_id, id);
CREATE INDEX IF NOT EXISTS idx_trades_user    ON trades(user_id, id);
CREATE INDEX IF NOT EXISTS idx_trades_time    ON trades(created_at);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_market ON comments(market_id, id);
CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status, closes_at);
CREATE INDEX IF NOT EXISTS idx_ledger_user    ON ledger(user_id, id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger(account, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_user     ON notifications(user_id, read, id);
CREATE INDEX IF NOT EXISTS idx_withdrawals    ON withdrawals(status, id);
`;

export function defaultDbPath() {
  return process.env.PROGNOSE_DB || path.join(ROOT, 'data', 'prognose.db');
}

/** Add a column to an existing table if it is not there yet. */
function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openDb(file = defaultDbPath()) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // Databases created before the wallet existed pick the new columns up here.
  ensureColumn(db, 'users', 'bonus_balance', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'markets', 'featured', 'INTEGER NOT NULL DEFAULT 0');
  return db;
}

/* ------------------------------ settings ------------------------------ */

const settingsCache = new WeakMap();

export function getSettings(db) {
  const cached = settingsCache.get(db);
  if (cached) return cached;
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (row.key in settings) {
      const parsed = Number(row.value);
      if (Number.isFinite(parsed)) settings[row.key] = parsed;
    }
  }
  settingsCache.set(db, settings);
  return settings;
}

/** Persist a partial settings patch and drop the cache. */
export function updateSettings(db, patch) {
  const statement = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) continue;
    statement.run(key, String(numeric));
  }
  settingsCache.delete(db);
  return getSettings(db);
}

/** Total fee charged on a trade's notional. */
export const totalFeeRate = (settings) => settings.platformFeeRate + settings.creatorFeeRate;

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already unwound */
    }
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);
