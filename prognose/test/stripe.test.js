import test from 'node:test';
import assert from 'node:assert/strict';
import { before, after } from 'node:test';
import { createHmac } from 'node:crypto';
import { openDb, nowIso } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { stripeProvider, formEncode, stripeConfig } from '../server/providers/stripe.js';
import { settleDeposit, activeProvider, activePayoutProvider } from '../server/payments.js';

const WEBHOOK_SECRET = 'whsec_test_secret';

before(() => {
  process.env.PAYMENTS_PROVIDER = 'stripe';
  process.env.STRIPE_SECRET_KEY = 'sk_test_key';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_CURRENCY = 'eur';
  process.env.PUBLIC_BASE_URL = 'https://prophit.example';
});

after(() => {
  delete process.env.PAYMENTS_PROVIDER;
  delete process.env.PAYOUT_PROVIDER;
});

/* ----------------------------- form encoding ---------------------------- */

test('nested params are encoded the way Stripe expects', () => {
  const encoded = formEncode({
    mode: 'payment',
    metadata: { reference: 'dep_1' },
    line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 2500 } }],
  });
  assert.ok(encoded.includes('mode=payment'));
  assert.ok(encoded.includes('metadata%5Breference%5D=dep_1'));
  assert.ok(encoded.includes('line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=2500'));
});

test('values that would break a query string are escaped', () => {
  const encoded = formEncode({ 'product_data[name]': 'Deposit & fees', note: 'a=b&c' }).join('&');
  assert.ok(!encoded.includes('Deposit & fees'));
  assert.ok(encoded.includes('Deposit%20%26%20fees') || encoded.includes('Deposit+%26+fees'));
  assert.ok(encoded.includes('a%3Db%26c'));
});

/* ------------------------------- checkout ------------------------------- */

test('a checkout session carries the reference Stripe will hand back', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, body: decodeURIComponent(options.body), auth: options.headers.authorization };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'cs_123', url: 'https://checkout.stripe.com/c/pay/cs_123' }) };
  };

  const result = await stripeProvider.createCheckout({ reference: 'dep_abc', amount: 25, fetchImpl });

  assert.equal(result.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_123');
  assert.equal(result.providerRef, 'cs_123');
  assert.ok(captured.url.endsWith('/v1/checkout/sessions'));
  assert.equal(captured.auth, 'Bearer sk_test_key');
  assert.ok(captured.body.includes('client_reference_id=dep_abc'), 'the reference must survive the round trip');
  // Decoded, the nested keys keep their brackets: line_items[0][price_data][unit_amount]=2500
  assert.ok(captured.body.includes('[unit_amount]=2500'), '25 becomes 2500 cents');
  assert.ok(captured.body.includes('[currency]=eur'));
});

test('a Stripe API error is reported with its own message', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: { message: 'Amount must be at least €0.50' } }),
  });
  await assert.rejects(
    () => stripeProvider.createCheckout({ reference: 'dep_x', amount: 0.1, fetchImpl }),
    /Amount must be at least/,
  );
});

/* ------------------------ webhook signature checks ---------------------- */

