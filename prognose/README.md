# Prophit

**Wette auf alles.** A prediction market platform: create markets on any question,
trade shares in the outcomes, settle them when the answer is known. Prices *are*
probabilities — a share trading at 63¢ means the market thinks that outcome is
63% likely, and it pays $1.00 if it happens.

Built with **zero dependencies**: Node's built-in HTTP server and `node:sqlite` on
the back end, vanilla JavaScript on the front. No build step, no bundler, no
`node_modules`.

```bash
git clone -b claude/prognose-polymarket-app-s8c56z https://github.com/n1k36/graphit.git
cd graphit/prognose
npm start          # http://localhost:4173
```

Nothing to install — `npm install` has nothing to do, because there are no
dependencies. You need Node 22.5 or newer.

The first run seeds a demo database. Sign in as **`demo` / `demo123`** (an admin,
so the control room is visible), or create an account.

```bash
npm test           # 79 tests: LMSR maths, API, payments, providers, engagement
npm run dev        # restart on file changes
npm run seed       # seed a database without starting the server
```

The name lives in one place (`BRAND` in `server/db.js`, or the `BRAND_NAME`
environment variable) — renaming the whole product is a one-line change.

---

## 1. How you make money

Three revenue levers, all tunable at runtime from **Control room → Economics**
without a restart or a deploy. Changes apply to the very next trade.

| Lever | Default | What it does |
|---|---|---|
| `platformFeeRate` | 0.60% | Your cut of every trade's notional |
| `creatorFeeRate` | 0.40% | Paid to whoever created the market |
| `listingFee` | $0 | One-off charge to open a market |
| `withdrawalFeeRate` / `withdrawalFeeFlat` | 0% / $0 | Charged when cash leaves |

The default total is a **1% trade fee split 60/40** between the house and the
market creator. That split is deliberate: paying creators is what makes people
open markets on everything, which is the only way a "bet on anything" platform
gets to the size of Polymarket or Kalshi. You keep the majority and it costs you
nothing up front — creators are also the ones who post the liquidity subsidy.

The admin panel shows what any setting is worth before you save it:

> Total fee **1.00%** per trade — house keeps **0.60%**, creators get **0.40%**.
> At yesterday's $715 of volume that is **$4.29** to the treasury per day, about
> **$1,566** a year.

**Every cent is traceable.** The treasury is not a number in a column, it is
`SUM(amount) WHERE account = 'platform'` over the ledger. Revenue by source,
revenue by day and total liabilities to traders are all queries over the same
table.

## 2. The payment system

Money moves through a **single ledger table**, and nothing changes a balance
without writing a row to it. That makes the wallet statement, the treasury and
the revenue dashboard three views of one source of truth.

Balances are split in two, the way every real betting platform does it:

- **cash** — from deposits and winnings. Withdrawable.
- **bonus** — welcome, streak and referral credit. Playable, not withdrawable.

Bonus credit is always spent before cash, and cash only unlocks once bonus money
has been turned over (`wageringMultiplier`, 1× by default). Without that rule,
"sign up, get $1,000, cash out" is free money.

**Deposits** go through a provider adapter (`server/payments.js`):

```
createDeposit → provider.createCheckout → user pays → webhook → settleDeposit
```

`settleDeposit` is **idempotent by payment reference** — a webhook replayed ten
times credits the account exactly once (there is a test for this). Webhooks are
HMAC signature-verified; unsigned ones are rejected with a 401.

The bundled default is a **mock/sandbox** provider: a checkout page inside the
app, no real money. Working **Stripe** and **Wise Business** providers ship
alongside it. Swapping is one env var; nothing else in the codebase changes.

Deposits and payouts can use *different* providers, because most rails are good
at one direction only:

```
PAYMENTS_PROVIDER=stripe   # cards, Apple Pay, instant confirmation
PAYOUT_PROVIDER=wise       # actually sends money to a customer's IBAN
```

### The Stripe provider

`PAYMENTS_PROVIDER=stripe`. Hosted Checkout, so Stripe owns the card form, 3-D
Secure and PCI scope. Talks to the REST API with `fetch` and form encoding, so
the zero-dependency rule survives — the official SDK is a wrapper over exactly
these calls.

