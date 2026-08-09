/**
 * Wise Business provider.
 *
 * Two things shape this integration, and both are properties of Wise itself
 * rather than choices made here:
 *
 * 1. Wise is not a card acquirer. There is no hosted checkout and no "pay with
 *    card" button. The only way money arrives is a bank transfer into your Wise
 *    account, so `createCheckout` returns transfer *instructions* rather than a
 *    payment page, and the deposit stays pending until the money lands.
 *
 * 2. Bank credits carry a free-text reference, not our payment id. So deposits
 *    are matched by asking Wise for the account statement and looking for our
 *    reference inside each entry. The webhook only tells us "a credit landed";
 *    reconciliation is what actually identifies it.
 *
 * Because a webhook can be missed entirely, reconciliation is also safe to run
 * on a timer or on demand — it is idempotent, and settleDeposit is the backstop.
 *
 * Configure with:
 *   WISE_API_TOKEN      API token from Wise (Settings → API tokens)
 *   WISE_PROFILE_ID     the business profile id
 *   WISE_ENV            'sandbox' (default) or 'live'
 *   WISE_PUBLIC_KEY     Wise's webhook public key (PEM) for the environment
 *   WISE_PRIVATE_KEY    your SCA private key (PEM), needed to fund payouts
 *   WISE_ACCOUNT_*      the details shown to users paying in
 */
import { createVerify, createSign } from 'node:crypto';
import { HttpError } from '../errors.js';

const LIVE = 'https://api.transferwise.com';
const SANDBOX = 'https://api.sandbox.transferwise.tech';

