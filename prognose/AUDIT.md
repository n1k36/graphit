# Tell — codebase audit and production readiness

**Date:** 10 August 2026 · **Scope:** full repository · **Branch:** `claude/prognose-polymarket-app-s8c56z`

---

## Three corrections to the brief

The brief assumed a stack this repository does not have. Rather than pretend otherwise:

| Brief assumed | Reality | What I did |
|---|---|---|
| Smart contract integration | No blockchain. A centralised SQLite double-entry ledger. | Audited the ledger instead: conservation, idempotency, race windows. |
| React, TypeScript, React Query, Vercel | Vanilla JS, zero dependencies, no build step, no TS. | Delivered the *intent* — push-based updates, error boundaries, fallback states — natively. Rewriting a working, 80-test system into React was not justified. |
| Order books and depth charts | An LMSR automated market maker. There is no book. | Built the honest equivalent: a **depth curve** of average fill price against order size. |

---

## A. Executive summary

The application is **feature-complete for a play-money launch and not deployed**. The trading engine, ledger, payment rails and admin tooling are production-shaped; the gaps are operational and legal rather than architectural.

| | |
|---|---|
| Source | 10,125 lines across 24 files |
| Dependencies | **0** — runtime and dev |
| Tests | **80 passing** |
| Static checks | Parse, SQL-injection, secret-scan, XSS — all clean |
| Commits this audit | 3 |
| Defects found | **11** (5 correctness, 3 performance, 3 hardening) — all fixed |

The single most serious finding: **creating a market from the UI had been broken for three commits.** The form read its limits from the top level of `/api/config` after those keys moved under `settings`, so it posted `subsidy: NaN` and every submission failed with a 400. No test covered the contract between the config endpoint and the form. There is one now.

---

## B. Features implemented — working vs. fixed

### Was already working
- **LMSR market maker** — binary and up to 8 outcomes, prices summing to 1, bounded maker loss, no-arbitrage complete sets.
- **Trading** — buy by budget, sell by size, server-side slippage guard, cost-basis and realised/unrealised P&L.
- **Settlement** — $1.00 per winning share, cancellation with mark-to-market refunds, creator subsidy return.
- **Ledger** — every balance change writes a row; treasury, statements and revenue reporting are queries over that one table.
- **Payments** — Stripe (hosted checkout), Wise (bank transfer + statement reconciliation), sandbox provider; withdrawal approval queue.
- **Retention** — streaks, XP and levels, achievements, notifications, referrals, hot markets.
- **PWA** — installable, offline shell, generated icons.

### Fixed in this audit

| # | Severity | Defect |
|---|---|---|
| 1 | **Critical** | Market creation returned 400 for every UI submission — config shape mismatch sending `subsidy: NaN`. |
| 2 | **High** | `CONFIG.sessionDays` was declared and never read. **Sessions never expired**; a leaked token was valid forever. |
| 3 | **High** | Approving a withdrawal called the payment provider *before* recording anything. A crash mid-payout left the row `pending` and re-payable. |
| 4 | **High** | No `busy_timeout`. A second concurrent writer failed instantly with `SQLITE_BUSY` rather than waiting. |
| 5 | **Medium** | The 24-hour deposit cap was checked outside the write transaction — two concurrent requests could both pass it. |
| 6 | **Medium** | The entire write path (trading, market creation, comments, deposits, withdrawals) had **no rate limiting**. Only auth did. |
| 7 | **Medium** | Leaderboard issued ~4 SQL statements *per user*. Fine at 5 accounts, fatal at 10,000. |
| 8 | **Medium** | `listMarkets` ran a creator lookup and a sparkline query per row (N+1 twice over). |
| 9 | **Low** | Missing indexes on `positions(market_id)`, `markets(creator_id)`, `sessions(created_at)`, `payment_intents(user_id, status)`. |
| 10 | **Low** | `featured` was write-only — the admin endpoint toggled a column nothing read. |
| 11 | **Low** | Dead config: `BRAND.currency`, `BRAND.symbol` referenced nowhere. |

### Measured impact

```
leaderboard    18 statements  →  5     (now constant, not per-user)
listMarkets   ~20 statements  →  4
polling loops           3     →  0     (replaced by one SSE stream)
```

### Audited and found clean
- **SQL injection** — every statement parameterised. The one interpolation (`PRAGMA table_info`) takes no bound parameters and receives only hardcoded identifiers; annotated and allow-listed at the call site.
- **XSS** — all user text passes through `esc()`. Verified with a paren-walking context analysis, not a naive grep.
- **CSRF** — not applicable; bearer tokens in headers, no cookie auth.
- **Path traversal** — static serving is confined to `public/`.
- **Money conservation** — asserted across the whole database after the full suite runs.

---

## C. UI/UX and architectural improvements

### Benchmarked against Polymarket and Kalshi

The gap was not aesthetic. It was that **the market page was the only place you could open a position**, putting a navigation between seeing a price and acting on it. Polymarket puts Yes/No on the card and keeps the market page for research.

- **One-tap betting from the list.** Binary markets show both outcomes with live prices on the card. Tapping opens a sheet with an outcome toggle, amount chips, and — in the largest type on screen — *"$25.34 to win if Yes"*. That is the number people decide on, not the share count. Confirm keeps you where you were.
- **Holdings visible everywhere.** Cards you hold carry *"You hold 59 Yes — worth $27.72"*, so a position is not hidden behind the portfolio tab.
- **Biggest positions** per market: who is on each side, at what size, and how they are doing.
- **Winners in the ticker.** Settlements broadcast their top winner — the most persuasive thing on the platform.
- **Depth curve** — average fill price against order size, the AMM equivalent of book depth. A flat line is deep liquidity; steep means your own order moves the price.