Webhooks are verified the way Stripe specifies: HMAC-SHA256 over
`${timestamp}.${rawBody}`, compared in constant time, **and the timestamp is
checked** against a 5-minute window so a captured webhook cannot be replayed
later. The amount credited is Stripe's `amount_total`, not the amount requested,
because currency conversion and discounts move it.

Stripe **cannot pay customers out** without Connect — every user would need to
be onboarded as a connected account with its own identity verification. Rather
than fake that, `payout()` throws a 501 that names the fix. Pair it with
`PAYOUT_PROVIDER=wise`.

| Variable | Meaning |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` or `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the webhook endpoint |
| `STRIPE_CURRENCY` | defaults to `eur` |
| `PUBLIC_BASE_URL` | where Stripe returns the user afterwards |

> **The same caveat as every processor.** Stripe's restricted-business rules
> cover gambling and betting: real-money wagering needs prior written approval
> from Stripe *and* the licences for each market you serve. This is not Stripe
> being awkward — it flows from the card networks' rules for the gambling
> merchant category, which is why Wise, PayPal and everyone else say the same
> thing. Shopping for a friendlier processor is not the fix; being licensed, or
> not taking real-money bets, is.
>
> Stripe is entirely usable **today** for a play-money build: subscriptions,
> cosmetic upgrades, boosted market listings. That is ordinary commerce, and it
> uses this exact code path.

### The Wise provider

`PAYMENTS_PROVIDER=wise`. Two properties of Wise shape the whole integration:

**Wise is not a card acquirer.** There is no hosted checkout and no "pay by
card". Money only arrives as a bank transfer, so `createCheckout` returns an
in-app page with your account details and a unique **payment reference**, and
the deposit stays pending until the money lands.

**Bank credits carry free text, not our payment id.** Wise's `balances#credit`
webhook says only "a credit arrived" — it has no reference in it. So the webhook
triggers *reconciliation*: pull the account statement, look for each pending
deposit's reference inside the entries, and settle the ones that match.
References are compared with all punctuation stripped, so `DEP 4CD0 0546` still
matches `dep_4cd00546` when the payer retypes it by hand.

Because a webhook can be missed entirely, reconciliation also runs on demand
from **Control room → Bank reconciliation**, and is safe to put on a timer: it
is idempotent, and a credit already booked is skipped. A missed webhook must
never mean a customer's money disappears.

Whatever the payer actually sent is what gets credited — ask for €200, send
€173.45, and €173.45 is what lands, with the stored intent corrected to match.

Payouts walk Wise's quote → recipient → transfer → fund sequence, including the
strong-customer-authentication handshake (Wise answers 403 with a one-time token
that must be signed with your private key and replayed). Each withdrawal sends a
`customerTransactionId` derived from its row id, so a retried approval cannot pay
out twice.

| Variable | Meaning |
|---|---|
| `WISE_API_TOKEN` | API token (Wise → Settings → API tokens) |
| `WISE_PROFILE_ID` | Your business profile id |
| `WISE_ENV` | `sandbox` (default) or `live` |
| `WISE_CURRENCY` | Balance to watch, e.g. `EUR` |
| `WISE_PUBLIC_KEY` | Wise's webhook public key, for signature checks |
| `WISE_PRIVATE_KEY` | Your SCA private key, needed to fund payouts |
| `WISE_ACCOUNT_HOLDER` / `_IBAN` / `_BIC` / `_BANK` | Shown to payers |

> **Before you rely on this:** Wise's acceptable use policy does not permit
> gambling or betting businesses, and Wise Business is not a merchant acquirer —
> it cannot take card payments at all. Get written confirmation from Wise about
> your specific use case before building on it. The code is sound; the account
> relationship is the risk.

**Withdrawals** debit immediately (so the money cannot be spent while pending),
then wait in an admin approval queue. Approving calls the provider payout;
rejecting refunds the user in full, fee included.

