import test from 'node:test';
import assert from 'node:assert/strict';
import { before, after } from 'node:test';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { openDb, nowIso } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { matchDeposits, referenceTextOf, creditAmountOf, wiseProvider, fetchStatement, wiseConfig } from '../server/providers/wise.js';
import { reconcileDeposits, parseDestination } from '../server/payments.js';

/* A throwaway RSA pair standing in for Wise's webhook signing key. */
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

before(() => {
  process.env.PAYMENTS_PROVIDER = 'wise';
  process.env.WISE_API_TOKEN = 'test-token';
  process.env.WISE_PROFILE_ID = '12345';
  process.env.WISE_CURRENCY = 'EUR';
  process.env.WISE_PUBLIC_KEY = publicKey;
  process.env.WISE_ACCOUNT_IBAN = 'DE89370400440532013000';
  process.env.WISE_ACCOUNT_HOLDER = 'NEMS LLC';
});

after(() => {
  delete process.env.PAYMENTS_PROVIDER;
});

const credit = (value, reference, id = String(Math.random())) => ({
  type: 'CREDIT',
  amount: { value, currency: 'EUR' },
  referenceNumber: id,
  details: { paymentReference: reference, senderName: 'A Payer' },
});

/* --------------------------- reference matching --------------------------- */

test('a credit is matched to the intent whose reference it quotes', () => {
  const pending = [{ reference: 'dep_aaa111' }, { reference: 'dep_bbb222' }];
  const transactions = [credit(50, 'dep_bbb222', 't1'), credit(25, 'dep_aaa111', 't2')];
  const matches = matchDeposits(pending, transactions);
  assert.equal(matches.length, 2);
  assert.deepEqual(
    matches.map((m) => [m.reference, m.received]).sort(),
    [
      ['dep_aaa111', 25],
      ['dep_bbb222', 50],
    ].sort(),
  );
});

test('references survive the mangling banks and payers apply', () => {
  const pending = [{ reference: 'dep_4cd00546' }];
  for (const written of ['DEP 4CD0 0546', 'dep-4cd00546', 'Ref: DEP_4CD00546 thanks', 'dep 4cd0 0546']) {
    const matches = matchDeposits(pending, [credit(100, written)]);
    assert.equal(matches.length, 1, `should have matched "${written}"`);
  }
});

test('unrelated, outgoing and unreferenced credits are ignored', () => {
  const pending = [{ reference: 'dep_xyz789' }];
  const transactions = [
    credit(500, 'salary january'),
    { type: 'DEBIT', amount: { value: -20, currency: 'EUR' }, details: { paymentReference: 'dep_xyz789' } },
    { type: 'CREDIT', amount: { value: 0, currency: 'EUR' }, details: {} },
  ];
  assert.deepEqual(matchDeposits(pending, transactions), []);
});

test('one bank credit cannot settle two deposits', () => {
  const pending = [{ reference: 'dep_same' }, { reference: 'dep_same' }];
  const matches = matchDeposits(pending, [credit(30, 'dep_same', 'only-one')]);
  assert.equal(matches.length, 1, 'the same statement entry must not be consumed twice');
});

test('the reference can hide in any of the free-text fields', () => {
  assert.match(referenceTextOf({ details: { description: 'dep_1' } }), /dep_1/);
  assert.match(referenceTextOf({ referenceNumber: 'dep_2' }), /dep_2/);
  assert.equal(creditAmountOf({ type: 'CREDIT', amount: { value: 12.5 } }), 12.5);
  assert.equal(creditAmountOf({ type: 'DEBIT', amount: { value: 12.5 } }), null);
});

/* ------------------------------ webhooks --------------------------------- */

test('a genuine Wise webhook signature verifies and a forged one does not', () => {
  const body = JSON.stringify({ event_type: 'balances#credit', data: { amount: 100 } });
  const signer = createSign('RSA-SHA256');
  signer.update(body);
  const signature = signer.sign(privateKey, 'base64');

  assert.equal(wiseProvider.verify(body, signature), true);
  assert.equal(wiseProvider.verify(body, 'not-a-signature'), false);
  assert.equal(wiseProvider.verify(`${body} tampered`, signature), false);
  assert.equal(wiseProvider.verify(body, undefined), false);
});

/* ---------------------------- reconciliation ----------------------------- */

/** Stub the two Wise endpoints fetchStatement touches. */
function stubWise(transactions) {
  return async (url) => {
    const json = (payload) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(payload),
    });
    if (url.includes('/balances')) return json([{ id: 777, currency: 'EUR' }]);
    if (url.includes('/statement.json')) return json({ transactions });
    throw new Error(`unexpected call to ${url}`);
  };
}

