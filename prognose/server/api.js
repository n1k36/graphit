import { BRAND, CONFIG, DEFAULT_SETTINGS, getSettings, totalFeeRate, updateSettings } from './db.js';
import { HttpError, badRequest, forbidden, notFound, unauthorized } from './errors.js';
import * as auth from './auth.js';
import * as logic from './logic.js';
import * as ledger from './ledger.js';
import * as payments from './payments.js';
import * as engagement from './engagement.js';

/* Small fixed-window rate limiter, enough to slow down credential guessing.
 * Limits are read per call so tests (and operators) can raise them via
 * PROGNOSE_AUTH_LIMIT without restarting. */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const override = Number(process.env.PROGNOSE_AUTH_LIMIT);
  if (Number.isFinite(override) && override > 0) max = override;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return;
  }
  if (++bucket.count > max) {
    throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
  }
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}

function requireAdmin(ctx) {
  const user = requireUser(ctx);
  if (!user.isAdmin) throw forbidden('Admins only.');
  return user;
}

/* ---------------------------- app config ---------------------------- */

route('GET', /^\/api\/config$/, (ctx) => {
  const settings = getSettings(ctx.db);
  return {
    brand: BRAND,
    demoMode: CONFIG.demoMode,
    categories: logic.CATEGORIES,
    paymentProvider: payments.activeProvider().name,
    levels: engagement.LEVELS,
    achievements: engagement.ACHIEVEMENTS,
    feeRate: totalFeeRate(settings),
    settings: {
      platformFeeRate: settings.platformFeeRate,
      creatorFeeRate: settings.creatorFeeRate,
      listingFee: settings.listingFee,
      minDeposit: settings.minDeposit,
      maxDeposit: settings.maxDeposit,
      minWithdrawal: settings.minWithdrawal,
      withdrawalFeeRate: settings.withdrawalFeeRate,
      withdrawalFeeFlat: settings.withdrawalFeeFlat,
      welcomeBonus: settings.welcomeBonus,
      dailyBonusBase: settings.dailyBonusBase,
      dailyBonusMax: settings.dailyBonusMax,
      referralBonus: settings.referralBonus,
      defaultSubsidy: settings.defaultSubsidy,
      minSubsidy: settings.minSubsidy,
      maxSubsidy: settings.maxSubsidy,
    },
  };
});

route('GET', /^\/api\/stats$/, (ctx) => engagement.platformStats(ctx.db));
route('GET', /^\/api\/activity$/, (ctx) => ({ activity: engagement.liveActivity(ctx.db, Number(ctx.query.get('limit')) || 25) }));

/* ------------------------------- auth ------------------------------- */

route('POST', /^\/api\/auth\/signup$/, (ctx) => {
  rateLimit(`signup:${ctx.ip}`, 10, 60_000);
  const user = auth.createUser(ctx.db, ctx.body.username, ctx.body.password, { referralCode: ctx.body.referralCode });
  return { user, token: auth.createSession(ctx.db, user.id) };
});

route('POST', /^\/api\/auth\/login$/, (ctx) => {
  rateLimit(`login:${ctx.ip}`, 20, 60_000);
  const user = auth.login(ctx.db, ctx.body.username, ctx.body.password);
  return { user, token: auth.createSession(ctx.db, user.id) };
});

route('POST', /^\/api\/auth\/logout$/, (ctx) => {
  auth.destroySession(ctx.db, ctx.token);
  return { ok: true };
});

route('GET', /^\/api\/me$/, (ctx) => ({ user: ctx.user }));

/* ------------------------------ markets ----------------------------- */

route('GET', /^\/api\/markets$/, (ctx) => ({
  markets: logic.listMarkets(ctx.db, {
    search: ctx.query.get('search') ?? '',
    category: ctx.query.get('category') ?? '',
    status: ctx.query.get('status') ?? 'all',
    sort: ctx.query.get('sort') ?? 'volume',
    limit: ctx.query.get('limit') ?? 200,
  }),
}));

route('POST', /^\/api\/markets$/, (ctx) => ({
  market: logic.createMarket(ctx.db, requireUser(ctx), ctx.body),
}));

route('GET', /^\/api\/markets\/([\w-]+)$/, (ctx, slug) => {
  const row = logic.marketRowBySlug(ctx.db, slug);
  return {
    market: logic.serializeMarket(ctx.db, row, { includeTraders: true }),
    history: logic.marketHistory(ctx.db, row.id),
    trades: logic.marketTrades(ctx.db, row.id),
    comments: logic.listComments(ctx.db, row.id),
    positions: logic.userPositionsFor(ctx.db, ctx.user?.id, row.id),
  };
});