> Real-money prediction markets are a licensed activity — Kalshi is a
> CFTC-regulated exchange, Polymarket was fenced out of the US for years. The
> payment rails here are built properly but deliberately ship pointed at a
> sandbox. Wiring a live provider is the easy part; the licence is not.

## 3. Why people come back

| | |
|---|---|
| **Live ticker** | Every trade on the platform scrolls across the top, refreshed every 12s. The place always looks busy. |
| **Daily bonus + streak** | Escalating reward, `dailyBonusBase × streak` capped at `dailyBonusMax`. Miss a day and the streak resets. |
| **XP and levels** | One XP per dollar traded, eight tiers from Rookie to Legend. Level chip sits in the nav next to the balance. |
| **Achievements** | Eight unlockables — first trade, first win, whale, week-long streak — with a confetti burst when they land. |
| **Notifications** | Bell with unread count. Settlement tells you what you won or lost, and winning fires confetti. |
| **Referrals** | Personal invite link; both sides get `referralBonus` in credit. |
| **🔥 Hot markets** | Ranked by 24h volume, badged on the card, with a dedicated sort. |
| **Urgency** | Closing markets switch to an amber countdown as the deadline nears. |
| **Hero** | Live platform stats and a "claim your free credit" call to action for signed-out visitors. |

Every one of these is a real, checkable feature — the numbers come from the
database, not from decoration.

**Play limits are in the same layer on purpose.** Users can set a 24-hour deposit
cap and self-exclude for a fixed period; excluded accounts cannot trade, deposit
or claim bonuses. Every licensing regime requires this, so building it in now
costs nothing and skipping it would block the licence later.

## 4. The market maker

There is no order book. Every market is an **LMSR** (Hanson's Logarithmic Market
Scoring Rule) automated market maker, so there is always a price and always
liquidity — you never need a counterparty.

```
C(q) = b · ln( Σᵢ exp(qᵢ / b) )        cost function
pᵢ   = exp(qᵢ/b) / Σⱼ exp(qⱼ/b)        price of outcome i
```

Buying `d` shares of outcome `i` costs `C(q + d·eᵢ) − C(q)`; selling is the same
with a negative `d`. Properties, each covered by a test in `test/lmsr.test.js`:

- Prices always sum to exactly 1, so they read directly as probabilities.
- Buying pushes a price up and the others down, with slippage that grows with
  order size relative to `b`.
- A share never costs more than the $1.00 it can pay out.
- Buying one share of *every* outcome costs exactly $1.00 — no arbitrage.
- The market maker's worst-case loss is bounded by `b · ln(n)`.

That bound is why opening a market costs something: the creator posts a
**subsidy** equal to `b · ln(n)`, the most the AMM can ever lose. At settlement
they get it back plus whatever the AMM earned or lost. More subsidy means deeper
liquidity and less price impact per dollar.

## 5. Correctness

**Money is conserved, and it is asserted.** After the entire test suite has run,
one test sums every user balance, every open position marked to market, every
AMM's equity and the treasury, and checks the total equals bonuses issued plus
deposits minus withdrawals. If any code path ever created or destroyed a cent,
that test fails.

Other things the 79 tests pin down: idempotent deposits, signature-checked
webhooks, the fee split matching the configured rates, withdrawal holds and
refunds, wagering gates, streak progression, referral payouts, self-exclusion
blocking trades, admin-only access, and the LMSR invariants above.

Other design notes:

- **Positions are long-only.** You cannot short an outcome; you buy the opposite
  one, which is equivalent and keeps every position collateralised.
- **Trades are priced twice.** The browser mirrors the LMSR maths so previews are
  instant, but the server always recomputes the fill and is the only authority.
  The client sends its expected price with a slippage tolerance (3% default) and
  the server rejects the trade with a 409 if the market moved.
- **Security.** scrypt password hashing with per-user salts and constant-time
  comparison; opaque 256-bit bearer tokens; parameterised SQL everywhere; all
  user text escaped before it reaches the DOM; static serving confined to
  `public/`; 256 KB body cap; rate-limited auth endpoints.

## 6. Layout

