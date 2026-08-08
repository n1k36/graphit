import { CONFIG } from './db.js';
import { HttpError, badRequest, notFound, unauthorized } from './errors.js';
import * as auth from './auth.js';
import * as logic from './logic.js';

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

/** Resolve `ctx.user` or reject. */
function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}

/* ---------------------------- auth ---------------------------- */

route('GET', /^\/api\/config$/, () => ({
  categories: logic.CATEGORIES,
  startingBalance: CONFIG.startingBalance,
  feeRate: CONFIG.feeRate,
  defaultSubsidy: CONFIG.defaultSubsidy,
  minSubsidy: CONFIG.minSubsidy,
  maxSubsidy: CONFIG.maxSubsidy,
}));

route('POST', /^\/api\/auth\/signup$/, (ctx) => {
  rateLimit(`signup:${ctx.ip}`, 10, 60_000);
  const user = auth.createUser(ctx.db, ctx.body.username, ctx.body.password);
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

/* --------------------------- markets --------------------------- */

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

route('GET', /^\/api\/markets\/([\w-]+)\/history$/, (ctx, slug) => {
  const row = logic.marketRowBySlug(ctx.db, slug);
  return logic.marketHistory(ctx.db, row.id);
});

route('GET', /^\/api\/markets\/([\w-]+)\/comments$/, (ctx, slug) => ({
  comments: logic.listComments(ctx.db, logic.marketRowBySlug(ctx.db, slug).id),
}));

route('POST', /^\/api\/markets\/([\w-]+)\/comments$/, (ctx, slug) => ({
  comment: logic.addComment(ctx.db, requireUser(ctx), logic.marketRowBySlug(ctx.db, slug).id, ctx.body.body),
}));

/* ------------------- portfolio and leaderboard ------------------ */

route('GET', /^\/api\/portfolio$/, (ctx) => logic.portfolio(ctx.db, requireUser(ctx).id));

route('GET', /^\/api\/leaderboard$/, (ctx) => ({ users: logic.leaderboard(ctx.db) }));

route('GET', /^\/api\/users\/([\w]+)$/, (ctx, username) => {
  const row = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!row) throw notFound('No such user.');
  return logic.portfolio(ctx.db, row.id);
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

export { badRequest };