route('POST', /^\/api\/markets\/([\w-]+)\/quote$/, (ctx, slug) => {
  const row = logic.marketRowBySlug(ctx.db, slug);
  return { quote: logic.quoteTrade(ctx.db, row.id, ctx.body, ctx.user?.id) };
});

route('POST', /^\/api\/markets\/([\w-]+)\/trade$/, (ctx, slug) => {
  const row = logic.marketRowBySlug(ctx.db, slug);
  return logic.executeTrade(ctx.db, requireUser(ctx), row.id, ctx.body);
});

route('POST', /^\/api\/markets\/([\w-]+)\/resolve$/, (ctx, slug) => {
  const row = logic.marketRowBySlug(ctx.db, slug);
  return logic.resolveMarket(ctx.db, requireUser(ctx), row.id, ctx.body.outcome ?? null);
});

route('GET', /^\/api\/markets\/([\w-]+)\/history$/, (ctx, slug) =>
  logic.marketHistory(ctx.db, logic.marketRowBySlug(ctx.db, slug).id),
);

route('GET', /^\/api\/markets\/([\w-]+)\/comments$/, (ctx, slug) => ({
  comments: logic.listComments(ctx.db, logic.marketRowBySlug(ctx.db, slug).id),
}));

route('POST', /^\/api\/markets\/([\w-]+)\/comments$/, (ctx, slug) => ({
  comment: logic.addComment(ctx.db, requireUser(ctx), logic.marketRowBySlug(ctx.db, slug).id, ctx.body.body),
}));

/* ------------------- portfolio, leaderboard, profile ------------------ */

route('GET', /^\/api\/portfolio$/, (ctx) => logic.portfolio(ctx.db, requireUser(ctx).id));

route('GET', /^\/api\/leaderboard$/, (ctx) => ({
  users: logic.leaderboard(ctx.db),
  sort: ctx.query.get('sort') ?? 'networth',
}));

route('GET', /^\/api\/users\/([\w]+)$/, (ctx, username) => {
  const row = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!row) throw notFound('No such user.');
  return { ...logic.portfolio(ctx.db, row.id), achievements: engagement.listAchievements(ctx.db, row.id) };
});

route('GET', /^\/api\/achievements$/, (ctx) => ({
  achievements: engagement.listAchievements(ctx.db, requireUser(ctx).id),
}));

/* ---------------------------- engagement ---------------------------- */

route('POST', /^\/api\/bonus\/claim$/, (ctx) => {
  const user = requireUser(ctx);
  const result = engagement.claimDailyBonus(ctx.db, user);
  return { ...result, user: auth.getUser(ctx.db, user.id) };
});

route('GET', /^\/api\/notifications$/, (ctx) => engagement.listNotifications(ctx.db, requireUser(ctx).id));

route('POST', /^\/api\/notifications\/read$/, (ctx) => engagement.markNotificationsRead(ctx.db, requireUser(ctx).id));

route('GET', /^\/api\/referrals$/, (ctx) => engagement.referralStats(ctx.db, requireUser(ctx).id));

route('POST', /^\/api\/limits$/, (ctx) => ({
  profile: engagement.setLimits(ctx.db, requireUser(ctx).id, {
    depositLimit: ctx.body.depositLimit,
    excludeDays: ctx.body.excludeDays,
  }),
}));

/* ------------------------------ wallet ------------------------------ */

route('GET', /^\/api\/wallet$/, (ctx) => {
  const user = requireUser(ctx);
  return {
    user: auth.getUser(ctx.db, user.id),
    ...payments.withdrawableAmount(ctx.db, user.id),
    profile: engagement.getProfile(ctx.db, user.id),
    statement: ledger.statement(ctx.db, user.id),
    ...payments.userPayments(ctx.db, user.id),
  };
});

route('POST', /^\/api\/wallet\/deposit$/, async (ctx) => {
  const user = requireUser(ctx);
  return payments.createDeposit(ctx.db, user, ctx.body.amount);
});

/**
 * Sandbox-only shortcut so the demo checkout page can complete a deposit.
 * With a real provider this never runs — the webhook below does the work.
 */