function sign(body, { secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

test('a correctly signed webhook is accepted', () => {
  const body = JSON.stringify({ type: 'checkout.session.completed' });
  assert.equal(stripeProvider.verify(body, sign(body)), true);
});

test('forged, tampered and unsigned webhooks are all rejected', () => {
  const body = JSON.stringify({ type: 'checkout.session.completed' });
  assert.equal(stripeProvider.verify(body, sign(body, { secret: 'whsec_wrong' })), false);
  assert.equal(stripeProvider.verify(`${body} tampered`, sign(body)), false);
  assert.equal(stripeProvider.verify(body, ''), false);
  assert.equal(stripeProvider.verify(body, 't=123'), false, 'a signature with no v1 is not valid');
  assert.equal(stripeProvider.verify(body, 'garbage'), false);
});

test('an old signature is refused, so a captured webhook cannot be replayed', () => {
  const body = JSON.stringify({ type: 'checkout.session.completed' });
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(stripeProvider.verify(body, sign(body, { timestamp: old })), false);
  // Still valid inside the tolerance window.
  const recent = Math.floor(Date.now() / 1000) - 60;
  assert.equal(stripeProvider.verify(body, sign(body, { timestamp: recent })), true);
});

/* --------------------------- event interpretation ----------------------- */

test('a completed checkout credits the amount Stripe actually charged', () => {
  const outcome = stripeProvider.parseWebhook({
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: 'dep_1', payment_status: 'paid', amount_total: 4999 } },
  });
  assert.deepEqual(outcome, { reference: 'dep_1', receivedAmount: 49.99 });
});

test('an unpaid or expired session does not credit anything', () => {
  assert.equal(
    stripeProvider.parseWebhook({
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'dep_2', payment_status: 'unpaid', amount_total: 1000 } },
    }),
    null,
  );
  assert.deepEqual(
    stripeProvider.parseWebhook({ type: 'checkout.session.expired', data: { object: { client_reference_id: 'dep_3' } } }),
    { reference: 'dep_3', failed: true },
  );
});

test('the reference is found in metadata when client_reference_id is absent', () => {
  const outcome = stripeProvider.parseWebhook({
    type: 'checkout.session.completed',
    data: { object: { metadata: { reference: 'dep_meta' }, payment_status: 'paid', amount_total: 100 } },
  });
  assert.equal(outcome.reference, 'dep_meta');
});

test('unrelated events are ignored rather than mishandled', () => {
  for (const type of ['customer.created', 'invoice.paid', 'charge.refunded', undefined]) {
    assert.equal(stripeProvider.parseWebhook({ type, data: { object: {} } }), null);
  }
});

/* ------------------------- end-to-end through the ledger ---------------- */

test('a Stripe completion credits the user exactly once', () => {
  const db = openDb(':memory:');
  const user = createUser(db, 'cardpayer', 'password123');
  db.prepare(
    `INSERT INTO payment_intents (reference, user_id, amount, provider, status, checkout_url, provider_ref, created_at)
     VALUES ('dep_card1', ?, 50, 'stripe', 'pending', '', 'cs_1', ?)`,
  ).run(user.id, nowIso());

  const outcome = stripeProvider.parseWebhook({
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: 'dep_card1', payment_status: 'paid', amount_total: 5000 } },
  });
  const first = settleDeposit(db, outcome.reference, { receivedAmount: outcome.receivedAmount });
  assert.equal(first.credited, 50);
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id).balance, 50);

  // Stripe retries webhooks; the second delivery must be a no-op.
  const second = settleDeposit(db, outcome.reference, { receivedAmount: outcome.receivedAmount });
  assert.equal(second.alreadyProcessed, true);
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id).balance, 50);
  db.close();
});

/* ------------------------------ payouts --------------------------------- */

test('Stripe payouts fail loudly and point at the fix', async () => {
  await assert.rejects(() => stripeProvider.payout({ amount: 10, destination: {} }), /Connect|PAYOUT_PROVIDER/);
});

test('deposits and payouts can run through different providers', () => {
  assert.equal(activeProvider().name, 'stripe');
  assert.equal(activePayoutProvider().name, 'stripe', 'defaults to the deposit provider');

  process.env.PAYOUT_PROVIDER = 'wise';
  assert.equal(activeProvider().name, 'stripe', 'cards still come in through Stripe');
  assert.equal(activePayoutProvider().name, 'wise', 'money goes out through Wise');
});

test('config reads the environment it was given', () => {
  const config = stripeConfig();
  assert.equal(config.currency, 'eur');
  assert.equal(config.baseUrl, 'https://prophit.example');
  assert.equal(config.secretKey, 'sk_test_key');
});
