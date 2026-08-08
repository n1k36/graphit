# Prognose

A Polymarket-style prediction market app: create markets on any question, trade
shares in the outcomes with play money, and settle them when the answer is known.
Prices *are* probabilities — a share trading at 63¢ means the market thinks that
outcome is 63% likely, and it pays $1.00 if it happens.

Built with **zero dependencies**: Node's built-in HTTP server and `node:sqlite` on
the back end, vanilla JavaScript on the front. No build step, no bundler, no
`node_modules`.

```bash
cd prognose
npm start          # http://localhost:4173
```

The first run seeds a demo database. Sign in as **`demo` / `demo123`**, or create
an account — every account starts with $1,000 in play money.

```bash
npm test           # 37 tests: LMSR maths + full API integration
npm run dev        # restart on file changes
npm run seed       # seed a database without starting the server
```

## How the market maker works

There is no order book. Every market is an **LMSR** (Hanson's Logarithmic Market
Scoring Rule) automated market maker, so there is always a price and always
liquidity — you never need a counterparty.

A market over `n` outcomes tracks the shares sold of each outcome, `q`, and a
liquidity parameter `b`:

```
C(q) = b · ln( Σᵢ exp(qᵢ / b) )        cost function
pᵢ   = exp(qᵢ/b) / Σⱼ exp(qⱼ/b)        price of outcome i
```

Buying `d` shares of outcome `i` costs `C(q + d·eᵢ) − C(q)`; selling is the same
with a negative `d`. This gives some useful properties, all covered by tests in
`test/lmsr.test.js`:

- Prices always sum to exactly 1, so they read directly as probabilities.
- Buying pushes a price up and the others down, with slippage that grows as the
  order gets bigger relative to `b`.
- A share never costs more than the $1.00 it can pay out.
- Buying one share of *every* outcome costs exactly $1.00 — no arbitrage.
- The market maker's worst-case loss is bounded by `b · ln(n)`.

That last bound is why creating a market costs something. The creator posts a
**subsidy** equal to `b · ln(n)`, which is the most the market maker can ever
lose. At settlement they get it back, plus whatever the AMM took in and did not
have to pay out. More subsidy means deeper liquidity and less price impact per
dollar traded.

Trading charges a 1% fee, which goes to the market's creator.

## What you can do

| | |
|---|---|
| **Markets** | Binary (Yes/No) or multiple choice, up to 8 outcomes. Categories, search, sorting, filtering by open/closed/settled. |
| **Trading** | Buy with a dollar amount, sell by share count or a percentage of your position. Live preview of shares, average price, fee and payout before you commit. |
| **Charts** | Probability history per outcome, derived from the trade log, with a hover crosshair and 1D/1W/1M/All ranges. |
| **Portfolio** | Open positions marked to market, unrealised and realised P&L, all-time profit, full trade history. |
| **Settlement** | The creator (or an admin) picks the winning outcome; winning shares pay $1.00 each and the rest expire. A market can also be cancelled, refunding holders at the last traded price. |
| **Social** | Comments per market, public trader profiles, and a leaderboard ranked by net worth. |

## Design notes

**Money is conserved.** Every dollar is accounted for at all times: user cash +
open positions marked to market + each AMM's equity (`subsidy + collected −
what it owes holders`) equals exactly `$1,000 × number of accounts`. There is a
test that asserts this over the whole database after the full suite has run.

**Positions are long-only.** You cannot short an outcome; you buy the opposite
outcome instead, which is economically equivalent and keeps every position
collateralised.

**Trades are priced twice.** The browser mirrors the LMSR maths so previews
update instantly with no round trip, but the server always recomputes the fill
and is the only authority. Clients send the price they expected along with a
slippage tolerance (3% by default), and the server rejects the trade with a 409
if someone moved the market in between.

**Cost basis and P&L.** Buying adds to a position's cost basis; selling realises
a proportional share of it. Fully closing a position sweeps any rounding dust
into realised P&L so nothing is stranded. Settlement realises the remainder.

**Security.** Passwords are hashed with scrypt and a per-user salt, and compared
in constant time. Sessions are opaque 256-bit bearer tokens. Every SQL statement
is parameterised, all user text is escaped before it reaches the DOM, static file
serving is confined to `public/`, request bodies are capped at 256 KB, and auth
endpoints are rate limited per IP.

## Layout

```
prognose/
├── server/
│   ├── lmsr.js      pure market-maker maths, no I/O
│   ├── db.js        schema, connection, transaction helper
│   ├── auth.js      password hashing and sessions
│   ├── logic.js     markets, trading, settlement, portfolio
│   ├── api.js       routing and request handling
│   ├── server.js    HTTP server and static files
│   └── seed.js      demo users, markets and trades
├── public/
│   ├── index.html   app shell
│   ├── app.js       SPA: router, views, charts, trade panel
│   └── styles.css
└── test/
    ├── lmsr.test.js maths and invariants
    └── api.test.js  end-to-end API behaviour
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4173` | HTTP port |
| `PROGNOSE_DB` | `data/prognose.db` | SQLite file, or `:memory:` |
| `PROGNOSE_AUTH_LIMIT` | `10` signups / `20` logins per minute | Per-IP auth rate limit |

Economic parameters — starting balance, fee rate, subsidy bounds — live in
`CONFIG` in `server/db.js`.

## Caveats

This is a self-contained demo, not a production trading venue. Play money only.
Sessions never expire, there is no email verification or password reset, and
`node:sqlite` is still marked experimental in Node (hence `--no-warnings` in the
npm scripts). SQLite serialises writes, so a single process handles concurrent
trades correctly, but this would need a real database to scale horizontally.