```
prognose/
├── server/
│   ├── lmsr.js        pure market-maker maths, no I/O
│   ├── db.js          schema, settings, brand, transactions
│   ├── ledger.js      every movement of money
│   ├── payments.js    provider adapters, deposits, withdrawals
│   ├── engagement.js  levels, streaks, achievements, notifications, limits
│   ├── auth.js        password hashing and sessions
│   ├── logic.js       markets, trading, settlement, portfolio
│   ├── api.js         routing and request handling
│   ├── server.js      HTTP server and static files
│   └── seed.js        demo users, markets, trades, deposits
├── public/            index.html · app.js · styles.css  (no build step)
└── test/              lmsr.test.js · api.test.js
```

## 7. Running it somewhere other than your laptop

**On your phone, same Wi-Fi.** The server binds every interface, so
`http://<your-computer-ip>:4173` works from a phone on the same network. Good
enough to feel the UI; note that iOS only registers a service worker on a secure
origin, so installing to the home screen properly needs HTTPS.

**Docker**, anywhere that runs containers:

```bash
docker build -t prophit .
docker run -p 4173:4173 -v prophit-data:/app/data prophit
```

The SQLite file lives in the mounted volume, so redeploys keep the data. Any
host that takes a Dockerfile (Fly.io, Render, Railway, a plain VPS) will run it
as-is. Set `PAYMENTS_WEBHOOK_SECRET` to something real before exposing it, and
put it behind HTTPS — which every one of those hosts terminates for you.

## 8. Installing it as an app

The app ships as an installable PWA: web manifest, service worker, generated
icons, standalone display and notch-safe layout.

- **iPhone/iPad** — open it in Safari, tap Share → *Add to Home Screen*. It gets
  its own icon, launches without browser chrome, and the app shell still opens
  offline. Requires HTTPS.
- **Android / desktop Chrome** — an **⤓ Install** button appears in the nav.
- Icons are generated by `node tools/make-icons.mjs`, which draws them from
  scratch with a hand-rolled PNG encoder. No design tool or image library.

Prices, balances and positions are never cached — only the shell is. A stale
price is a wrong price.

### Going further: the App Store

A home-screen PWA needs no Apple account and no review. Getting into the App
Store proper is a different matter, and the rules are stricter for this category
than for most apps:

- You need the Apple Developer Program (99 USD/year) and a native shell.
  Capacitor wraps this codebase without a rewrite.
- **App Review Guideline 4.2** rejects apps that are only a website in a
  wrapper. A shell needs real native surface — push notifications for
  settlements, Face ID on the wallet, widgets, share sheets.
- **Guideline 5.3.4**: real-money gaming apps must be submitted by the licensed
  operator, must be geo-restricted to the territories the licence covers, and
  must be free to download. Apple checks the licence.
- Play-money only is a much easier review, and worth shipping first.

## 9. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4173` | HTTP port |
| `PROGNOSE_DB` | `data/prognose.db` | SQLite file, or `:memory:` |
| `BRAND_NAME` / `BRAND_TAGLINE` | Prophit / Wette auf alles. | Product name |
| `PAYMENTS_PROVIDER` | `mock` | `mock`, `stripe` or `wise` — handles deposits |
| `PAYOUT_PROVIDER` | falls back to `PAYMENTS_PROVIDER` | Provider that sends money out |
| `PAYMENTS_WEBHOOK_SECRET` | `dev-webhook-secret` | HMAC key for webhooks |
| `PROGNOSE_AUTH_LIMIT` | 10 signups / 20 logins per minute | Per-IP auth rate limit |

Economic settings live in the `settings` table, editable from the admin panel;
`DEFAULT_SETTINGS` in `server/db.js` holds the starting values.

## 10. What real money would still need

The trading engine, ledger and payment flow are production-shaped. Before taking
real deposits you would need, roughly in order: a licence in each market you
serve, KYC/AML with sanctions screening, a live payment provider and a real
custody account, Postgres instead of SQLite (SQLite serialises writes — correct
under concurrency, but single-node), session expiry and password reset, and
audited settlement with a dispute process. The demo also hands every new account
a $1,000 welcome bonus; set `welcomeBonus` to something sane before anyone can
cash out.
