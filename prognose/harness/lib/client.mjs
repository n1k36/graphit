/**
 * A thin API client for the harnesses.
 *
 * Deliberately not a test helper: it never asserts and never throws on a 4xx,
 * because a load harness needs to *count* the 429s rather than die on the
 * first one. Callers that want failure to be loud use `client.must(...)`.
 */

export class Client {
  constructor(base, token = null) {
    this.base = base;
    this.token = token;
    this.username = null;
    /** Every request, for latency reporting. */
    this.timings = [];
    this.recordTimings = false;
  }

  /** A second handle on the same server, for a different account. */
  fork(token = null) {
    const client = new Client(this.base, token);
    client.recordTimings = this.recordTimings;
    client.timings = this.timings;
    return client;
  }

  async call(path, { method = 'GET', body, token = this.token, label } = {}) {
    const started = performance.now();
    let status = 0;
    let payload = {};
    let error = null;
    try {
      const res = await fetch(this.base + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      status = res.status;
      payload = await res.json().catch(() => ({}));
    } catch (err) {
      error = err;
    }
    if (this.recordTimings) {
      this.timings.push({
        label: label ?? `${method} ${path.split('?')[0]}`,
        ms: performance.now() - started,
        status,
        failed: !!error,
      });
    }
    if (error) throw error;
    return { status, body: payload, ok: status >= 200 && status < 300 };
  }

  /** Same as `call`, but a non-2xx becomes an exception carrying the message. */
  async must(path, options = {}) {
    const res = await this.call(path, options);
    if (!res.ok) {
      const detail = res.body?.error ?? JSON.stringify(res.body);
      throw new Error(`${options.method ?? 'GET'} ${path} → ${res.status}: ${detail}`);
    }
    return res.body;
  }

  /* ------------------------- common journeys ------------------------- */

  async signup(username, password = 'harness-pass-1') {
    const body = await this.must('/api/auth/signup', { method: 'POST', body: { username, password } });
    this.token = body.token;
    this.username = username;
    return body;
  }

  async login(username, password = 'harness-pass-1') {
    const body = await this.must('/api/auth/login', { method: 'POST', body: { username, password } });
    this.token = body.token;
    this.username = username;
    return body;
  }

  /** Sandbox deposit, start to finish. Only works with PAYMENTS_PROVIDER=mock. */
  async deposit(amount) {
    const intent = await this.must('/api/wallet/deposit', { method: 'POST', body: { amount } });
    return this.must('/api/wallet/deposit/confirm', { method: 'POST', body: { reference: intent.reference } });
  }

  async createMarket(overrides = {}) {
    const body = await this.must('/api/markets', {
      method: 'POST',
      body: {
        question: 'Will the harness finish without a single 500?',
        description: 'Resolves YES if every request in this run returned a status the client expected.',
        category: 'Tech',
        symbol: 'HARN',
        closesAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        subsidy: 200,
        ...overrides,
      },
    });
    return body.market;
  }

  // The labels below are deliberately the route pattern rather than the URL,
  // so latency groups by endpoint instead of scattering across every slug.
  markets(query = '') {
    return this.must(`/api/markets${query}`, { label: 'GET /api/markets' });
  }

  market(slug) {
    return this.must(`/api/markets/${slug}`, { label: 'GET /api/markets/:slug' });
  }

  async quote(slug, input) {
    const body = await this.must(`/api/markets/${slug}/quote`, {
      method: 'POST',
      body: input,
      label: 'POST /api/markets/:slug/quote',
    });
    return body.quote;
  }

  trade(slug, input) {
    return this.call(`/api/markets/${slug}/trade`, { method: 'POST', body: input, label: 'POST /api/markets/:slug/trade' });
  }

  resolve(slug, outcome) {
    return this.must(`/api/markets/${slug}/resolve`, { method: 'POST', body: { outcome } });
  }
}

/** Unique enough that reruns never collide on a taken username. */
export const uniqueName = (prefix = 'h') =>
  `${prefix}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`.slice(0, 20);
