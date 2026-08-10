# Harness and eval lab

The test suite answers *"is this function correct?"*. This answers three
questions it cannot:

1. **Does the product work end to end?** — money in, bet placed, market settled,
   winnings out, bad market pulled.
2. **Does the price tell the truth?** — the only question a prediction market
   actually has to answer.
3. **What breaks first when people show up?** — tail latency and the write
   ceiling of a single SQLite node.

```bash
npm run harness        # everything: api, eval, load, e2e
npm run eval           # just the market-maker eval lab
npm run load           # just the load run
npm run e2e            # just the browser flows
npm run sweep          # how much liquidity should a market carry?
```

Every suite boots **its own server on an ephemeral port with its own
database**. Nothing here talks to a server you started by hand. That is not
fastidiousness: during development a stale process holding the usual port
served old code to three separate runs, and all three looked green. You cannot
collide with a port you did not choose.

---

## `api` — user journeys

`harness/api/journeys.mjs` walks the paths a real person walks, over HTTP,
against the seeded demo book. Each step is checked against a *business*
outcome rather than a status code, because a 200 that quietly does nothing is
the failure worth catching:

- a deposit lands in withdrawable cash, and the welcome bonus does not
- the quote a user is shown matches the fill they get
- a bet appears on the market card, not only in the portfolio
- buying and immediately selling costs the fee and nothing more
- winners are paid exactly $1.00 per share, and a settled market stops trading
- the wagering requirement blocks an early cash-out, and clearing it unblocks
- a report reaches the admin queue, a hidden market vanishes and freezes
- a signed-out visitor can still browse

## `eval` — does the price find the truth?

`harness/eval/market-maker.mjs` is the part that is not a test.

Hundreds of markets are created, each with a **hidden true probability**.
Simulated traders — informed, casual and pure noise, in fixed proportions —
see that probability through their own noise, and buy until the price has
moved most of the way towards what they believe. Then every market settles
against a coin weighted by the hidden truth, and the closing prices are
graded.

It runs the real engine in process: `logic.executeTrade`, the real ledger, the
real fee split. A calibration figure produced by a reimplementation of LMSR
would prove nothing about the app.

What it reports:

| Section | Question |
|---|---|
| Price discovery | How much of the initial error does trading remove? |
| Calibration | When the price says 70%, does it happen 70% of the time? |
| Market maker risk | Did any market breach the `b·ln(n)` loss bound? |
| Fee capture | Does the realised take rate match the configured fee? |
| Money conservation | Do the books still balance afterwards? |
| Liquidity and price impact | What does a $25 / $100 / $500 order do, by subsidy? |

**Calibration is judged against an oracle**, not against zero. An oracle that
prices every market at its exact true probability and settles on the same coin
flips is perfectly calibrated by construction, so whatever error it still
shows on the same sample is sampling noise. That is the floor the market is
held to. Without it a well-behaved market on 300 samples looks 5pp off and you
go hunting for a bug that is not there.

Runs are seeded (`--seed N`), so a failure replays exactly.

## `load` — where the ceiling is

`harness/eval/load.mjs` drives concurrent virtual users at a real server over a
real file-backed database in WAL mode, with the app's own read/write mix. It
reports p50/p95/p99 per endpoint — nobody experiences the average — and then
adds up every balance in the database. Throughput that loses money is not
throughput.

The deposit and market limits are left at their product defaults on purpose. A
harness that raises the limits it is meant to exercise is measuring a system
nobody ships.

## `e2e` — the browser, optionally

`harness/e2e/browser.mjs` needs Playwright, and **never installs it**. The zero
dependency promise is worth keeping, so if Playwright is not there this layer
reports itself skipped and the rest carries on. It is found either as a local
devDependency or as a global install.

```bash
npm i -D playwright && npx playwright install chromium
npm run e2e -- --headed
```

It checks two things nothing at the API level can reach: that the page renders
at all, and that **a trade made outside the browser moves the price in an open
tab with no reload** — the live stream, end to end, through the real client.

> Never wait on `networkidle`. The app holds an SSE connection open forever, so
> that wait never resolves. Use `domcontentloaded`.

---

## Options

```
--seed N          reseed the simulations
--markets N       markets per eval run
--concurrency N   virtual users in the load run
--seconds N       how long to sustain the load
--json FILE       write the full report as JSON as well as printing it
--headed          show the browser during the e2e layer
```

Exit code is 0 only if every check in every selected suite passed, so this
drops into CI unchanged.
