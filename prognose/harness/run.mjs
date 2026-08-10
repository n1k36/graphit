#!/usr/bin/env node
/**
 * The harness runner.
 *
 *   node harness/run.mjs              # everything
 *   node harness/run.mjs api          # user journeys over HTTP
 *   node harness/run.mjs eval         # does the price find the truth?
 *   node harness/run.mjs load         # p99 latency and the write ceiling
 *   node harness/run.mjs e2e          # browser flows (skipped without Playwright)
 *   node harness/run.mjs sweep        # how much liquidity should a market carry?
 *
 * Options:
 *   --seed N          reseed the simulations; a failure replays exactly
 *   --markets N       markets per eval run
 *   --concurrency N   virtual users in the load run
 *   --seconds N       how long to sustain the load
 *   --json FILE       write the full report as JSON as well as printing it
 *   --headed          show the browser during the e2e layer
 *
 * Every suite boots its own server on an ephemeral port with its own database.
 * Nothing here talks to a server you started by hand, which is the whole point:
 * a stale process on the usual port once served old code to three separate
 * test runs and every one of them looked green.
 */
import { writeFileSync } from 'node:fs';
import { runJourneys } from './api/journeys.mjs';
import { evaluate, sweepLiquidity } from './eval/market-maker.mjs';
import { runLoad } from './eval/load.mjs';
import { runBrowser } from './e2e/browser.mjs';
import { bold, cyan, dim, green, red } from './lib/report.mjs';

/** Flags that take a value; everything else with a `--` is a switch. */
const VALUED = new Set(['seed', 'markets', 'concurrency', 'seconds', 'json']);

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (!arg.startsWith('--')) {
    positional.push(arg);
  } else if (VALUED.has(arg.slice(2))) {
    flags.set(arg.slice(2), argv[++i]);
  } else {
    flags.set(arg.slice(2), true);
  }
}

const flag = (name) => flags.get(name);
const has = (name) => flags.has(name);
const number = (name) => Number(flags.get(name));

const suites = {
  api: { label: 'user journeys', run: () => runJourneys() },
  eval: {
    label: 'market maker eval',
    run: () =>
      evaluate({
        ...(flag('seed') ? { seed: number('seed') } : {}),
        ...(flag('markets') ? { markets: number('markets') } : {}),
      }),
  },
  load: {
    label: 'load',
    run: () =>
      runLoad({
        ...(flag('concurrency') ? { concurrency: number('concurrency') } : {}),
        ...(flag('seconds') ? { seconds: number('seconds') } : {}),
      }),
  },
  e2e: { label: 'browser', run: () => runBrowser({ headless: !has('headed') }) },
  sweep: {
    label: 'liquidity sweep',
    optional: true, // slow, and only interesting when tuning
    run: () => sweepLiquidity(flag('seed') ? { seed: number('seed') } : {}),
  },
};

const unknown = positional.filter((name) => name !== 'all' && !suites[name]);
if (unknown.length) {
  process.stderr.write(`Unknown suite: ${unknown.join(', ')}\nAvailable: ${Object.keys(suites).join(', ')}, all\n`);
  process.exit(2);
}

const everything = Object.entries(suites).filter(([, suite]) => !suite.optional).map(([name]) => name);
const asked = positional.filter((name) => name !== 'all');
const selected = positional.includes('all') || asked.length === 0 ? everything : asked;

process.stdout.write(`\n${bold('Tell — harness')} ${dim(`running ${selected.join(', ')}`)}\n`);

const reports = [];
for (const name of selected) {
  process.stdout.write(dim(`\n▸ ${suites[name].label}…\n`));
  try {
    const report = await suites[name].run();
    report.render();
    reports.push({ name, report });
  } catch (err) {
    process.stdout.write(red(`\n  ${name} crashed: ${err.stack ?? err.message}\n`));
    reports.push({ name, report: null, error: String(err.message) });
  }
}

/* ------------------------------- summary ------------------------------- */
const rows = reports.map(({ name, report, error }) => {
  if (error) return { name, state: 'crashed', passed: 0, total: 0 };
  if (report.skipped) return { name, state: 'skipped', passed: 0, total: 0 };
  const total = report.checks.length;
  const passed = total - report.failures.length;
  return { name, state: report.ok ? 'passed' : 'failed', passed, total };
});

process.stdout.write(`\n${cyan('Summary')}\n`);
for (const row of rows) {
  const mark = row.state === 'passed' ? green('✓') : row.state === 'failed' || row.state === 'crashed' ? red('✗') : dim('–');
  const count = row.total ? `${row.passed}/${row.total} checks` : row.state;
  process.stdout.write(`  ${mark} ${row.name.padEnd(8)} ${dim(count)}\n`);
}

const jsonPath = flag('json');
if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      { ranAt: new Date().toISOString(), suites: reports.map(({ name, report, error }) => ({ name, error, ...(report?.toJSON() ?? {}) })) },
      null,
      2,
    ),
  );
  process.stdout.write(dim(`\n  report written to ${jsonPath}\n`));
}

const failed = rows.some((row) => row.state === 'failed' || row.state === 'crashed');
process.stdout.write(failed ? red('\nharness failed\n\n') : green('\nharness passed\n\n'));
process.exit(failed ? 1 : 0);
