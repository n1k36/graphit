/**
 * Stripe provider — hosted Checkout for deposits.
 *
 * Talks to Stripe's REST API directly with `fetch` and form encoding, so the
 * zero-dependency rule survives. The official SDK would work identically; it
 * is a convenience wrapper over exactly these calls.
 *
 * What Stripe gives you that a bank transfer cannot: cards, Apple Pay, Google
 * Pay, SEPA debit, a checkout page that converts, and instant confirmation.
 *
 * What it does not give you: payouts to arbitrary customer bank accounts.
 * Sending money *out* to users needs Stripe Connect, with each user onboarded
 * as a connected account. Until that exists, run payouts through a different
 * provider — see PAYOUT_PROVIDER in payments.js.
 *
 * Configure with:
 *   STRIPE_SECRET_KEY       sk_test_… or sk_live_…
 *   STRIPE_WEBHOOK_SECRET   whsec_… from the webhook endpoint
 *   STRIPE_CURRENCY         defaults to eur
 *   PUBLIC_BASE_URL         where Stripe should send the user back to
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../errors.js';

const API = 'https://api.stripe.com';
/** Reject signatures older than this, so a captured webhook cannot be replayed. */
const TOLERANCE_SECONDS = 300;

export const stripeConfig = () => ({
  secretKey: process.env.STRIPE_SECRET_KEY || '',
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  currency: (process.env.STRIPE_CURRENCY || 'eur').toLowerCase(),
  baseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:4173').replace(/\/$/, ''),
});

/**
 * Stripe takes form-encoded bodies with bracketed nesting:
 *   line_items[0][price_data][currency]=eur
 */
export function formEncode(value, prefix = '', out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) => formEncode(item, `${prefix}[${i}]`, out));
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      formEncode(item, prefix ? `${prefix}[${key}]` : key, out);
    }
  } else {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }
  return out;
}

async function call(config, path, { method = 'POST', body, fetchImpl = fetch } = {}) {
  if (!config.secretKey) throw new HttpError(501, 'Stripe is not configured. Set STRIPE_SECRET_KEY.');
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body ? formEncode(body).join('&') : undefined,
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new HttpError(502, `Stripe: ${payload?.error?.message ?? `HTTP ${res.status}`}`);
  }
  return payload;
}

/** Money in the smallest unit. Stripe counts in cents, we count in units. */
const toMinorUnits = (amount) => Math.round(amount * 100);
const fromMinorUnits = (amount) => Math.round(amount) / 100;

export const stripeProvider = {
  name: 'stripe',

  /** A hosted Checkout session. Stripe handles the card form and 3-D Secure. */
  async createCheckout({ reference, amount, user, fetchImpl = fetch }) {
    const config = stripeConfig();
    const session = await call(config, '/v1/checkout/sessions', {
      fetchImpl,
      body: {
        mode: 'payment',
        success_url: `${config.baseUrl}/#/wallet?deposit=success`,
        cancel_url: `${config.baseUrl}/#/wallet?deposit=cancelled`,
        // Both of these come back on the webhook; either identifies the payment.
        client_reference_id: reference,
        metadata: { reference },
        payment_intent_data: { metadata: { reference } },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: config.currency,
              unit_amount: toMinorUnits(amount),
              product_data: { name: 'Account deposit' },
            },
          },
        ],
        ...(user?.email ? { customer_email: user.email } : {}),
      },
    });
    return { checkoutUrl: session.url, providerRef: session.id };
  },

  /**
   * Stripe signs with HMAC-SHA256 over `${timestamp}.${rawBody}`, sent as
   * `Stripe-Signature: t=…,v1=…`. The timestamp is checked too, otherwise a
   * captured request could be replayed forever.
   */
  verify(rawBody, signature, { now = Date.now() } = {}) {
    const { webhookSecret } = stripeConfig();
    if (!webhookSecret || !signature) return false;

    const parts = Object.fromEntries(
      String(signature)
        .split(',')
        .map((part) => part.split('=', 2))
        .filter((pair) => pair.length === 2),
    );
    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp)) return false;
    if (Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) return false;

    const expected = createHmac('sha256', webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');
    const provided = String(parts.v1 ?? '');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  },

  /** Map a Stripe event onto the deposit outcome the ledger cares about. */
  parseWebhook(event) {
    const object = event?.data?.object ?? {};
    const reference = object.client_reference_id || object.metadata?.reference || null;
    switch (event?.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        if (object.payment_status && object.payment_status !== 'paid') return null;
        return {
          reference,
          // Trust Stripe's figure over ours: currency conversion, tax or a
          // discount can all move it.
          receivedAmount: object.amount_total != null ? fromMinorUnits(object.amount_total) : null,
        };
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed':
      case 'payment_intent.payment_failed':
        return { reference, failed: true };
      default:
        return null; // Everything else is noise we acknowledge and ignore.
    }
  },

  /**
   * Deliberately not implemented. Paying users out through Stripe means
   * Stripe Connect: every user becomes a connected account with its own
   * onboarding and identity verification. That is a product decision, not a
   * missing function, so it fails loudly rather than pretending.
   */
  async payout() {
    throw new HttpError(
      501,
      'Stripe cannot pay out to customer bank accounts without Connect onboarding. Set PAYOUT_PROVIDER=wise to send payouts through Wise.',
    );
  },
};
