import test from 'node:test';
import assert from 'node:assert/strict';
import { before, after } from 'node:test';
import { openDb } from '../server/db.js';
import { createServer } from '../server/server.js';

let server;
let base;
let db;

before(async () => {
  process.env.PROGNOSE_AUTH_LIMIT = '10000';
  db = openDb(':memory:');
  server = createServer(db);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const signup = async (username) => {
  const res = await call('/api/auth/signup', { method: 'POST', body: { username, password: 'password123' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

async function makeAdmin(username) {
  const account = await signup(username);
  db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(username);
  return account;
}

async function newMarket(token, question) {
  const res = await call('/api/markets', {
    method: 'POST',
    body: {
      question,
      description: 'Resolves on the stated criteria.',
      category: 'Other',
      closesAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      subsidy: 100,
    },
    token,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.market;
}

/* ------------------------------- reporting ------------------------------ */

test('anyone signed in can report a market, and duplicates are absorbed', async () => {
  const { token: authorToken } = await signup('author1');
  const market = await newMarket(authorToken, 'Will this market be reported by someone?');
  const { token } = await signup('reporter1');

  const first = await call('/api/reports', {
    method: 'POST',
    body: { kind: 'market', targetId: market.id, reason: 'harassment', note: 'targets a private person' },
    token,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);

  // Reporting twice is a no-op, not an error — they have already been heard.
  const second = await call('/api/reports', {
    method: 'POST',
    body: { kind: 'market', targetId: market.id, reason: 'harassment' },
    token,
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyReported, true);

  assert.equal((await call('/api/reports', { method: 'POST', body: { kind: 'market', targetId: market.id, reason: 'harassment' } })).status, 401);
});

test('a report needs a real target and a reason from the list', async () => {
  const { token } = await signup('reporter2');
  assert.equal((await call('/api/reports', { method: 'POST', body: { kind: 'market', targetId: 999999, reason: 'spam' }, token })).status, 404);
  assert.equal((await call('/api/reports', { method: 'POST', body: { kind: 'market', targetId: 1, reason: 'because' }, token })).status, 400);
  assert.equal((await call('/api/reports', { method: 'POST', body: { kind: 'nonsense', targetId: 1, reason: 'spam' }, token })).status, 400);
});

test('the queue is admin-only and counts distinct reporters', async () => {
  const { token: adminToken } = await makeAdmin('mod1');
  const { token: authorToken } = await signup('author2');
  const market = await newMarket(authorToken, 'Will several people report this one?');

  for (const name of ['flagger1', 'flagger2', 'flagger3']) {
    const { token } = await signup(name);
    await call('/api/reports', { method: 'POST', body: { kind: 'market', targetId: market.id, reason: 'spam' }, token });
  }

  assert.equal((await call('/api/admin/reports', { token: authorToken })).status, 403);
  const { body } = await call('/api/admin/reports', { token: adminToken });
  const entry = body.reports.find((r) => r.target?.id === market.id);
  assert.ok(entry, 'the report should be in the open queue');
  assert.equal(entry.reportCount, 3);
  assert.equal(entry.target.author, 'author2');
  assert.equal(entry.reasonLabel, 'Spam or a duplicate');
  assert.ok(body.counts.open >= 3);
});

/* ------------------------- hiding and freezing --------------------------- */

test('hiding a market removes it from listings and freezes trading', async () => {
  const { token: adminToken } = await makeAdmin('mod2');
  const { token: authorToken } = await signup('author3');
  const market = await newMarket(authorToken, 'Will hiding this market freeze its trading?');
  const { token: traderToken } = await signup('trader1');

  // Tradable before.
  assert.equal(
    (await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: 10 }, token: traderToken }))
      .status,
    200,
  );
  const listedBefore = (await call('/api/markets')).body.markets.some((m) => m.slug === market.slug);
  assert.equal(listedBefore, true);

  const hidden = await call(`/api/admin/markets/${market.slug}/hide`, { method: 'POST', body: { hidden: true }, token: adminToken });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.hidden, true);

  const listedAfter = (await call('/api/markets')).body.markets.some((m) => m.slug === market.slug);
  assert.equal(listedAfter, false, 'a hidden market must not appear in any listing');

  const blocked = await call(`/api/markets/${market.slug}/trade`, {
    method: 'POST',
    body: { outcome: 0, side: 'buy', budget: 10 },
    token: traderToken,
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /under review/i);

  // The market is not deleted: existing positions still have to settle.
  const detail = await call(`/api/markets/${market.slug}`, { token: traderToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.market.hidden, true);

  // And it can be restored.
  await call(`/api/admin/markets/${market.slug}/hide`, { method: 'POST', body: { hidden: false }, token: adminToken });
  assert.equal((await call('/api/markets')).body.markets.some((m) => m.slug === market.slug), true);
  assert.equal((await call('/api/admin/markets/' + market.slug + '/hide', { method: 'POST', body: { hidden: true } })).status, 401);
});

/* ----------------------------- resolving --------------------------------- */

test('acting on one report settles every report about the same thing', async () => {
  const { token: adminToken } = await makeAdmin('mod3');
  const { token: authorToken } = await signup('author4');
  const market = await newMarket(authorToken, 'Will resolving sweep the sibling reports?');

  const ids = [];
  for (const name of ['sweep1', 'sweep2']) {
    const { token } = await signup(name);
    await call('/api/reports', { method: 'POST', body: { kind: 'market', targetId: market.id, reason: 'illegal' }, token });
  }
  const queue = (await call('/api/admin/reports', { token: adminToken })).body.reports.filter((r) => r.target?.id === market.id);
  assert.equal(queue.length, 2);
  ids.push(...queue.map((r) => r.id));

  const resolved = await call(`/api/admin/reports/${ids[0]}`, {
    method: 'POST',
    body: { action: 'hide_market', note: 'Breaks the rules.' },
    token: adminToken,
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.affected.hidden, true);
  assert.equal(resolved.body.alsoResolved, 1, 'the sibling report is closed by the same decision');

  const stillOpen = (await call('/api/admin/reports', { token: adminToken })).body.reports.filter((r) => r.target?.id === market.id);
  assert.equal(stillOpen.length, 0);

  // A handled report cannot be acted on twice.
  assert.equal(
    (await call(`/api/admin/reports/${ids[0]}`, { method: 'POST', body: { action: 'dismiss' }, token: adminToken })).status,
    400,
  );
});

test('dismissing leaves the market alone', async () => {
  const { token: adminToken } = await makeAdmin('mod4');
  const { token: authorToken } = await signup('author5');
  const market = await newMarket(authorToken, 'Will a dismissed report leave this alone?');
  const { token } = await signup('dismisser');
  await call('/api/reports', { method: 'POST', body: { kind: 'market', targetId: market.id, reason: 'other' }, token });

  const report = (await call('/api/admin/reports', { token: adminToken })).body.reports.find((r) => r.target?.id === market.id);
  await call(`/api/admin/reports/${report.id}`, { method: 'POST', body: { action: 'dismiss' }, token: adminToken });

  assert.equal((await call('/api/markets')).body.markets.some((m) => m.slug === market.slug), true);
  const handled = (await call('/api/admin/reports?status=dismissed', { token: adminToken })).body.reports;
  assert.ok(handled.some((r) => r.id === report.id));
});

test('a removed comment leaves a tombstone rather than a hole', async () => {
  const { token: adminToken } = await makeAdmin('mod5');
  const { token: authorToken } = await signup('commenter1');
  const market = await newMarket(authorToken, 'Will a removed comment leave a tombstone?');

  await call(`/api/markets/${market.slug}/comments`, { method: 'POST', body: { body: 'something abusive' }, token: authorToken });
  const comment = (await call(`/api/markets/${market.slug}/comments`)).body.comments[0];

  const { token: reporterToken } = await signup('commentreporter');
  await call('/api/reports', { method: 'POST', body: { kind: 'comment', targetId: comment.id, reason: 'hateful' }, token: reporterToken });
  const report = (await call('/api/admin/reports', { token: adminToken })).body.reports.find((r) => r.kind === 'comment');

  await call(`/api/admin/reports/${report.id}`, { method: 'POST', body: { action: 'delete_comment' }, token: adminToken });

  const after = (await call(`/api/markets/${market.slug}/comments`)).body.comments.find((c) => c.id === comment.id);
  assert.equal(after.removed, true);
  assert.equal(after.body, '', 'the text is gone');
  assert.equal(after.user.username, '—', 'and so is the attribution');
});

/* ---------------------------- suspensions -------------------------------- */

test('a suspended account cannot trade, create or comment', async () => {
  const { token: adminToken } = await makeAdmin('mod6');
  const { token: hostToken } = await signup('host1');
  const market = await newMarket(hostToken, 'Will a suspended user be stopped from trading?');

  const { token, user } = await signup('offender');
  const suspended = await call(`/api/admin/users/${user.id}/suspend`, {
    method: 'POST',
    body: { days: 7, note: 'Repeated abuse.' },
    token: adminToken,
  });
  assert.equal(suspended.status, 200);

  const trade = await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: 10 }, token });
  assert.equal(trade.status, 403);
  assert.match(trade.body.error, /suspended/i);

  const comment = await call(`/api/markets/${market.slug}/comments`, { method: 'POST', body: { body: 'hello' }, token });
  assert.equal(comment.status, 403);

  const create = await call('/api/markets', {
    method: 'POST',
    body: { question: 'Can a suspended user open a market?', closesAt: new Date(Date.now() + 86400_000 * 5).toISOString(), subsidy: 100 },
    token,
  });
  assert.equal(create.status, 403);

  // They can still see their own suspension.
  const me = await call('/api/me', { token });
  assert.ok(me.body.suspension?.until);
  assert.match(me.body.suspension.note, /abuse/i);

  // Lifting it restores everything.
  await call(`/api/admin/users/${user.id}/suspend`, { method: 'POST', body: { lift: true }, token: adminToken });
  assert.equal(
    (await call(`/api/markets/${market.slug}/trade`, { method: 'POST', body: { outcome: 0, side: 'buy', budget: 10 }, token })).status,
    200,
  );
});

test('suspension is admin-only, bounded, and never applies to an admin', async () => {
  const { token: adminToken } = await makeAdmin('mod7');
  const { user: victim } = await signup('victim');
  const { token: randomToken, user: random } = await signup('nobody');

  assert.equal((await call(`/api/admin/users/${victim.id}/suspend`, { method: 'POST', body: { days: 3 }, token: randomToken })).status, 403);
  assert.equal((await call(`/api/admin/users/${victim.id}/suspend`, { method: 'POST', body: { days: 0 }, token: adminToken })).status, 400);
  assert.equal((await call(`/api/admin/users/${victim.id}/suspend`, { method: 'POST', body: { days: 99999 }, token: adminToken })).status, 400);
  assert.equal((await call(`/api/admin/users/999999/suspend`, { method: 'POST', body: { days: 3 }, token: adminToken })).status, 404);

  const adminAccount = db.prepare("SELECT id FROM users WHERE username = 'mod7'").get();
  assert.equal(
    (await call(`/api/admin/users/${adminAccount.id}/suspend`, { method: 'POST', body: { days: 3 }, token: adminToken })).status,
    400,
    'an admin must not be suspendable through this route',
  );
  assert.ok(random.id);
});

test('the report reasons and actions are published for the client', async () => {
  const { body } = await call('/api/config');
  assert.ok(Object.keys(body.reportReasons).length >= 5);
  assert.ok(body.reportReasons.harassment);
  assert.ok(body.moderationActions.hide_market);
});