test('reconciliation credits pending deposits from the statement, once', async () => {
  const db = openDb(':memory:');
  const user = createUser(db, 'wiseuser', 'password123');
  // The welcome bonus lands in bonus credit, so withdrawable cash starts at 0.
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id).balance, 0);

  db.prepare(
    `INSERT INTO payment_intents (reference, user_id, amount, provider, status, checkout_url, provider_ref, created_at)
     VALUES ('dep_test01', ?, 100, 'wise', 'pending', '', '', ?)`,
  ).run(user.id, nowIso());

  const fetchImpl = stubWise([credit(100, 'dep_test01', 'tx-1')]);
  const first = await reconcileDeposits(db, { fetchImpl });
  assert.equal(first.settled.length, 1);
  assert.equal(first.settled[0].credited, 100);

  const afterFirst = db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id).balance;
  assert.equal(afterFirst, 100, 'the deposit landed in withdrawable cash');

  // Running it again must not pay twice, even though the statement still shows it.
  const second = await reconcileDeposits(db, { fetchImpl });
  assert.equal(second.settled.length, 0, 'already-settled deposits are skipped');
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id).balance, afterFirst);
  db.close();
});

test('the amount actually received is what gets credited', async () => {
  const db = openDb(':memory:');
  const user = createUser(db, 'shortpayer', 'password123');
  db.prepare(
    `INSERT INTO payment_intents (reference, user_id, amount, provider, status, checkout_url, provider_ref, created_at)
     VALUES ('dep_short1', ?, 200, 'wise', 'pending', '', '', ?)`,
  ).run(user.id, nowIso());

  // They asked to deposit 200 but actually sent 173.45.
  const result = await reconcileDeposits(db, { fetchImpl: stubWise([credit(173.45, 'dep_short1', 'tx-2')]) });
  assert.equal(result.settled[0].credited, 173.45);
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id).balance, 173.45);
  // The stored intent is corrected too, so reporting stays honest.
  assert.equal(db.prepare("SELECT amount FROM payment_intents WHERE reference = 'dep_short1'").get().amount, 173.45);
  db.close();
});

test('reconciliation is a no-op when nothing is pending', async () => {
  const db = openDb(':memory:');
  const result = await reconcileDeposits(db, { fetchImpl: stubWise([credit(50, 'dep_nothing')]) });
  assert.equal(result.pending, 0);
  assert.deepEqual(result.settled, []);
  db.close();
});

test('fetchStatement asks for the balance matching the configured currency', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return stubWise([credit(10, 'dep_x')])(url);
  };
  const transactions = await fetchStatement(wiseConfig(), { fetchImpl });
  assert.equal(transactions.length, 1);
  assert.ok(seen.some((u) => u.includes('/v4/profiles/12345/balances')));
  assert.ok(seen.some((u) => u.includes('/balance-statements/777/statement.json')));
  assert.ok(seen.some((u) => u.includes('currency=EUR')));
});

/* ------------------------------- payouts --------------------------------- */

test('a payout destination is parsed into name and IBAN', () => {
  const db = openDb(':memory:');
  const user = createUser(db, 'payee', 'password123');
  const parsed = parseDestination(db, { user_id: user.id, id: 42, destination: 'Max Mustermann, DE89 3704 0044 0532 0130 00' });
  assert.equal(parsed.iban, 'DE89370400440532013000');
  assert.equal(parsed.accountHolderName, 'Max Mustermann');
  assert.equal(parsed.idempotencyKey, 'withdrawal-42');

  // Falls back to the username when only an IBAN was given.
  const bare = parseDestination(db, { user_id: user.id, id: 43, destination: 'DE89370400440532013000' });
  assert.equal(bare.accountHolderName, 'payee');
  db.close();
});

test('a payout walks quote → recipient → transfer → fund', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(`${options.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
    const json = (payload) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(payload),
    });
    if (url.includes('/quotes')) return json({ id: 'quote-1' });
    if (url.includes('/v1/accounts')) return json({ id: 999 });
    if (url.includes('/v1/transfers')) return json({ id: 555 });
    if (url.includes('/payments')) return json({ status: 'COMPLETED' });
    throw new Error(`unexpected ${url}`);
  };

  const result = await wiseProvider.payout({
    amount: 120,
    destination: { iban: 'DE89370400440532013000', accountHolderName: 'Max Mustermann', idempotencyKey: 'withdrawal-1' },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerRef, '555');
  assert.deepEqual(calls, [
    'POST /v3/profiles/12345/quotes',
    'POST /v1/accounts',
    'POST /v1/transfers',
    'POST /v3/profiles/12345/transfers/555/payments',
  ]);
});

test('a payout that Wise refuses to fund is reported as a failure', async () => {
  const fetchImpl = async (url) => {
    const json = (payload) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) });
    if (url.includes('/quotes')) return json({ id: 'q' });
    if (url.includes('/v1/accounts')) return json({ id: 1 });
    if (url.includes('/v1/transfers')) return json({ id: 2 });
    return json({ status: 'REJECTED', errorCode: 'insufficient.funds' });
  };
  await assert.rejects(
    () =>
      wiseProvider.payout({
        amount: 10,
        destination: { iban: 'DE89370400440532013000', accountHolderName: 'X', idempotencyKey: 'k' },
        fetchImpl,
      }),
    /REJECTED|insufficient/,
  );
});

test('Wise API errors surface with their message rather than a bare 500', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 422,
    headers: { get: () => null },
    text: async () => JSON.stringify({ errors: [{ message: 'Target account is invalid' }] }),
  });
  await assert.rejects(
    () => fetchStatement(wiseConfig(), { fetchImpl }),
    /Target account is invalid/,
  );
});
