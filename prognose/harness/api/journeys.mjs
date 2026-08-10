/**
 * Journey harness — the paths a real person actually walks.
 *
 * The unit suite proves each function is correct in isolation. This proves the
 * functions add up to a product: money goes in, a bet is placed, a market
 * settles, winnings come back out, and a bad market gets pulled. Every step is
 * checked against a *business* outcome — the balance moved by the right
 * amount, the position shows up on the card — rather than a status code, since
 * a 200 that quietly does nothing is the failure mode worth catching.
 *
 *   node harness/run.mjs api
 */
import { startHarnessServer } from '../lib/server.mjs';
import { Client, uniqueName } from '../lib/client.mjs';
import { Report, num, money, pct } from '../lib/report.mjs';

const near = (a, b, tolerance = 0.02) => Math.abs(a - b) <= tolerance;

export async function runJourneys() {
  const report = new Report('Harness — user journeys', 'end to end over HTTP');
  const harness = await startHarnessServer({
    seed: true,
    env: { PAYMENTS_PROVIDER: 'mock', PROGNOSE_AUTH_LIMIT: '100000' },
  });

  try {
    /* ---------------- 1. Arriving, funding, first bet ---------------- */
    const onboarding = report.section('New account');
    const alice = new Client(harness.base);
    const signup = await alice.signup(uniqueName('alice'));
    onboarding.check(
      'signup lands a welcome balance',
      signup.user.balance > 0,
      `starts with ${money(signup.user.balance)}, of which ${money(signup.user.bonusBalance)} is promo credit`,
    );

    const config = await alice.must('/api/config');
    onboarding.check(
      'the app config carries everything the create form needs',
      ['defaultSubsidy', 'minSubsidy', 'maxSubsidy', 'minDeposit'].every((k) => typeof config.settings?.[k] === 'number'),
      'this contract broke market creation once and nothing caught it',
    );

    const funded = await alice.deposit(500);
    onboarding.check(
      'a sandbox deposit clears to withdrawable cash, not promo credit',
      near(funded.user.cashBalance, 500),
      `cash ${money(funded.user.cashBalance)} after a $500 deposit`,
    );

    /* ---------------- 2. Browsing and betting ---------------- */
    const betting = report.section('Placing a bet');
    const listing = await alice.markets('?sort=volume');
    const open = listing.markets.find((m) => m.tradable && m.isBinary);
    betting.check('the seeded book has an open binary market', !!open, `${listing.markets.length} markets listed`);

    const priceBefore = open.outcomes[0].price;
    const walletBeforeBet = (await alice.must('/api/me')).user.balance;
    const preview = await alice.quote(open.slug, { outcome: 0, side: 'buy', budget: 50 });
    const fill = await alice.trade(open.slug, { outcome: 0, side: 'buy', budget: 50, expectedCost: preview.cost });
    betting.check('the trade fills', fill.ok, fill.ok ? '' : JSON.stringify(fill.body));

    const quotedPayout = preview.payout;
    betting.check(
      'the quote matched the fill',
      near(fill.body.fill.shares, preview.shares, Math.max(0.5, preview.shares * 0.02)),
      `quoted ${num(preview.shares)} shares, filled ${num(fill.body.fill.shares)}`,
    );
    betting.check(
      'the price moved in the direction of the bet',
      fill.body.market.outcomes[0].price > priceBefore,
      `${pct(priceBefore)} → ${pct(fill.body.market.outcomes[0].price)}`,
    );
    betting.metric('$50 on Yes buys', `${num(quotedPayout)} shares`, `paying out ${money(quotedPayout)} if it happens`);

    const withHolding = await alice.markets('');
    const card = withHolding.holdings?.[String(open.id)];
    betting.check(
      'the position shows on the market card',
      !!card && card.some((h) => h.shares > 0),
      'a bet you cannot see from the list is a bet you forget you made',
    );

    /* ---------------- 3. Selling out again ---------------- */
    const exit = report.section('Closing a position');
    const sold = await alice.trade(open.slug, { outcome: 0, side: 'sell', sellAll: true });
    exit.check('selling the whole position works', sold.ok, sold.ok ? '' : JSON.stringify(sold.body));
    const roundTrip = (await alice.must('/api/me')).user.balance - walletBeforeBet;
    exit.check(
      'buying and immediately selling costs only the fee',
      roundTrip < 0 && Math.abs(roundTrip) < 50 * 0.05,
      `$50 in and straight back out cost ${money(-roundTrip)} — an AMM has no spread beyond its fee`,
    );
    const positions = await alice.must('/api/portfolio');
    exit.check(
      'the closed position leaves no dust behind',
      !positions.positions?.some((p) => p.marketId === open.id && p.shares > 0.01),
      'a fully sold position should disappear, not linger at 0.0001 shares',
    );

    /* ---------------- 4. Settlement pays the winners ---------------- */
    const settle = report.section('Settlement');
    const demo = new Client(harness.base);
    await demo.login('demo', 'demo123');
    const bob = new Client(harness.base);
    await bob.signup(uniqueName('bob'));
    await bob.deposit(300);

    const own = await demo.createMarket({
      question: 'Will settlement pay the winning side exactly one dollar a share?',
      subsidy: 200,
    });
    const bet = await bob.trade(own.slug, { outcome: 0, side: 'buy', budget: 100 });
    settle.check('a bet lands on the new market', bet.ok, bet.ok ? '' : JSON.stringify(bet.body));
    const shares = bet.body.fill.shares;
    const beforeSettle = (await bob.must('/api/me')).user.balance;

    await demo.resolve(own.slug, 0);
    const paid = (await bob.must('/api/me')).user.balance - beforeSettle;
    settle.check(
      'winners are paid $1.00 per share',
      near(paid, shares, 0.05),
      `${num(shares)} shares paid ${money(paid)}`,
    );
    settle.check(
      'the settled market stops trading',
      !(await bob.trade(own.slug, { outcome: 0, side: 'buy', budget: 10 })).ok,
      'a resolved market must refuse new money',
    );

    /* ---------------- 5. Getting money out ---------------- */
    const cashout = report.section('Withdrawal');
    const locked = await bob.must('/api/wallet');
    cashout.metric(
      'withdrawable before wagering',
      money(locked.withdrawable),
      `of ${money(locked.user.balance)} held · ${money(locked.wageringRemaining)} still to turn over`,
    );
    const blocked = await bob.call('/api/wallet/withdraw', {
      method: 'POST',
      body: { amount: 20, destination: 'harness@example.com' },
    });
    cashout.check(
      'the wagering requirement blocks an early cash-out',
      !blocked.ok && /trading volume|bonus/i.test(String(blocked.body?.error ?? '')),
      blocked.ok ? 'promo money walked straight back out' : String(blocked.body?.error ?? '').slice(0, 70),
    );

    // Turn the promo credit over honestly, the way a player would, rather than
    // reaching into the database to switch the rule off.
    for (let i = 0; i < 15; i += 1) {
      const status = await bob.must('/api/wallet');
      if (status.wageringRemaining <= 0) break;
      const stake = Math.min(150, Math.max(20, status.user.balance * 0.15));
      if (!(await bob.trade(open.slug, { outcome: 0, side: 'buy', budget: stake })).ok) break;
      await bob.trade(open.slug, { outcome: 0, side: 'sell', sellAll: true });
    }

    const wallet = await bob.must('/api/wallet');
    cashout.check(
      'clearing the wagering requirement unlocks the cash',
      wallet.wageringRemaining === 0 && wallet.withdrawable > 0,
      `${money(wallet.withdrawable)} withdrawable after turning over ${money(wallet.wagered)}`,
    );

    const request = await bob.call('/api/wallet/withdraw', {
      method: 'POST',
      body: { amount: Math.min(50, Math.floor(wallet.withdrawable)), destination: 'harness@example.com' },
    });
    cashout.check('a withdrawal can then be requested', request.ok, request.ok ? '' : JSON.stringify(request.body));

    if (request.ok) {
      const queue = await demo.must('/api/admin/withdrawals');
      const pending = queue.withdrawals.find((w) => w.id === request.body.withdrawal.id);
      cashout.check('it lands in the admin queue as pending', pending?.status === 'pending', `status ${pending?.status}`);
      const decided = await demo.call(`/api/admin/withdrawals/${request.body.withdrawal.id}`, {
        method: 'POST',
        body: { action: 'approve' },
      });
      cashout.check('an admin can approve it', decided.ok, decided.ok ? '' : JSON.stringify(decided.body));
    }

    /* ---------------- 6. Moderation ---------------- */
    const mod = report.section('Moderation');
    const filed = await alice.call('/api/reports', {
      method: 'POST',
      body: { kind: 'market', targetId: own.id, reason: 'spam', note: 'harness' },
    });
    mod.check('any signed-in user can report a market', filed.ok, filed.ok ? '' : JSON.stringify(filed.body));
    const again = await alice.call('/api/reports', {
      method: 'POST',
      body: { kind: 'market', targetId: own.id, reason: 'spam' },
    });
    mod.check('reporting twice is absorbed, not an error', again.ok, 'double-tap should not be punished');

    const queue = await demo.must('/api/admin/reports');
    mod.check('the report reaches the admin queue', queue.reports.length > 0, `${queue.reports.length} open`);
    mod.check(
      'a non-admin cannot read the queue',
      (await alice.call('/api/admin/reports')).status === 403,
      'the moderation queue names reporters',
    );

    const target = listing.markets.find((m) => m.tradable && m.id !== open.id) ?? open;
    const hidden = await demo.call(`/api/admin/markets/${target.slug}/hide`, { method: 'POST', body: { hidden: true } });
    mod.check('an admin can hide a market', hidden.ok, hidden.ok ? '' : JSON.stringify(hidden.body));
    const afterHide = await alice.markets('');
    mod.check(
      'a hidden market disappears from the listing',
      !afterHide.markets.some((m) => m.id === target.id),
      'hidden, not deleted — the positions still have to settle',
    );
    mod.check(
      'trading a hidden market is frozen',
      !(await alice.trade(target.slug, { outcome: 0, side: 'buy', budget: 10 })).ok,
      'money must stop moving the moment a market is under review',
    );

    /* ---------------- 7. Operations ---------------- */
    const ops = report.section('Operations');
    const health = await alice.call('/healthz');
    ops.check('healthz answers', health.ok && health.body.ok !== false, JSON.stringify(health.body).slice(0, 80));
    const overview = await demo.must('/api/admin/overview');
    ops.check('the control room reports revenue', typeof overview.treasury === 'number', `treasury ${money(overview.treasury)}`);
    ops.check(
      'a signed-out visitor can still browse',
      (await new Client(harness.base).call('/api/markets')).ok,
      'the front page must work before anyone signs up',
    );

    return report;
  } finally {
    await harness.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runJourneys();
  process.exit(report.render() ? 0 : 1);
}