### Real-time architecture

Three independent polling loops (12s / 20s / 30s) were replaced with a **single server-sent-events stream**. SSE rather than WebSockets because every event travels server → client, it is plain HTTP so it survives proxies without an upgrade handshake, browsers reconnect natively, and it needs no dependency.

- Business logic publishes to an in-process bus and knows nothing about transport.
- Events are published **after commit**, so nobody is told about a trade that rolled back.
- Prices update in place with a directional flash; the market page coalesces a refetch 1.2s after a burst.
- Connection state is visible in the ticker (LIVE / CONNECTING / OFFLINE) with exponential backoff.
- Polling survives only as a fallback for a dropped stream.

*Verified:* a trade in one browser tab moved the price in a second tab from **37% → 72%** with no interaction.

### Error handling and edge cases

- Failed views render a recovery state that distinguishes **offline** from **failed**, with a retry button.
- `online` / `offline` / `visibilitychange` all trigger reconnection.
- Offline dims live prices so stale numbers are not read as current.
- Insufficient funds, closed markets, self-exclusion and slippage all return specific, actionable messages.

---

## D. Remaining technical debt

Ordered by what should block a launch.

**Blocking a public launch**
1. ~~No moderation.~~ **Shipped** — see the moderation section below.
2. **Not deployed.** Config is ready (`Dockerfile`, `fly.toml`, `render.yaml`); nothing is running.

**Blocking real money** *(all non-code)*
3. A licence in every market served. A Wyoming LLC authorises nothing here.
4. KYC/AML with sanctions screening.
5. Written approval from the payment processor — Stripe and Wise both restrict gambling.

**Should fix soon**
6. No password reset or email verification.
7. **SQLite is single-writer.** Correct under concurrency, but caps you at one node. Postgres is the migration when traffic demands it, not before.
8. Money is `REAL` rounded to 4dp. Conserved and tested, but integer minor units are the stricter choice.
9. No structured request logging or error tracking.
10. Settlement is unilateral — no dispute process.

**Nice to have**
11. Event grouping (several markets under one event) — Polymarket's main remaining structural advantage.
12. Market search is `LIKE`; SQLite FTS5 would be better past a few thousand markets.

---

## F. Moderation

Shipped after the audit, since it was the one thing blocking public signups.

**Two rules shape it.** Nothing is deleted outright — a market holds other people's money, so a bad one is *hidden and frozen*, and an admin still has to settle or cancel it so positions resolve. And every action is recorded against the report that prompted it, with who acted and when, so moderation is auditable rather than a series of silent disappearances.

| Capability | Behaviour |
|---|---|
| **Report** | Any signed-in user, on a market or a comment, with 8 reasons. Reporting twice is absorbed, not an error. Rate limited to 20/minute. |
| **Queue** | Admin-only, at `#/moderation`. Shows the target text, its author, the reporter's note, and how many distinct people flagged it. |
| **Hide market** | Vanishes from every listing and freezes trading; existing positions still settle. Reversible. |
| **Remove comment** | Soft delete leaving a tombstone, so threads stay readable. |
| **Suspend author** | Blocks trading, commenting and market creation for a bounded period. Admins cannot be suspended through this route. |
| **Sweep** | One decision closes every open report about the same target. |

Suspended users see a banner explaining the block and its expiry, and can still read and withdraw.

Covered by 10 tests in `test/moderation.test.js`.

---

## E. Deployment

### Verify before shipping
```bash
npm run verify     # static checks + 80 tests
```

### Deploy
```bash
docker build -t tell .
docker run -p 4173:4173 -v tell-data:/app/data tell
```

`fly.toml` and `render.yaml` are in the repo. Both mount a volume at `/app/data` and health-check `/healthz`.

**One instance only.** SQLite is single-writer; scale up, never out. `min_machines_running = 1` — a stopped machine drops live stream clients.

### Environment
Copy `.env.example`. There are **no public keys**: the browser bundle contains no configuration and reads everything from `/api/config` at runtime. Every variable is a secret.

The server **refuses to boot** on an incomplete payment configuration — a live Stripe key with a non-HTTPS `PUBLIC_BASE_URL` is a hard failure, not a warning.

### Operational surface
| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness + database reachability + stream client count |
| `GET /api/stream` | SSE feed |
| `POST /api/payments/webhook` | Provider callbacks — signature-verified, idempotent |

Sends `SIGTERM` → drains in-flight requests, closes streams, 10s cap. Sessions are swept on boot and daily.

### Response headers
CSP (`script-src 'self'`, no third-party origins), `nosniff`, `X-Frame-Options: DENY`, referrer and permissions policies on every response; HSTS added when `x-forwarded-proto` is https.

### First-run checklist
1. `PAYMENTS_PROVIDER=mock`, deploy, confirm `/healthz`.
2. Set `PUBLIC_BASE_URL` to the real https origin.
3. Sign in as `demo` / `demo123` → **change that password immediately**.
4. Set `welcomeBonus` in Control room → Economics before anyone can cash out.
5. Add moderation before opening signups.