export const wiseConfig = () => ({
  token: process.env.WISE_API_TOKEN || '',
  profileId: process.env.WISE_PROFILE_ID || '',
  base: (process.env.WISE_ENV || 'sandbox') === 'live' ? LIVE : SANDBOX,
  publicKey: (process.env.WISE_PUBLIC_KEY || '').replace(/\\n/g, '\n'),
  privateKey: (process.env.WISE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  currency: process.env.WISE_CURRENCY || 'EUR',
  account: {
    holder: process.env.WISE_ACCOUNT_HOLDER || '',
    iban: process.env.WISE_ACCOUNT_IBAN || '',
    bic: process.env.WISE_ACCOUNT_BIC || '',
    bank: process.env.WISE_ACCOUNT_BANK || '',
    address: process.env.WISE_ACCOUNT_ADDRESS || '',
  },
});

function requireConfig(config) {
  if (!config.token || !config.profileId) {
    throw new HttpError(501, 'Wise is not configured. Set WISE_API_TOKEN and WISE_PROFILE_ID.');
  }
}

/**
 * Wise API call. `fetchImpl` is injectable so the reconciliation and payout
 * logic can be tested without touching the network.
 */
async function call(config, path, { method = 'GET', body, headers = {}, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${config.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Wise answers privileged calls with 403 plus a one-time token that has to be
  // signed with your SCA private key and replayed. This is the documented
  // strong-customer-authentication handshake.
  const approval = res.headers?.get?.('x-2fa-approval');
  if (res.status === 403 && approval && !headers['x-2fa-approval']) {
    if (!config.privateKey) {
      throw new HttpError(501, 'Wise asked for strong customer authentication but WISE_PRIVATE_KEY is not set.');
    }
    const signer = createSign('RSA-SHA256');
    signer.update(approval);
    const signature = signer.sign(config.privateKey, 'base64');
    return call(config, path, {
      method,
      body,
      fetchImpl,
      headers: { ...headers, 'x-2fa-approval': approval, 'X-Signature': signature },
    });
  }

  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = payload?.errors?.[0]?.message || payload?.error_description || `Wise API ${res.status}`;
    throw new HttpError(res.status === 401 || res.status === 403 ? 502 : 502, `Wise: ${message}`);
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * Deposit reconciliation
 * ------------------------------------------------------------------ */

/** Pull recent statement entries for the balance holding `currency`. */
export async function fetchStatement(config, { days = 7, fetchImpl = fetch } = {}) {
  requireConfig(config);
  const balancesList = await call(config, `/v4/profiles/${config.profileId}/balances?types=STANDARD`, { fetchImpl });
  const balance = balancesList.find((b) => b.currency === config.currency);
  if (!balance) throw new HttpError(502, `Wise: no ${config.currency} balance on that profile.`);

  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  const query =
    `currency=${encodeURIComponent(config.currency)}` +
    `&intervalStart=${start.toISOString()}` +
    `&intervalEnd=${end.toISOString()}` +
    `&type=COMPACT`;
  const statement = await call(
    config,
    `/v1/profiles/${config.profileId}/balance-statements/${balance.id}/statement.json?${query}`,
    { fetchImpl },
  );
  return statement.transactions ?? [];
}

/** Every place Wise might put the payer's reference, flattened to one string. */
export function referenceTextOf(transaction) {
  const details = transaction?.details ?? {};
  return [
    details.paymentReference,
    details.description,
    details.senderName,
    transaction?.referenceNumber,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Credit amount of a statement entry, or null if it is not an incoming credit. */
export function creditAmountOf(transaction) {
  if (transaction?.type !== 'CREDIT') return null;
  const value = transaction?.amount?.value;
  return typeof value === 'number' && value > 0 ? value : null;
}

/**
 * Match pending payment intents against statement entries.
 * Pure function so the matching rules can be tested directly.
 *
 * Returns [{ reference, received, transactionId }].
 */
export function matchDeposits(pendingIntents, transactions) {
  const matches = [];
  const used = new Set();
  for (const intent of pendingIntents) {
    const needle = intent.reference.toLowerCase();
    for (const transaction of transactions) {
      const id = transaction?.referenceNumber ?? JSON.stringify(transaction);
      if (used.has(id)) continue;
      const received = creditAmountOf(transaction);
      if (received === null) continue;
      // Payers mangle references — strip anything non-alphanumeric from both
      // sides so "DEP 4CD0 0546" still matches "dep_4cd00546".
      const haystack = referenceTextOf(transaction).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!haystack.includes(needle.replace(/[^a-z0-9]/g, ''))) continue;
      used.add(id);
      matches.push({ reference: intent.reference, received, transactionId: id });
      break;
    }
  }
  return matches;
}

/* ------------------------------------------------------------------ *
 * The provider
 * ------------------------------------------------------------------ */

export const wiseProvider = {
  name: 'wise',

  /**
   * No hosted checkout exists. We hand back an in-app page showing where to
   * send the money and, crucially, the reference that identifies the payer.
   */
  async createCheckout({ reference, amount }) {
    const config = wiseConfig();
    if (!config.account.iban) {
      throw new HttpError(501, 'Wise deposits need WISE_ACCOUNT_IBAN and friends so users know where to pay.');
    }
    return {
      checkoutUrl: `/transfer?ref=${encodeURIComponent(reference)}&amount=${amount}`,
      providerRef: reference,
    };
  },

  /**
   * Wise signs webhooks with RSA-SHA256 over the raw body, verifiable with the
   * public key it publishes per environment.
   */
  verify(rawBody, signature) {
    const { publicKey } = wiseConfig();
    if (!publicKey || !signature) return false;
    try {
      const verifier = createVerify('RSA-SHA256');
      verifier.update(rawBody);
      return verifier.verify(publicKey, String(signature), 'base64');
    } catch {
      return false;
    }
  },

  /**
   * Wise's credit webhook carries no payment reference, so there is nothing to
   * parse — it can only tell us to go and reconcile against the statement.
   */
  parseWebhook() {
    return { reconcile: true };
  },

  /** Quote → recipient → transfer → fund from the Wise balance. */
  async payout({ amount, destination, currency, fetchImpl = fetch }) {
    const config = wiseConfig();
    requireConfig(config);
    const ccy = currency || config.currency;

    const quote = await call(config, `/v3/profiles/${config.profileId}/quotes`, {
      method: 'POST',
      fetchImpl,
      body: { sourceCurrency: ccy, targetCurrency: ccy, sourceAmount: amount, payOut: 'BANK_TRANSFER' },
    });

    const recipient = await call(config, '/v1/accounts', {
      method: 'POST',
      fetchImpl,
      body: {
        currency: ccy,
        type: 'iban',
        profile: config.profileId,
        accountHolderName: destination.accountHolderName,
        details: { legalType: 'PRIVATE', IBAN: destination.iban },
      },
    });

    const transfer = await call(config, '/v1/transfers', {
      method: 'POST',
      fetchImpl,
      body: {
        targetAccount: recipient.id,
        quoteUuid: quote.id,
        customerTransactionId: destination.idempotencyKey,
        details: { reference: destination.reference?.slice(0, 20) || 'Payout' },
      },
    });

    const funded = await call(config, `/v3/profiles/${config.profileId}/transfers/${transfer.id}/payments`, {
      method: 'POST',
      fetchImpl,
      body: { type: 'BALANCE' },
    });

    if (funded?.status && funded.status !== 'COMPLETED') {
      throw new HttpError(502, `Wise did not fund the transfer: ${funded.status} ${funded.errorCode ?? ''}`.trim());
    }
    return { ok: true, providerRef: String(transfer.id), destination: destination.iban };
  },
};