route('POST', /^\/api\/wallet\/deposit\/confirm$/, (ctx) => {
  const user = requireUser(ctx);
  if (payments.activeProvider().name !== 'mock') {
    throw forbidden('Deposits are confirmed by the payment provider.');
  }
  const intent = ctx.db.prepare('SELECT user_id FROM payment_intents WHERE reference = ?').get(String(ctx.body.reference ?? ''));
  if (!intent) throw notFound('Unknown payment reference.');
  if (intent.user_id !== user.id) throw forbidden('That payment belongs to another account.');
  const result = payments.settleDeposit(ctx.db, ctx.body.reference, { failed: !!ctx.body.fail });
  return { ...result, user: auth.getUser(ctx.db, user.id) };
});

route('POST', /^\/api\/wallet\/withdraw$/, (ctx) => {
  const user = requireUser(ctx);
  const withdrawal = payments.requestWithdrawal(ctx.db, user, ctx.body.amount, ctx.body.destination);
  return { withdrawal, user: auth.getUser(ctx.db, user.id) };
});

/** Provider callback. Signature-verified and idempotent by reference. */
route('POST', /^\/api\/payments\/webhook$/, (ctx) => {
  const provider = payments.activeProvider();
  if (!provider.verify(ctx.rawBody, ctx.req.headers['x-signature'])) {
    throw unauthorized('Bad webhook signature.');
  }
  const { reference, status } = ctx.body;
  if (!reference) throw badRequest('Missing payment reference.');
  const result = payments.settleDeposit(ctx.db, reference, { failed: status === 'failed' });
  return { ok: true, alreadyProcessed: !!result.alreadyProcessed };
});

/* ------------------------------- admin ------------------------------ */

route('GET', /^\/api\/admin\/overview$/, (ctx) => {
  requireAdmin(ctx);
  const db = ctx.db;
  const since24h = new Date(Date.now() - 86400_000).toISOString();
  const deposits = db.prepare("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM payment_intents WHERE status = 'succeeded'").get();
  const withdrawn = db.prepare("SELECT COALESCE(SUM(net),0) AS total, COUNT(*) AS n FROM withdrawals WHERE status = 'paid'").get();
  return {
    treasury: ledger.treasuryBalance(db),
    revenueByKind: ledger.revenueByKind(db),
    revenue24h: ledger
      .revenueByKind(db, since24h)
      .reduce((sum, r) => sum + r.total, 0),
    revenueByDay: ledger.revenueByDay(db, 30),
    stats: engagement.platformStats(db),
    deposits: { total: deposits.total, count: deposits.n },
    withdrawals: { total: withdrawn.total, count: withdrawn.n },
    pendingWithdrawals: payments.listWithdrawals(db, { status: 'pending' }),
    liabilities: db.prepare('SELECT COALESCE(SUM(balance + bonus_balance),0) AS total FROM users').get().total,
    settings: getSettings(db),
    settingKeys: Object.keys(DEFAULT_SETTINGS),
  };
});

route('POST', /^\/api\/admin\/settings$/, (ctx) => {
  requireAdmin(ctx);
  return { settings: updateSettings(ctx.db, ctx.body ?? {}) };
});

route('GET', /^\/api\/admin\/withdrawals$/, (ctx) => {
  requireAdmin(ctx);
  return { withdrawals: payments.listWithdrawals(ctx.db, { status: ctx.query.get('status') ?? 'pending' }) };
});

route('POST', /^\/api\/admin\/withdrawals\/(\d+)$/, async (ctx, id) => {
  const admin = requireAdmin(ctx);
  return payments.decideWithdrawal(ctx.db, admin, id, !!ctx.body.approve, ctx.body.note ?? '');
});

route('POST', /^\/api\/admin\/markets\/([\w-]+)\/feature$/, (ctx, slug) => {
  requireAdmin(ctx);
  const row = logic.marketRowBySlug(ctx.db, slug);
  const featured = row.featured ? 0 : 1;
  ctx.db.prepare('UPDATE markets SET featured = ? WHERE id = ?').run(featured, row.id);
  return { featured: !!featured };
});

/** Dispatch an API request. Returns a JSON-serialisable body. */
export function handleApi(ctx) {
  let pathMatched = false;
  for (const r of routes) {
    const match = r.pattern.exec(ctx.pathname);
    if (!match) continue;
    pathMatched = true;
    if (r.method !== ctx.method) continue;
    return r.handler(ctx, ...match.slice(1).map(decodeURIComponent));
  }
  if (pathMatched) throw new HttpError(405, `${ctx.method} is not allowed here.`);
  throw notFound(`No API route for ${ctx.method} ${ctx.pathname}`);
}
