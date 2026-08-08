import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG = {
  /** Play money handed to every new account. */
  startingBalance: 1000,
  /** Taken on the notional of every trade and paid to the market creator. */
  feeRate: 0.01,
  /** Default worst-case subsidy a creator posts to open a market. */
  defaultSubsidy: 100,
  minSubsidy: 25,
  maxSubsidy: 1000,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  balance       REAL    NOT NULL,
  realized_pnl  REAL    NOT NULL DEFAULT 0,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  avatar        TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL
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
  outcomes         TEXT NOT NULL,            -- JSON array of labels
  q                TEXT NOT NULL,            -- JSON array of LMSR share quantities
  b                REAL NOT NULL,            -- LMSR liquidity parameter
  subsidy          REAL NOT NULL,            -- creator's posted worst-case loss
  collected        REAL NOT NULL DEFAULT 0,  -- net cash taken in by the AMM
  volume           REAL NOT NULL DEFAULT 0,  -- gross notional traded
  trade_count      INTEGER NOT NULL DEFAULT 0,
  creator_id       INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL,
  closes_at        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',  -- open | resolved | cancelled
  resolved_outcome INTEGER,
  resolved_at      TEXT
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
  side       TEXT NOT NULL,            -- buy | sell
  shares     REAL NOT NULL,            -- positive magnitude
  cost       REAL NOT NULL,            -- cash the user paid (negative on sells)
  fee        REAL NOT NULL,
  avg_price  REAL NOT NULL,
  prices     TEXT NOT NULL,            -- JSON price vector after the trade
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY,
  market_id  INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id, id);
CREATE INDEX IF NOT EXISTS idx_trades_user   ON trades(user_id, id);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_market ON comments(market_id, id);
CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status, closes_at);
`;

export function defaultDbPath() {
  return process.env.PROGNOSE_DB || path.join(ROOT, 'data', 'prognose.db');
}

export function openDb(file = defaultDbPath()) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` inside a transaction, rolling back if it throws. */
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
      /* the transaction was already unwound */
    }
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
