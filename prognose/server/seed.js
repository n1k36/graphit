import { openDb, defaultDbPath } from './db.js';
import { createUser } from './auth.js';
import { createMarket, executeTrade, resolveMarket, addComment, marketRowById } from './logic.js';

/** Deterministic PRNG so the demo data looks the same every time. */
function rng(seedValue) {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const days = (n) => new Date(Date.now() + n * 86400_000).toISOString();

const DEMO_USERS = [
  { username: 'demo', password: 'demo123', isAdmin: true },
  { username: 'alice', password: 'password123' },
  { username: 'bob', password: 'password123' },
  { username: 'carol', password: 'password123' },
  { username: 'dave', password: 'password123' },
];

const DEMO_MARKETS = [
  {
    by: 'demo',
    emoji: '🏛️',
    category: 'Politics',
    question: 'Will the incumbent party keep its majority at the next general election?',
    description:
      'Resolves YES if the incumbent party holds an outright majority of seats once the final result is certified. A coalition does not count as a majority.',
    closesAt: days(120),
    subsidy: 120,
    ageDays: 26,
  },
  {
    by: 'demo',
    emoji: '₿',
    category: 'Crypto',
    question: 'Will Bitcoin trade above $150,000 before the end of the year?',
    description:
      'Resolves YES if the BTC/USD spot price on at least two major exchanges prints above $150,000 at any point before the close date.',
    closesAt: days(150),
    subsidy: 150,
    ageDays: 40,
  },
  {
    by: 'alice',
    emoji: '💵',
    category: 'Economics',
    question: 'Will the central bank cut rates at its next meeting?',
    description: 'Resolves YES if the headline policy rate is lowered by any amount at the next scheduled meeting.',
    closesAt: days(45),
    subsidy: 100,
    ageDays: 12,
  },
  {
    by: 'alice',
    emoji: '⚽',
    category: 'Sports',
    question: 'Which club lifts the Champions League trophy this season?',
    description: 'Resolves to the club that wins the final. If the competition is abandoned the market is cancelled.',
    outcomes: ['Real Madrid', 'Manchester City', 'Bayern Munich', 'Field (any other club)'],
    closesAt: days(210),
    subsidy: 180,
    ageDays: 33,
  },
  {
    by: 'bob',
    emoji: '🤖',
    category: 'Tech',
    question: 'Will an open-weights model top the main chatbot leaderboard this quarter?',
    description:
      'Resolves YES if a model with publicly downloadable weights holds the #1 overall spot at any point before the close date.',
    closesAt: days(70),
    subsidy: 100,
    ageDays: 18,
  },
  {
    by: 'bob',
    emoji: '🚀',
    category: 'Science',
    question: 'Will a crewed mission launch to lunar orbit before the close date?',
    description: 'Resolves YES on a successful crewed launch that reaches lunar orbit. A flyby without orbit counts as NO.',
    closesAt: days(300),
    subsidy: 100,
    ageDays: 9,
  },
  {
    by: 'carol',
    emoji: '🎬',
    category: 'Culture',
    question: 'Which film wins Best Picture?',
    outcomes: ['The Long Winter', 'Neon Harbour', 'Salt & Static', 'Anything else'],
    description: 'Resolves to the film announced as Best Picture at the ceremony.',
    closesAt: days(95),
    subsidy: 160,
    ageDays: 21,
  },
  {
    by: 'carol',
    emoji: '🌡️',
    category: 'Science',
    question: 'Will this year be declared the warmest on record?',
    description: 'Resolves YES if the primary global temperature dataset ranks the year first once final figures are published.',
    closesAt: days(180),
    subsidy: 100,
    ageDays: 15,
  },
];

/**
 * Populate an empty database with users, markets, trades and comments.
 * Returns true when it actually seeded anything.
 */
export function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;

  const users = new Map();
  for (const u of DEMO_USERS) users.set(u.username, createUser(db, u.username, u.password, { isAdmin: u.isAdmin }));

  const random = rng(20260808);
  const created = [];
  for (const spec of DEMO_MARKETS) {
    const market = createMarket(db, users.get(spec.by), {
      question: spec.question,
      description: spec.description,
      category: spec.category,
      emoji: spec.emoji,
      outcomes: spec.outcomes,
      closesAt: spec.closesAt,
      subsidy: spec.subsidy,
    });
    db.prepare('UPDATE markets SET created_at = ? WHERE id = ?').run(days(-spec.ageDays), market.id);
    created.push(market);
  }

  // A settled market so the resolved state is visible out of the box.
  const past = createMarket(db, users.get('demo'), {
    question: 'Did the summer transfer window break the previous spending record?',
    description: 'Resolved from the final published spending figures for the window.',
    category: 'Sports',
    emoji: '💸',
    closesAt: days(1),
    subsidy: 100,
  });
  db.prepare('UPDATE markets SET created_at = ? WHERE id = ?').run(days(-60), past.id);

  const traders = ['alice', 'bob', 'carol', 'dave'].map((n) => users.get(n));
  const tradeOn = (market, count) => {
    for (let i = 0; i < count; i++) {
      const trader = traders[Math.floor(random() * traders.length)];
      const outcome = Math.floor(random() * market.outcomes.length);
      const budget = Math.round((3 + random() * 45) * 100) / 100;
      try {
        executeTrade(db, trader, market.id, { outcome, side: 'buy', budget });
      } catch {
        /* a trader ran out of play money — skip this one */
      }
    }
  };

  for (const market of created) tradeOn(market, 8 + Math.floor(random() * 10));
  tradeOn(past, 12);

  addComment(db, users.get('alice'), created[1].id, 'Funding rates look stretched here — I think this is closer to a coin flip.');
  addComment(db, users.get('bob'), created[1].id, 'Disagree, momentum has been one-directional all quarter. Buying YES.');
  addComment(db, users.get('dave'), created[0].id, 'Polling averages have barely moved in three weeks. Fading the hype.');
  addComment(db, users.get('carol'), created[3].id, 'The Field price looks far too cheap for a knockout competition.');

  db.prepare('UPDATE markets SET closes_at = ? WHERE id = ?').run(days(-1), past.id);
  resolveMarket(db, users.get('demo'), past.id, 0);

  // Spread the seeded trades across each market's lifetime so charts have shape.
  for (const row of db.prepare('SELECT id, created_at FROM markets').all()) {
    const ids = db
      .prepare("SELECT id FROM trades WHERE market_id = ? AND side IN ('buy','sell') ORDER BY id")
      .all(row.id);
    const start = Date.parse(row.created_at);
    const end = Date.now();
    ids.forEach((t, i) => {
      const at = new Date(start + ((end - start) * (i + 1)) / (ids.length + 1)).toISOString();
      db.prepare('UPDATE trades SET created_at = ? WHERE id = ?').run(at, t.id);
    });
    marketRowById(db, row.id);
  }
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  const didSeed = seed(db);
  console.log(didSeed ? `Seeded ${defaultDbPath()}` : 'Database already has data — nothing to seed.');
}
