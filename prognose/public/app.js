/* Prognose — a play-money prediction market front end. No build step, no deps. */

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const usd = (n, dp = 2) =>
  (n < 0 ? '-$' : '$') +
  Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const pct = (p, dp = 0) => `${(Number(p) * 100).toFixed(dp)}%`;
const cents = (p) => `${(Number(p) * 100).toFixed(1)}¢`;
const num = (n, dp = 2) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function until(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'closed';
  const days = Math.floor(diff / 86400000);
  if (days >= 1) return `${days}d left`;
  const hours = Math.floor(diff / 3600000);
  return hours >= 1 ? `${hours}h left` : `${Math.max(1, Math.floor(diff / 60000))}m left`;
}

const dateLabel = (iso) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const signed = (n, dp = 2) => (n >= 0 ? '+' : '') + usd(n, dp).replace('-', '');
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted');

const avatar = (user, small = false) =>
  `<span class="avatar ${small ? 'sm' : ''}" style="background:${esc(user?.avatar || '#8d8983')}">${esc(
    (user?.username || '?')[0].toUpperCase(),
  )}</span>`;

const OUTCOME_COLORS = ['#3fb950', '#f0523f', '#6ea8fe', '#b98cf5', '#3ec9c0', '#e8739f', '#c9c3b6', '#8d8983'];
const colorFor = (market, i) => (market.isBinary ? ['#14c46a', '#f43f5e'][i] : OUTCOME_COLORS[i % OUTCOME_COLORS.length]);

/**
 * Prices to display. Once a market settles, the winner is worth $1.00 and
 * everything else nothing, regardless of where the AMM was last trading.
 */
function displayPrices(market) {
  if (market.status === 'resolved' && market.resolvedOutcome !== null) {
    return market.outcomes.map((o) => (o.index === market.resolvedOutcome ? 1 : 0));
  }
  return market.outcomes.map((o) => o.price);
}

/** The outcome a card or header leads with. */
function leadOutcome(market) {
  const prices = displayPrices(market);
  if (market.status === 'resolved' && market.resolvedOutcome !== null) {
    return { outcome: market.outcomes[market.resolvedOutcome], price: 1 };
  }
  if (market.isBinary) return { outcome: market.outcomes[0], price: prices[0] };
  let best = 0;
  for (let i = 1; i < prices.length; i++) if (prices[i] > prices[best]) best = i;
  return { outcome: market.outcomes[best], price: prices[best] };
}

/* ------------------------------------------------------------------ *
 * LMSR, mirrored client-side for instant trade previews.
 * Trades are always priced again on the server before they fill.
 * ------------------------------------------------------------------ */

function logSumExp(xs) {
  const max = Math.max(...xs);
  let sum = 0;
  for (const x of xs) sum += Math.exp(x - max);
  return max + Math.log(sum);
}
const costOf = (q, b) => b * logSumExp(q.map((x) => x / b));
function pricesOf(q, b) {
  const z = q.map((x) => x / b);
  const lse = logSumExp(z);
  return z.map((x) => Math.exp(x - lse));
}
function costToTrade(q, b, i, delta) {
  const next = q.slice();
  next[i] += delta;
  return costOf(next, b) - costOf(q, b);
}
function sharesForBudget(q, b, i, budget) {
  if (!(budget > 0)) return 0;
  let lo = budget;
  let hi = budget / Math.max(pricesOf(q, b)[i], 1e-12);
  if (!Number.isFinite(hi) || hi <= lo) hi = lo * 2 + 1;
  while (costToTrade(q, b, i, hi) < budget && hi < 1e15) hi *= 2;
  for (let k = 0; k < 120; k++) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (costToTrade(q, b, i, mid) > budget) hi = mid;
    else lo = mid;
  }
  return lo;
}

/* ------------------------------------------------------------------ *
 * State and API
 * ------------------------------------------------------------------ */

const S = {
  token: localStorage.getItem('prognose:token'),
  user: null,
  config: null,
  filters: { search: '', category: 'All', status: 'open', sort: 'volume' },
  trade: { outcome: 0, side: 'buy', amount: '' },
  chartRange: 'all',
  notifications: { unread: 0, items: [] },
  holdings: {},
  suspension: null,
  openReports: 0,
  modFilter: 'open',
  stats: null,
  activity: [],
  page: null,
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(S.token ? { authorization: `Bearer ${S.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && S.token) setToken(null);
    throw new Error(payload.error || `Request failed (${res.status})`);
  }
  return payload;
}

function setToken(token) {
  S.token = token;
  if (token) localStorage.setItem('prognose:token', token);
  else {
    localStorage.removeItem('prognose:token');
    S.user = null;
  }
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 300);
  }, 3800);
}

/* ------------------------------------------------------------------ *
 * Chart
 * ------------------------------------------------------------------ */

const CHART = { w: 800, h: 250, padL: 36, padR: 10, padT: 12, padB: 22 };

function filterRange(points, range) {
  if (range === 'all' || points.length < 3) return points;
  const spans = { '1d': 86400000, '1w': 7 * 86400000, '1m': 30 * 86400000 };
  const cutoff = Date.now() - (spans[range] ?? Infinity);
  const kept = points.filter((p) => new Date(p.t).getTime() >= cutoff);
  return kept.length >= 2 ? kept : points.slice(-2);
}

function chartSvg(market, history, range) {
  const points = filterRange(history.points, range);
  const { w, h, padL, padR, padT, padB } = CHART;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const times = points.map((p) => new Date(p.t).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times, tMin + 1);
  const x = (t) => padL + ((t - tMin) / (tMax - tMin)) * innerW;
  const y = (p) => padT + (1 - p) * innerH;

  const gridlines = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (p) =>
        `<line x1="${padL}" x2="${w - padR}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}" stroke="#1a2231" stroke-width="1"/>
         <text x="${padL - 8}" y="${(y(p) + 3.5).toFixed(1)}" fill="#5c6880" font-size="10.5" text-anchor="end">${p * 100}%</text>`,
    )
    .join('');

  const series = market.outcomes.map((outcome, i) => {
    const line = points
      .map((p, k) => `${k === 0 ? 'M' : 'L'}${x(times[k]).toFixed(1)},${y(p.prices[i]).toFixed(1)}`)
      .join(' ');
    const area = `${line} L${x(times.at(-1)).toFixed(1)},${(h - padB).toFixed(1)} L${x(times[0]).toFixed(1)},${(
      h - padB
    ).toFixed(1)} Z`;
    const color = colorFor(market, i);
    const solo = market.outcomes.length === 2 && i === 1; // hide the mirror line on binary markets
    if (solo) return '';
    return `
      ${market.outcomes.length === 2 ? `<path d="${area}" fill="url(#fade-${i})" />` : ''}
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(times.at(-1)).toFixed(1)}" cy="${y(points.at(-1).prices[i]).toFixed(1)}" r="3.5" fill="${color}"/>`;
  });

  const defs = market.outcomes
    .map(
      (_, i) => `<linearGradient id="fade-${i}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${colorFor(market, i)}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="${colorFor(market, i)}" stop-opacity="0"/>
      </linearGradient>`,
    )
    .join('');

  const xLabels = [0, 0.5, 1]
    .map((f) => {
      const t = tMin + (tMax - tMin) * f;
      const anchor = f === 0 ? 'start' : f === 1 ? 'end' : 'middle';
      return `<text x="${x(t).toFixed(1)}" y="${h - 5}" fill="#5c6880" font-size="10.5" text-anchor="${anchor}">${
        new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      }</text>`;
    })
    .join('');

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Probability over time">
      <defs>${defs}</defs>
      ${gridlines}${xLabels}${series.join('')}
      <line id="crosshair" x1="0" x2="0" y1="${padT}" y2="${h - padB}" stroke="#3a4761" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
      <rect id="chart-hit" x="${padL}" y="${padT}" width="${innerW}" height="${innerH}" fill="transparent" style="cursor:crosshair"/>
    </svg>`;
}

function wireChart(market, history) {
  const wrap = document.getElementById('chart-wrap');
  if (!wrap) return;
  const svg = wrap.querySelector('svg');
  const hit = wrap.querySelector('#chart-hit');
  const cross = wrap.querySelector('#crosshair');
  const tip = wrap.querySelector('.chart-tooltip');
  if (!svg || !hit || !tip) return;
  const points = filterRange(history.points, S.chartRange);
  const times = points.map((p) => new Date(p.t).getTime());
  const tMin = Math.min(...times);
  const tMax = Math.max(...times, tMin + 1);

  const move = (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = CHART.w / rect.width;
    const svgX = (event.clientX - rect.left) * scale;
    const t = tMin + ((svgX - CHART.padL) / (CHART.w - CHART.padL - CHART.padR)) * (tMax - tMin);
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    const point = points[best];
    cross.setAttribute('x1', svgX);
    cross.setAttribute('x2', svgX);
    cross.setAttribute('opacity', '1');
    tip.style.opacity = '1';
    tip.style.left = `${event.clientX - rect.left}px`;
    tip.style.top = `${(CHART.padT / scale) * 1 + 30}px`;
    tip.innerHTML =
      `<div class="faint">${esc(new Date(point.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</div>` +
      market.outcomes
        .map(
          (o, i) =>
            `<div><span class="key" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colorFor(
              market,
              i,
            )};margin-right:6px"></span>${esc(o.label)} <b>${pct(point.prices[i], 1)}</b></div>`,
        )
        .join('');
  };
  hit.addEventListener('mousemove', move);
  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('opacity', '0');
    tip.style.opacity = '0';
  });
}

function sparkline(market, w = 260, h = 34) {
  const values = market.spark && market.spark.length > 1 ? market.spark : [1 / market.outcomes.length];
  if (values.length < 2) return `<div style="height:${h}px"></div>`;
  const step = w / (values.length - 1);
  // Scale to the data's own range so small moves are visible, but never
  // magnify noise: the window is at least 10 percentage points wide.
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const mid = (lo + hi) / 2;
  const span = Math.max(hi - lo, 0.1);
  const bottom = Math.max(0, mid - span / 2);
  const norm = (v) => (v - bottom) / span;
  const path = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - norm(v) * (h - 6) - 3).toFixed(1)}`)
    .join(' ');
  const rising = values.at(-1) >= values[0];
  const color = rising ? 'var(--yes)' : 'var(--no)';
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${path}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>`;
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

function renderNav() {
  const route = currentRoute();
  const link = (href, label) =>
    `<a href="${href}" class="${route.path === href.slice(1) ? 'active' : ''}">${label}</a>`;
  const links = S.user
    ? [link('#/dashboard', 'Dashboard'), link('#/', 'Markets'), link('#/leaderboard', 'Leaderboard')]
    : [link('#/', 'Markets'), link('#/leaderboard', 'Leaderboard')];

  if (S.user) {
    const level = S.user.level ?? { level: 1, name: 'Rookie', progress: 0 };
    links.push(link('#/portfolio', 'Portfolio'), `<a href="#/create">Create</a>`);
    if (S.user.isAdmin) {
      links.push(link('#/admin', 'Admin'));
      links.push(
        `<a href="#/moderation" class="${route.path === '/moderation' ? 'active' : ''}">Reports${
          S.openReports ? `<span class="badge-dot inline">${Math.min(S.openReports, 99)}</span>` : ''
        }</a>`,
      );
    }
    if (S.user.bonusReady) {
      links.push(`<button class="bonus-pill" id="bonus-btn" title="Claim your daily bonus">Claim daily</button>`);
    } else if (S.user.streak > 0) {
      links.push(`<span class="streak-pill" title="Daily streak">${S.user.streak}d streak</span>`);
    }
    links.push(
      `<button class="bell" id="bell-btn" aria-label="Notifications">Alerts${
        S.notifications?.unread ? `<span class="badge-dot">${Math.min(S.notifications.unread, 9)}</span>` : ''
      }</button>`,
      `<a href="#/wallet" class="balance-chip" title="Cash ${usd(S.user.cashBalance ?? 0)} · bonus ${usd(
        S.user.bonusBalance ?? 0,
      )}">
        <span class="mono">${usd(S.user.balance)}</span>
        <span class="level-chip" title="Level ${level.level} · ${esc(level.name)}">L${level.level}</span>
        ${avatar(S.user)}
      </a>`,
      `<button id="logout-btn">Sign out</button>`,
    );
  } else {
    links.push(`<a href="#/login" class="ghostish">Sign in</a>`, `<a href="#/signup" class="signin">Open an account</a>`);
  }
  if (!isStandalone() && (installPrompt || isIos())) {
    links.push(`<button class="install-btn" id="install-btn" title="Install the app">⤓ Install</button>`);
  }
  document.getElementById('nav').innerHTML = links.join('');

  const logout = document.getElementById('logout-btn');
  if (logout)
    logout.onclick = async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      setToken(null);
      connectStream();
      toast('Signed out.');
      navigate('#/');
    };
  const bonus = document.getElementById('bonus-btn');
  if (bonus) bonus.onclick = claimBonus;

  const install = document.getElementById('install-btn');
  if (install) install.onclick = promptInstall;

  const bell = document.getElementById('bell-btn');
  if (bell)
    bell.onclick = (event) => {
      event.stopPropagation();
      const existing = document.getElementById('notif-panel');
      if (existing) return existing.remove();
      bell.insertAdjacentHTML('afterend', notificationPanel());
      const markRead = document.getElementById('notif-read');
      if (markRead)
        markRead.onclick = async (e) => {
          e.preventDefault();
          await api('/api/notifications/read', { method: 'POST' }).catch(() => {});
          await refreshNotifications();
          document.getElementById('notif-panel')?.remove();
        };
      setTimeout(() => {
        document.addEventListener('click', function close(e) {
          if (!e.target.closest('#notif-panel')) {
            document.getElementById('notif-panel')?.remove();
            document.removeEventListener('click', close);
          }
        });
      }, 0);
    };
}

const app = () => document.getElementById('app');
const setApp = (html) => {
  app().innerHTML = html;
};

/* ------------------------------------------------------------------ *
 * Markets list
 * ------------------------------------------------------------------ */

/**
 * A market as a table row.
 *
 * The card grid this replaces put one market per tile and pushed the price
 * to the corner. A row puts the symbol, the question, the trend, the price,
 * the session move, the volume and both sides on one horizontal line, so a
 * book of forty markets is scannable and every one of them is one click from
 * a filled order.
 */
function marketRow(market) {
  const lead = leadOutcome(market);
  const prices = displayPrices(market);
  const held = S.holdings?.[market.id] ?? [];
  const clock = countdown(market.closesAt);

  const take = !market.tradable
    ? `<span class="faint">${
        market.status === 'resolved'
          ? `Settled ${esc(market.outcomes[market.resolvedOutcome].label)}`
          : market.status === 'cancelled'
            ? 'Cancelled'
            : 'Closed'
      }</span>`
    : market.isBinary
      ? `<div class="take">${market.outcomes
          .map(
            (o) => `<button class="${o.index === 0 ? 'yes' : 'no'}" data-bet="${o.index}">
              ${esc(o.label)} <b>${cents(o.price)}</b></button>`,
          )
          .join('')}</div>`
      : `<div class="take"><button class="single" data-bet="${lead.outcome.index}">Trade</button></div>`;

  const status =
    market.status === 'open' && !market.closed
      ? `<span class="${clock.urgent ? 'warn-text' : 'faint'}">${esc(clock.text)}</span>`
      : '';

  return `<tr class="market-row ${market.hot ? 'hot' : ''}" data-slug="${esc(market.slug)}">
      <td class="col-sym" data-nav><span class="market-symbol">${esc(market.symbol || 'GEN')}</span></td>
      <td data-nav>
        <div class="row-question">${held.length ? '<span class="holding-mark" title="You hold a position"></span>' : ''}${esc(
          market.question,
        )}</div>
        <div class="row-sub">
          ${market.isBinary ? '' : `${esc(lead.outcome.label)} leading · ${market.outcomes.length} outcomes · `}
          ${esc(market.category)}${status ? ' · ' + status : ''}
          ${market.featured ? ' · <span class="accent-text">Featured</span>' : ''}
        </div>
      </td>
      <td class="col-trend" data-nav>${market.isBinary ? sparkline(market, 92, 26) : ''}</td>
      <td class="num col-chance" data-nav>${pct(lead.price)}</td>
      <td class="num col-vol" data-nav>
        ${usd(market.volume, 0)}
        ${market.volume24h > 0 ? `<div class="row-sub pos">+${usd(market.volume24h, 0)} 24h</div>` : ''}
      </td>
      <td class="col-take">${take}</td>
    </tr>`;
}

function marketTable(markets) {
  if (!markets.length) {
    return '<div class="empty">No markets match that. <a href="#/create" class="accent-text">Create one?</a></div>';
  }
  return `<div class="panel"><div class="scroller"><table class="book">
      <thead><tr>
        <th>Sym</th><th>Market</th><th>Trend</th>
        <th class="num">Chance</th><th class="num">Volume</th><th class="num">Take a side</th>
      </tr></thead>
      <tbody>${markets.map(marketRow).join('')}</tbody>
    </table></div></div>`;
}

/**
 * Rows navigate; the Yes/No buttons inside them do not. Only cells marked
 * `data-nav` navigate, so the buttons never have to fight a bubbling click.
 */
function wireMarketRows(markets) {
  app().querySelectorAll('.market-row').forEach((row) => {
    const market = markets.find((m) => m.slug === row.dataset.slug);
    row.onclick = (event) => {
      const bet = event.target.closest('[data-bet]');
      if (bet) {
        event.stopPropagation();
        if (market) openQuickBet(market, Number(bet.dataset.bet));
        return;
      }
      if (event.target.closest('[data-nav]')) navigate(`#/market/${row.dataset.slug}`);
    };
  });
}

async function viewMarkets() {
  setApp('<div class="loading">Loading markets…</div>');
  const params = new URLSearchParams({
    search: S.filters.search,
    category: S.filters.category,
    status: S.filters.status,
    sort: S.filters.sort,
  });
  const [listing, stats] = await Promise.all([
    api(`/api/markets?${params}`),
    S.stats ? Promise.resolve(S.stats) : api('/api/stats').catch(() => null),
  ]);
  const { markets } = listing;
  S.holdings = listing.holdings ?? {};
  S.stats = stats;
  const categories = ['All', ...(S.config?.categories ?? [])];

  setApp(`
    ${suspensionBanner()}
    ${S.filters.search || S.filters.category !== 'All' ? '' : heroSection(stats)}
    <div class="page-head">
      <div>
        <h1>${S.filters.search ? `Results for "${esc(S.filters.search)}"` : 'Markets'}</h1>
        <div class="muted">Every price is the market's estimate of the probability. Buy low, sell high, or hold to settlement.</div>
      </div>
    </div>
    <div class="filters">
      <div class="chips">${categories
        .map(
          (c) =>
            `<button class="chip ${S.filters.category === c ? 'active' : ''}" data-filter="category" data-value="${esc(c)}">${esc(c)}</button>`,
        )
        .join('')}</div>
      <span class="spacer"></span>
      <select class="control" data-filter="status">
        ${[
          ['open', 'Open'],
          ['closed', 'Awaiting settlement'],
          ['resolved', 'Settled'],
          ['all', 'All'],
        ]
          .map(([v, l]) => `<option value="${v}" ${S.filters.status === v ? 'selected' : ''}>${l}</option>`)
          .join('')}
      </select>
      <select class="control" data-filter="sort">
        ${[
          ['hot', 'Most active'],
          ['volume', 'Top volume'],
          ['activity', 'Most traded'],
          ['newest', 'Newest'],
          ['closing', 'Closing soon'],
        ]
          .map(([v, l]) => `<option value="${v}" ${S.filters.sort === v ? 'selected' : ''}>${l}</option>`)
          .join('')}
      </select>
    </div>
    ${marketTable(markets)}
  `);

  wireMarketRows(markets);
  app().querySelectorAll('[data-filter="category"]').forEach((chip) => {
    chip.onclick = () => {
      S.filters.category = chip.dataset.value;
      viewMarkets();
    };
  });
  app().querySelectorAll('select[data-filter]').forEach((select) => {
    select.onchange = () => {
      S.filters[select.dataset.filter] = select.value;
      viewMarkets();
    };
  });
}

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

/**
 * Everything here is read from the same endpoints the rest of the app uses —
 * the portfolio, the market list and the activity feed — so the numbers can
 * never disagree with the pages they came from.
 */
async function viewDashboard() {
  if (!S.user) return navigate('#/login');
  setApp('<div class="loading">Loading dashboard…</div>');

  const [portfolio, listing, activity, stats] = await Promise.all([
    api('/api/portfolio'),
    api('/api/markets?status=open&sort=hot&limit=60'),
    api('/api/activity?limit=10').catch(() => ({ activity: [] })),
    api('/api/stats').catch(() => null),
  ]);

  const s = portfolio.summary;
  S.holdings = listing.holdings ?? {};
  const markets = listing.markets ?? [];

  // Biggest movers of the session, by how far the price has travelled across
  // the sparkline window the list endpoint already returns.
  const movers = markets
    .filter((m) => m.tradable && m.spark && m.spark.length > 1)
    .map((m) => ({ market: m, move: m.spark.at(-1) - m.spark[0] }))
    .sort((a, b) => Math.abs(b.move) - Math.abs(a.move))
    .slice(0, 5);

  const figure = (label, value, extra = '') =>
    `<div class="figure"><div class="label">${label}</div><dd>${value}</dd>${
      extra ? `<div class="delta">${extra}</div>` : ''
    }</div>`;

  setApp(`
    ${suspensionBanner()}
    <div class="page-head">
      <div>
        <div class="label">Account</div>
        <h1>Dashboard</h1>
        <div class="muted">Marked to the current market price, live.</div>
      </div>
    </div>

    <dl class="figures">
      ${figure('Net worth', usd(s.netWorth))}
      ${figure('Cash', usd(s.balance), S.user.bonusBalance > 0 ? `${usd(S.user.bonusBalance)} promo credit` : '')}
      ${figure('At risk', usd(s.positionValue))}
      ${figure('Unrealised', signed(s.unrealized), `<span class="${cls(s.unrealized)}">${
        s.invested > 0 ? `${s.unrealized >= 0 ? '+' : '−'}${Math.abs((s.unrealized / s.invested) * 100).toFixed(1)}%` : '—'
      }</span>`)}
      ${figure('Realised', signed(s.realized))}
      ${figure('All-time', signed(s.profit))}
    </dl>

    <div class="dash-cols">
      <div>
        <div class="panel">
          <div class="panel-head">
            <span class="label">Open</span><h2>Your positions</h2>
            <span class="spacer"></span>
            <span class="label">${portfolio.positions.length} held</span>
          </div>
          ${
            portfolio.positions.length
              ? `<div class="scroller">${positionsTable(portfolio.positions)}</div>`
              : `<div class="empty">Nothing open yet.<br /><a class="btn sm" href="#/">Browse markets</a></div>`
          }
        </div>

        <div class="panel">
          <div class="panel-head"><span class="label">Session</span><h2>Biggest moves</h2></div>
          ${
            movers.length
              ? `<div class="scroller"><table class="book"><tbody>${movers
                  .map(
                    ({ market, move }) => `<tr class="market-row" data-slug="${esc(market.slug)}">
                      <td class="col-sym" data-nav><span class="market-symbol">${esc(market.symbol || 'GEN')}</span></td>
                      <td data-nav><div class="row-question">${esc(market.question)}</div></td>
                      <td class="col-trend" data-nav>${sparkline(market, 92, 26)}</td>
                      <td class="num col-chance" data-nav>${pct(leadOutcome(market).price)}</td>
                      <td class="num" data-nav><span class="${move >= 0 ? 'pos' : 'neg'}">${
                        move >= 0 ? '+' : '−'
                      }${Math.abs(move * 100).toFixed(1)}pp</span></td>
                    </tr>`,
                  )
                  .join('')}</tbody></table></div>`
              : '<div class="empty">Nothing has moved yet today.</div>'
          }
        </div>
      </div>

      <div>
        <div class="panel">
          <div class="panel-head"><span class="label">Tape</span><h2>Latest trades</h2></div>
          ${
            (activity.activity ?? []).length
              ? (activity.activity ?? [])
                  .map(
                    (item) => `<a class="tape-line" href="#/market/${esc(item.market.slug)}">
                      <span class="market-symbol xs">${esc(item.market.symbol || 'GEN')}</span>
                      <span class="who">${esc(item.user.username)}</span>
                      <span class="muted">${item.side === 'buy' ? 'bought' : 'sold'}</span>
                      <span class="spacer"></span>
                      <span class="muted">${esc(item.outcomeLabel)}</span>
                      <span class="mono">${usd(item.cost, 0)}</span>
                    </a>`,
                  )
                  .join('')
              : '<div class="empty">No trades yet.</div>'
          }
        </div>

        ${
          stats
            ? `<div class="panel">
                <div class="panel-head"><span class="label">Platform</span><h2>Right now</h2></div>
                <div class="panel-body">
                  <div class="kv"><span>24h volume</span><b class="mono">${usd(stats.volume24h, 0)}</b></div>
                  <div class="kv"><span>24h trades</span><b class="mono">${stats.trades24h.toLocaleString('en-US')}</b></div>
                  <div class="kv"><span>Open markets</span><b class="mono">${stats.openMarkets}</b></div>
                  <div class="kv"><span>Traders</span><b class="mono">${stats.traders.toLocaleString('en-US')}</b></div>
                </div>
              </div>`
            : ''
        }

        ${
          s.creatorEquity
            ? `<div class="panel"><div class="panel-head"><span class="label">Making</span><h2>Liquidity you posted</h2></div>
                <div class="panel-body"><p class="muted" style="margin:0">${usd(
                  s.creatorEquity,
                )} of your net worth is subsidy backing markets you created. It returns to your balance when they settle.</p></div>
              </div>`
            : ''
        }
      </div>
    </div>
  `);

  wireMarketRows(markets);
}

/* ------------------------------------------------------------------ *
 * Market detail
 * ------------------------------------------------------------------ */

let current = null; // { market, history, trades, comments, positions }

async function viewMarket(slug) {
  setApp('<div class="loading">Loading market…</div>');
  const data = await api(`/api/markets/${encodeURIComponent(slug)}`);
  current = data;
  S.trade = { outcome: 0, side: 'buy', amount: '' };
  renderMarket();
}

function renderMarket() {
  const { market, history, trades, comments, positions, holders } = current;
  const lead = leadOutcome(market);
  const shown = displayPrices(market);
  const canSettle = S.user && (S.user.id === market.creator?.id || S.user.isAdmin) && market.status === 'open';

  setApp(`
    <a href="#/" class="muted" style="font-size:13.5px">← All markets</a>
    <div class="detail" style="margin-top:14px">
      <div>
        <div class="detail-head">
          <div class="market-symbol">${esc(market.symbol || 'GEN')}</div>
          <div style="flex:1;min-width:0">
            <h1>${esc(market.question)}</h1>
            <div class="meta-row">
              <span class="tag">${esc(market.category)}</span>
              <span>${usd(market.volume, 0)} volume</span>
              <span>${market.traders ?? 0} traders</span>
              <span>${market.status === 'open' ? `closes ${dateLabel(market.closesAt)}` : `settled ${dateLabel(market.resolvedAt)}`}</span>
              <span>by ${esc(market.creator?.username ?? 'unknown')}</span>
              <button class="report-link" id="report-market" title="Report this market">Report</button>
            </div>
          </div>
        </div>

        ${suspensionBanner()}
        ${
          market.hidden
            ? `<div class="notice warn" style="margin-bottom:14px">
                <b>This market is hidden.</b> It is under review, does not appear in listings, and cannot be traded.
                Existing positions still settle normally.
               </div>`
            : ''
        }
        ${
          market.status === 'resolved'
            ? `<div class="notice win" style="margin-bottom:14px">Settled: <b>${esc(
                market.outcomes[market.resolvedOutcome].label,
              )}</b> — winning shares paid $1.00 each.</div>`
            : market.status === 'cancelled'
              ? '<div class="notice warn" style="margin-bottom:14px">This market was cancelled. Holders were refunded at the last traded price.</div>'
              : market.closed
                ? '<div class="notice warn" style="margin-bottom:14px">Trading has closed. Waiting for the creator to settle it.</div>'
                : ''
        }

        <div class="card">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
            <div class="headline-price">
              <span class="big" style="color:${colorFor(market, lead.outcome.index)}">${pct(lead.price, 1)}</span>
              <span class="of">${esc(
                market.status === 'resolved'
                  ? `${lead.outcome.label} — settled`
                  : market.isBinary
                    ? 'chance of Yes'
                    : lead.outcome.label,
              )}</span>
            </div>
            <div class="range-tabs">
              ${['1d', '1w', '1m', 'all']
                .map(
                  (r) =>
                    `<button data-range="${r}" class="${S.chartRange === r ? 'active' : ''}">${r === 'all' ? 'All' : r.toUpperCase()}</button>`,
                )
                .join('')}
            </div>
          </div>
          <div class="chart-wrap" id="chart-wrap">
            ${chartSvg(market, history, S.chartRange)}
            <div class="chart-tooltip"></div>
          </div>
          <div class="chart-legend">
            ${market.outcomes
              .filter((o) => !(market.outcomes.length === 2 && o.index === 1))
              .map(
                (o) =>
                  `<span><span class="key" style="background:${colorFor(market, o.index)}"></span>${esc(o.label)} ${pct(shown[o.index], 1)}</span>`,
              )
              .join('')}
          </div>
        </div>

        ${depthChart(market)}

        ${
          market.description
            ? `<div class="section card"><h3>Resolution criteria</h3><div class="prose">${esc(market.description)}</div></div>`
            : ''
        }

        ${canSettle ? settlePanel(market) : ''}

        ${holdersPanel(holders, market)}

        <div class="section card">
          <h3>Recent activity</h3>
          ${
            trades.length
              ? `<table class="data"><tbody>${trades
                  .map(
                    (t) => `<tr>
                      <td><div class="user-cell">${avatar(t.user, true)}<a href="#/user/${esc(t.user.username)}">${esc(t.user.username)}</a></div></td>
                      <td>${
                        t.side === 'settle'
                          ? `<span class="muted">settled</span>`
                          : `<span class="${t.side === 'buy' ? 'pos' : 'neg'}">${t.side}</span>`
                      } <b>${esc(market.outcomes[t.outcome].label)}</b></td>
                      <td class="num mono">${num(t.shares)} sh</td>
                      <td class="num mono">${cents(t.avgPrice)}</td>
                      <td class="num mono">${usd(Math.abs(t.cost))}</td>
                      <td class="num faint">${timeAgo(t.createdAt)}</td>
                    </tr>`,
                  )
                  .join('')}</tbody></table>`
              : '<div class="muted">No trades yet — be the first.</div>'
          }
        </div>

        <div class="section card">
          <h3>Comments (${comments.length})</h3>
          ${
            S.user
              ? `<div class="comment-form">
                  ${avatar(S.user)}
                  <textarea class="control" id="comment-body" placeholder="Share your reasoning…" maxlength="1000"></textarea>
                  <button class="btn sm" id="comment-post">Post</button>
                </div>`
              : '<div class="muted"><a href="#/login" style="color:var(--accent)">Sign in</a> to join the discussion.</div>'
          }
          ${comments
            .map((c) =>
              c.removed
                ? `<div class="comment removed"><div class="body"><div class="text faint">This comment was removed by a moderator.</div></div></div>`
                : `<div class="comment">${avatar(c.user)}
                <div class="body">
                  <div class="who">${esc(c.user.username)} <span class="faint" style="font-weight:400">· ${timeAgo(c.createdAt)}</span></div>
                  <div class="text">${esc(c.body)}</div>
                </div>
                <button class="report-link" data-report-comment="${c.id}" title="Report this comment">Report</button>
              </div>`,
            )
            .join('')}
        </div>
      </div>

      <aside>${tradePanel(market, positions)}</aside>
    </div>
  `);

  wireChart(market, history);
  wireMarketEvents(market);
  updatePreview();
}

function settlePanel(market) {
  const mine = S.user?.id === market.creator?.id;
  return `<div class="section card">
      <h3>Settle this market</h3>
      <div class="muted" style="margin-bottom:10px">${
        mine
          ? `You created this market, so you settle it. Winning shares pay $1.00; everything else expires worthless. Your $${num(
              market.subsidy,
            )} subsidy comes back with whatever the market maker earned or lost.`
          : `You are settling this as an admin. Winning shares pay $1.00; everything else expires worthless. The $${num(
              market.subsidy,
            )} subsidy goes back to ${esc(market.creator?.username ?? 'the creator')}.`
      }</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select class="control" id="settle-outcome">
          ${market.outcomes.map((o) => `<option value="${o.index}">${esc(o.label)}</option>`).join('')}
        </select>
        <button class="btn sm" id="settle-btn">Settle</button>
        <button class="btn sm ghost" id="cancel-btn">Cancel market</button>
        ${
          S.user?.isAdmin
            ? `<button class="btn sm ghost" id="hide-market">${market.hidden ? 'Restore listing' : 'Hide from listings'}</button>`
            : ''
        }
      </div>
    </div>`;
}

function tradePanel(market, positions) {
  if (market.status !== 'open') {
    const held = positions.reduce((sum, p) => sum + p.shares, 0);
    return `<div class="panel">
        <h3>Trading is over</h3>
        <div class="muted">${
          market.status === 'resolved'
            ? `This market settled on <b>${esc(market.outcomes[market.resolvedOutcome].label)}</b>.`
            : 'This market was cancelled and holders were refunded.'
        }</div>
        ${held ? '<div class="notice win" style="margin-top:12px">Your position has been paid out to your balance.</div>' : ''}
      </div>`;
  }
  if (market.closed) {
    return `<div class="panel"><h3>Closed for trading</h3><div class="muted">This market closed on ${dateLabel(
      market.closesAt,
    )} and is waiting for the creator to settle it.</div></div>`;
  }

  const selected = S.trade.outcome;
  const isSell = S.trade.side === 'sell';

  return `<div class="panel">
      <div class="tabs">
        <button data-side="buy" class="${!isSell ? 'active' : ''}">Buy</button>
        <button data-side="sell" class="${isSell ? 'active' : ''}">Sell</button>
      </div>

      <div class="outcome-picker ${market.isBinary ? 'binary' : ''}">
        ${market.outcomes
          .map((o) => {
            const holds = positions.find((p) => p.outcome === o.index)?.shares ?? 0;
            const kind = market.isBinary ? (o.index === 0 ? 'yes' : 'no') : '';
            return `<button class="outcome-btn ${kind} ${o.index === selected ? 'active' : ''}"
              data-outcome="${o.index}" ${isSell && holds <= 0 ? 'disabled' : ''}>
              <span>${esc(o.label)}</span>
              <span class="price">${cents(o.price)}</span>
            </button>`;
          })
          .join('')}
      </div>

      <div class="amount-field ${isSell ? 'shares' : ''}">
        ${isSell ? '' : '<span class="prefix">$</span>'}
        <input id="trade-amount" type="text" inputmode="decimal" placeholder="0" value="${esc(S.trade.amount)}"
               aria-label="${isSell ? 'Shares to sell' : 'Amount to spend'}" />
      </div>
      <div class="quick">
        ${
          isSell
            ? [25, 50, 100]
                .map((p) => `<button data-sell-pct="${p}">${p}%</button>`)
                .join('')
            : [1, 10, 50]
                .map((v) => `<button data-amount="${v}">+$${v}</button>`)
                .join('') + '<button data-amount="max">Max</button>'
        }
      </div>

      <div class="summary-rows" id="trade-preview"></div>
      <button class="btn ${market.isBinary && !isSell ? (selected === 0 ? 'yes' : 'no') : ''}" id="trade-submit">
        ${S.user ? (isSell ? 'Sell' : 'Buy') : 'Sign in to trade'}
      </button>

      ${
        positions.length
          ? `<div class="position-box">
              <h3 style="margin-bottom:6px">Your position</h3>
              ${positions
                .map((p) => {
                  const price = market.outcomes[p.outcome].price;
                  const value = p.shares * price;
                  const pnl = value - p.costBasis;
                  return `<div class="row"><span class="muted">${esc(market.outcomes[p.outcome].label)} · ${num(
                    p.shares,
                  )} sh</span><span class="mono">${usd(value)} <span class="${cls(pnl)}">(${signed(pnl)})</span></span></div>`;
                })
                .join('')}
            </div>`
          : ''
      }
    </div>`;
}

/** The preview beneath the amount box; recomputed on every keystroke. */
function computePreview() {
  const market = current.market;
  const i = S.trade.outcome;
  const amount = parseFloat(S.trade.amount);
  const feeRate = market.feeRate;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  if (S.trade.side === 'buy') {
    const shares = sharesForBudget(market.q, market.b, i, amount / (1 + feeRate));
    if (!(shares > 0)) return null;
    const raw = costToTrade(market.q, market.b, i, shares);
    const next = market.q.slice();
    next[i] += shares;
    return {
      shares,
      cost: amount,
      fee: raw * feeRate,
      avgPrice: amount / shares,
      priceAfter: pricesOf(next, market.b)[i],
      payout: shares,
      profit: shares - amount,
    };
  }

  const held = current.positions.find((p) => p.outcome === i)?.shares ?? 0;
  const shares = Math.min(amount, held);
  if (!(shares > 0)) return null;
  const raw = Math.abs(costToTrade(market.q, market.b, i, -shares));
  const fee = raw * feeRate;
  const next = market.q.slice();
  next[i] -= shares;
  return { shares, cost: raw - fee, fee, avgPrice: (raw - fee) / shares, priceAfter: pricesOf(next, market.b)[i], sell: true };
}

function updatePreview() {
  const box = document.getElementById('trade-preview');
  const button = document.getElementById('trade-submit');
  if (!box || !button) return;
  const market = current.market;
  const preview = computePreview();
  if (!preview) {
    box.innerHTML = `<div><span class="k">Price</span><span class="v">${cents(
      market.outcomes[S.trade.outcome].price,
    )}</span></div><div><span class="k">Fee</span><span class="v">${pct(market.feeRate, 1)} of trade value</span></div>`;
    button.disabled = !!S.user;
    return;
  }
  const row = (k, v, klass = '') => `<div><span class="k">${k}</span><span class="v ${klass}">${v}</span></div>`;
  box.innerHTML =
    preview.sell
      ? row('Shares', num(preview.shares)) +
        row('Average price', cents(preview.avgPrice)) +
        row('Fee', usd(preview.fee)) +
        row('You receive', usd(preview.cost), 'pos') +
        row('New price', cents(preview.priceAfter))
      : row('Shares', num(preview.shares)) +
        row('Average price', cents(preview.avgPrice)) +
        row('Fee', usd(preview.fee)) +
        row('Payout if correct', usd(preview.payout), 'pos') +
        row('Profit if correct', `${signed(preview.profit)} (${pct(preview.profit / preview.cost, 0)})`, 'pos') +
        row('New price', cents(preview.priceAfter));
  button.disabled = false;
}

function wireMarketEvents(market) {
  const el = app();
  el.querySelectorAll('[data-range]').forEach((b) => {
    b.onclick = () => {
      S.chartRange = b.dataset.range;
      renderMarket();
    };
  });
  el.querySelectorAll('[data-side]').forEach((b) => {
    b.onclick = () => {
      S.trade.side = b.dataset.side;
      S.trade.amount = '';
      if (S.trade.side === 'sell') {
        const owned = current.positions[0];
        if (owned) S.trade.outcome = owned.outcome;
      }
      renderMarket();
    };
  });
  el.querySelectorAll('[data-outcome]').forEach((b) => {
    b.onclick = () => {
      S.trade.outcome = Number(b.dataset.outcome);
      renderMarket();
    };
  });
  const amount = document.getElementById('trade-amount');
  if (amount) {
    amount.oninput = () => {
      S.trade.amount = amount.value.replace(/[^0-9.]/g, '');
      if (amount.value !== S.trade.amount) amount.value = S.trade.amount;
      updatePreview();
    };
    amount.onkeydown = (e) => {
      if (e.key === 'Enter') submitTrade();
    };
  }
  el.querySelectorAll('[data-amount]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.amount === 'max') {
        S.trade.amount = String(Math.floor((S.user?.balance ?? 0) * 100) / 100);
      } else {
        S.trade.amount = String(Math.round(((parseFloat(S.trade.amount) || 0) + Number(b.dataset.amount)) * 100) / 100);
      }
      document.getElementById('trade-amount').value = S.trade.amount;
      updatePreview();
    };
  });
  el.querySelectorAll('[data-sell-pct]').forEach((b) => {
    b.onclick = () => {
      const held = current.positions.find((p) => p.outcome === S.trade.outcome)?.shares ?? 0;
      S.trade.amount = String(Math.floor(held * (Number(b.dataset.sellPct) / 100) * 1e4) / 1e4);
      document.getElementById('trade-amount').value = S.trade.amount;
      updatePreview();
    };
  });
  const submit = document.getElementById('trade-submit');
  if (submit) submit.onclick = submitTrade;

  const reportMarket = document.getElementById('report-market');
  if (reportMarket) reportMarket.onclick = () => openReport('market', market.id, market.question);
  el.querySelectorAll('[data-report-comment]').forEach((b) => {
    b.onclick = () => openReport('comment', Number(b.dataset.reportComment), 'This comment');
  });
  const hideBtn = document.getElementById('hide-market');
  if (hideBtn)
    hideBtn.onclick = async () => {
      try {
        const res = await api(`/api/admin/markets/${market.slug}/hide`, { method: 'POST', body: { hidden: !market.hidden } });
        toast(res.hidden ? 'Market hidden and trading frozen.' : 'Market restored.', 'success');
        refreshMarket();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

  const post = document.getElementById('comment-post');
  if (post)
    post.onclick = async () => {
      const body = document.getElementById('comment-body').value.trim();
      if (!body) return;
      try {
        await api(`/api/markets/${market.slug}/comments`, { method: 'POST', body: { body } });
        await refreshMarket();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

  const settle = document.getElementById('settle-btn');
  if (settle)
    settle.onclick = async () => {
      const outcome = Number(document.getElementById('settle-outcome').value);
      if (!confirm(`Settle this market as "${market.outcomes[outcome].label}"? This pays out every position and cannot be undone.`)) return;
      try {
        const res = await api(`/api/markets/${market.slug}/resolve`, { method: 'POST', body: { outcome } });
        toast(`Settled. ${usd(res.totalPayout)} paid out to holders.`, 'success');
        await refreshUser();
        await refreshMarket();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  const cancelBtn = document.getElementById('cancel-btn');
  if (cancelBtn)
    cancelBtn.onclick = async () => {
      if (!confirm('Cancel this market? Everyone is refunded at the current price.')) return;
      try {
        await api(`/api/markets/${market.slug}/resolve`, { method: 'POST', body: { outcome: null } });
        toast('Market cancelled and holders refunded.', 'success');
        await refreshUser();
        await refreshMarket();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
}

async function submitTrade() {
  if (!S.user) return navigate('#/login');
  const preview = computePreview();
  if (!preview) return toast('Enter an amount first.', 'error');
  const market = current.market;
  const body = {
    outcome: S.trade.outcome,
    side: S.trade.side,
    expectedCost: preview.cost,
    slippage: 0.03,
  };
  if (S.trade.side === 'buy') body.budget = preview.cost;
  else body.shares = preview.shares;

  const button = document.getElementById('trade-submit');
  button.disabled = true;
  try {
    const res = await api(`/api/markets/${market.slug}/trade`, { method: 'POST', body });
    S.user = res.user;
    const fill = res.fill;
    toast(
      fill.side === 'buy'
        ? `Bought ${num(fill.shares)} ${fill.outcomeLabel} shares at ${cents(fill.avgPrice)} for ${usd(fill.cost)}.`
        : `Sold ${num(fill.shares)} ${fill.outcomeLabel} shares for ${usd(fill.cost)} (${signed(fill.realized)} realised).`,
      'success',
    );
    S.trade.amount = '';
    for (const badge of res.unlocked ?? []) {
      celebrate();
      toast(`Achievement unlocked — ${badge.title}`, 'success');
    }
    renderNav();
    await refreshMarket();
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
  }
}

async function refreshMarket() {
  const data = await api(`/api/markets/${current.market.slug}`);
  current = data;
  renderMarket();
}

/* ------------------------------------------------------------------ *
 * Portfolio, leaderboard, profiles
 * ------------------------------------------------------------------ */

function positionsTable(positions, { showOwner = false } = {}) {
  if (!positions.length) return '<div class="muted">No open positions yet.</div>';
  return `<table class="data">
      <thead><tr>
        <th>Market</th><th>Bet</th><th class="num">Shares</th><th class="num">Avg</th>
        <th class="num">Now</th><th class="num">Value</th><th class="num">P&amp;L</th>
      </tr></thead>
      <tbody>${positions
        .map(
          (p) => `<tr>
            <td><a href="#/market/${esc(p.slug)}"><span class="market-symbol xs">${esc(p.symbol || 'GEN')}</span> ${esc(p.question.slice(0, 60))}${
              p.question.length > 60 ? '…' : ''
            }</a></td>
            <td><b>${esc(p.outcomeLabel)}</b></td>
            <td class="num mono">${num(p.shares)}</td>
            <td class="num mono">${cents(p.avgPrice)}</td>
            <td class="num mono">${cents(p.price)}</td>
            <td class="num mono">${usd(p.value)}</td>
            <td class="num mono ${cls(p.unrealized)}">${signed(p.unrealized)}</td>
          </tr>`,
        )
        .join('')}</tbody></table>`;
}

function renderPortfolio(data, { own = true } = {}) {
  const s = data.summary;
  setApp(`
    <div class="page-head">
      <div>
        <h1>${own ? 'Your portfolio' : `${esc(data.user.username)}`}</h1>
        <div class="muted">${own ? 'Everything you hold, marked to the current market price.' : `Joined ${dateLabel(data.user.createdAt)}`}</div>
      </div>
    </div>
    <div class="stat-row">
      <div class="stat"><div class="k">Net worth</div><div class="v">${usd(s.netWorth)}</div></div>
      <div class="stat"><div class="k">Cash</div><div class="v">${usd(s.balance)}</div></div>
      <div class="stat"><div class="k">Positions</div><div class="v">${usd(s.positionValue)}</div></div>
      <div class="stat"><div class="k">Unrealised</div><div class="v ${cls(s.unrealized)}">${signed(s.unrealized)}</div></div>
      <div class="stat"><div class="k">Realised</div><div class="v ${cls(s.realized)}">${signed(s.realized)}</div></div>
      <div class="stat"><div class="k">All-time profit</div><div class="v ${cls(s.profit)}">${signed(s.profit)}</div></div>
    </div>
    ${
      s.creatorEquity
        ? `<div class="notice" style="margin-bottom:18px">${usd(
            s.creatorEquity,
          )} of that net worth is liquidity you posted as a market creator. It returns to your balance when those markets settle.</div>`
        : ''
    }
    <div class="card"><h3>Open positions</h3>${positionsTable(data.positions)}</div>
    <div class="section card">
      <h3>Trade history</h3>
      ${
        data.history.length
          ? `<table class="data"><tbody>${data.history
              .slice(0, 40)
              .map(
                (t) => `<tr>
                  <td><a href="#/market/${esc(t.marketSlug)}">${esc((t.marketQuestion || '').slice(0, 52))}${
                    (t.marketQuestion || '').length > 52 ? '…' : ''
                  }</a></td>
                  <td>${
                    t.side === 'settle' ? '<span class="muted">settled</span>' : `<span class="${t.side === 'buy' ? 'pos' : 'neg'}">${t.side}</span>`
                  } <b>${esc(t.outcomes?.[t.outcome] ?? '')}</b></td>
                  <td class="num mono">${num(t.shares)} sh</td>
                  <td class="num mono">${cents(t.avgPrice)}</td>
                  <td class="num mono ${t.cost < 0 ? 'pos' : ''}">${t.cost < 0 ? '+' : '-'}${usd(Math.abs(t.cost))}</td>
                  <td class="num faint">${timeAgo(t.createdAt)}</td>
                </tr>`,
              )
              .join('')}</tbody></table>`
          : '<div class="muted">No trades yet.</div>'
      }
    </div>
  `);
}

async function viewPortfolio() {
  if (!S.user) return navigate('#/login');
  setApp('<div class="loading">Loading portfolio…</div>');
  renderPortfolio(await api('/api/portfolio'));
}

async function viewUser(username) {
  setApp('<div class="loading">Loading profile…</div>');
  const data = await api(`/api/users/${encodeURIComponent(username)}`);
  renderPortfolio(data, { own: S.user?.username === username });
  app().insertAdjacentHTML('beforeend', achievementStrip(data.achievements));
}

async function viewLeaderboard() {
  setApp('<div class="loading">Loading leaderboard…</div>');
  const { users } = await api('/api/leaderboard');
  setApp(`
    <div class="page-head"><div>
      <h1>Leaderboard</h1>
      <div class="muted">Ranked by net worth: cash, open positions and liquidity posted as a market creator.</div>
    </div></div>
    <div class="card"><table class="data">
      <thead><tr><th></th><th>Trader</th><th>Level</th><th class="num">Net worth</th>
      <th class="num">Profit</th><th class="num">ROI</th><th class="num">W/L</th><th class="num">Trades</th></tr></thead>
      <tbody>${users
        .map(
          (u) => `<tr>
            <td class="rank ${u.rank <= 3 ? 'top' : ''}">#${u.rank}</td>
            <td><div class="user-cell">${avatar(u, true)}<a href="#/user/${esc(u.username)}">${esc(u.username)}</a>${
              u.streak > 2 ? `<span class="streak-mini">${u.streak}d</span>` : ''
            }</div></td>
            <td><span class="level-chip">L${u.level.level}</span> <span class="muted">${esc(u.level.name)}</span></td>
            <td class="num mono"><b>${usd(u.netWorth)}</b></td>
            <td class="num mono ${cls(u.profit)}">${signed(u.profit)}</td>
            <td class="num mono ${cls(u.roi)}">${(u.roi * 100).toFixed(1)}%</td>
            <td class="num mono faint">${u.wins}/${u.losses}</td>
            <td class="num mono">${u.trades}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table></div>
  `);
}

/* ------------------------------------------------------------------ *
 * Create market
 * ------------------------------------------------------------------ */

let draftOutcomes = ['Yes', 'No'];

function viewCreate() {
  if (!S.user) return navigate('#/login');
  // Categories sit at the top level of /api/config; the economics live under
  // `settings`. Reading the numbers from the wrong level silently produced
  // subsidy: NaN and a 400 on submit.
  const cfg = S.config;
  const limits = S.config?.settings ?? {};
  const defaultClose = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const binary = draftOutcomes.length === 2 && draftOutcomes[0] === 'Yes' && draftOutcomes[1] === 'No';

  setApp(`
    <div class="page-head"><div>
      <h1>Create a market</h1>
      <div class="muted">You post the liquidity that seeds the market maker, and you settle it when the answer is known.</div>
    </div></div>
    <div class="card form-grid">
      <div class="field">
        <label for="m-question">Question</label>
        <input class="control" id="m-question" maxlength="200" placeholder="Will …?" />
        <div class="hint">Write it so there is exactly one correct answer once the close date passes.</div>
      </div>
      <div class="field">
        <label for="m-description">Resolution criteria</label>
        <textarea class="control" id="m-description" rows="4" maxlength="5000" placeholder="Describe precisely what makes this resolve each way, and the source you will use."></textarea>
      </div>
      <div class="row-2">
        <div class="field">
          <label for="m-category">Category</label>
          <select class="control" id="m-category" style="width:100%">
            ${(cfg?.categories ?? []).map((c) => `<option>${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="m-symbol">Symbol</label>
          <input class="control" id="m-symbol" maxlength="6" placeholder="Optional — e.g. BTC"
                 style="text-transform:uppercase" />
        </div>
      </div>
      <div class="field">
        <label>Outcomes</label>
        <div class="chips" style="margin-bottom:10px">
          <button class="chip ${binary ? 'active' : ''}" id="type-binary">Yes / No</button>
          <button class="chip ${binary ? '' : 'active'}" id="type-multi">Multiple choice</button>
        </div>
        <div class="outcome-editor" id="outcome-editor">
          ${
            binary
              ? '<div class="muted">Shares pay $1.00 if the answer is Yes, nothing otherwise.</div>'
              : draftOutcomes
                  .map(
                    (o, i) => `<div class="line">
                      <input class="control" data-outcome-input="${i}" value="${esc(o)}" maxlength="40" placeholder="Outcome ${i + 1}" />
                      <button data-remove-outcome="${i}" title="Remove" ${draftOutcomes.length <= 2 ? 'disabled' : ''}>×</button>
                    </div>`,
                  )
                  .join('') + '<button class="btn sm ghost" id="add-outcome" style="align-self:flex-start">+ Add outcome</button>'
          }
        </div>
      </div>
      <div class="row-2">
        <div class="field">
          <label for="m-closes">Closes on</label>
          <input class="control" id="m-closes" type="date" value="${defaultClose}" />
        </div>
        <div class="field">
          <label for="m-subsidy">Liquidity subsidy</label>
          <input class="control" id="m-subsidy" type="number" min="${limits.minSubsidy ?? 25}" max="${limits.maxSubsidy ?? 1000}" step="5" value="${limits.defaultSubsidy ?? 100}" />
          <div class="hint">Deducted from your balance (you have ${usd(
            S.user.balance,
          )}) and returned when you settle, plus or minus the market maker's result. More subsidy means prices move less per dollar traded.</div>
        </div>
      </div>
      <div><button class="btn" id="create-submit" style="width:auto;padding-inline:26px">Create market</button></div>
    </div>
  `);

  const el = app();
  el.querySelector('#type-binary').onclick = () => {
    draftOutcomes = ['Yes', 'No'];
    viewCreate();
  };
  el.querySelector('#type-multi').onclick = () => {
    if (draftOutcomes[0] === 'Yes') draftOutcomes = ['', '', ''];
    viewCreate();
  };
  el.querySelectorAll('[data-outcome-input]').forEach((input) => {
    input.oninput = () => {
      draftOutcomes[Number(input.dataset.outcomeInput)] = input.value;
    };
  });
  el.querySelectorAll('[data-remove-outcome]').forEach((button) => {
    button.onclick = () => {
      draftOutcomes.splice(Number(button.dataset.removeOutcome), 1);
      viewCreate();
    };
  });
  const add = el.querySelector('#add-outcome');
  if (add)
    add.onclick = () => {
      if (draftOutcomes.length < 8) draftOutcomes.push('');
      viewCreate();
    };

  el.querySelector('#create-submit').onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const closes = el.querySelector('#m-closes').value;
      const { market } = await api('/api/markets', {
        method: 'POST',
        body: {
          question: el.querySelector('#m-question').value,
          description: el.querySelector('#m-description').value,
          category: el.querySelector('#m-category').value,
          symbol: el.querySelector('#m-symbol').value,
          outcomes: draftOutcomes,
          closesAt: closes ? new Date(`${closes}T23:59:59`).toISOString() : '',
          subsidy: Number(el.querySelector('#m-subsidy').value),
        },
      });
      await refreshUser();
      draftOutcomes = ['Yes', 'No'];
      toast('Market created.', 'success');
      navigate(`#/market/${market.slug}`);
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
    }
  };
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

/** Referral code from either ?ref= or #/signup?ref=. */
function referralFromUrl() {
  const fromSearch = new URLSearchParams(location.search).get('ref');
  const hash = location.hash.split('?')[1] ?? '';
  return fromSearch || new URLSearchParams(hash).get('ref') || null;
}

function viewAuth(mode = 'login') {
  const referral = referralFromUrl();
  setApp(`
    <div class="card auth-card">
      <h1 style="font-size:20px">${mode === 'login' ? 'Sign in' : 'Create an account'}</h1>
      <div class="muted" style="margin-bottom:16px">${
        mode === 'login'
          ? 'Try the demo account: <b>demo</b> / <b>demo123</b>.'
          : `Start with ${usd(S.config?.settings?.welcomeBonus ?? 1000, 0)} in bonus credit — no deposit needed.`
      }</div>
      ${
        referral && mode !== 'login'
          ? `<div class="notice win" style="margin-bottom:14px">Invite code <b>${esc(referral)}</b> applied — an extra ${usd(
              S.config?.settings?.referralBonus ?? 25,
            )} lands in your balance.</div>`
          : ''
      }
      <div class="form-grid">
        <div class="field"><label for="a-user">Username</label><input class="control" id="a-user" autocomplete="username" /></div>
        <div class="field"><label for="a-pass">Password</label><input class="control" id="a-pass" type="password" autocomplete="current-password" /></div>
        <button class="btn" id="a-submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <div class="center muted" style="font-size:13.5px">
          ${
            mode === 'login'
              ? 'No account? <a href="#/signup" style="color:var(--accent)">Sign up</a>'
              : 'Already have one? <a href="#/login" style="color:var(--accent)">Sign in</a>'
          }
        </div>
      </div>
    </div>
  `);

  const submit = async () => {
    const button = document.getElementById('a-submit');
    button.disabled = true;
    try {
      const res = await api(`/api/auth/${mode === 'login' ? 'login' : 'signup'}`, {
        method: 'POST',
        body: {
          username: document.getElementById('a-user').value.trim(),
          password: document.getElementById('a-pass').value,
          referralCode: referralFromUrl(),
        },
      });
      setToken(res.token);
      S.user = res.user;
      renderNav();
      connectStream();
      toast(`Welcome, ${res.user.username}.`, 'success');
      navigate('#/');
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
    }
  };
  document.getElementById('a-submit').onclick = submit;
  document.getElementById('a-pass').onkeydown = (e) => {
    if (e.key === 'Enter') submit();
  };
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

function currentRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, head, tail] = /^\/([^/]*)\/?(.*)$/.exec(hash) ?? [, '', ''];
  return { path: hash, head, tail: decodeURIComponent(tail) };
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const { head, tail } = currentRoute();
  renderNav();
  window.scrollTo(0, 0);
  try {
    switch (head) {
      case '':
        await viewMarkets();
        break;
      case 'dashboard':
        await viewDashboard();
        break;
      case 'market':
        await viewMarket(tail);
        break;
      case 'portfolio':
        await viewPortfolio();
        break;
      case 'leaderboard':
        await viewLeaderboard();
        break;
      case 'wallet':
        await viewWallet();
        break;
      case 'admin':
        await viewAdmin();
        break;
      case 'moderation':
        await viewModeration();
        break;
      case 'create':
        viewCreate();
        break;
      case 'login':
        viewAuth('login');
        break;
      case 'signup':
        viewAuth('signup');
        break;
      case 'user':
        await viewUser(tail);
        break;
      default:
        setApp('<div class="empty">That page does not exist. <a href="#/" style="color:var(--accent)">Back to markets</a></div>');
    }
  } catch (err) {
    // Fallback UI: say what happened, and give a way to recover.
    const offline = !navigator.onLine;
    setApp(`<div class="empty">
        <div class="empty-label">${offline ? 'Offline' : 'Error'}</div>
        <div style="color:var(--text);font-weight:600;margin-bottom:6px">${
          offline ? 'You are offline' : 'That did not load'
        }</div>
        <div style="margin-bottom:16px">${esc(offline ? 'Reconnect and try again — your positions are safe.' : err.message)}</div>
        <button class="btn sm" id="retry-route">Try again</button>
      </div>`);
    const retry = document.getElementById('retry-route');
    if (retry) retry.onclick = () => route();
  }
}

async function refreshUser() {
  if (!S.token) {
    renderNav();
    return;
  }
  try {
    const me = await api('/api/me');
    S.user = me.user;
    S.suspension = me.suspension ?? null;
  } catch {
    setToken(null);
  }
  renderNav();
}

/** Register the service worker so the app can be installed to a home screen. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// and other insecure origins reject registration; ignore quietly.
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/**
 * iOS Safari has no install prompt, so we tell people how instead. Everywhere
 * else we capture the browser's prompt and surface our own button.
 */
let installPrompt = null;

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    renderNav();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    toast(`Installed. ${S.config?.brand?.name ?? 'Tell'} now lives on your home screen.`, 'success');
    renderNav();
  });
}

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

async function promptInstall() {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    renderNav();
    return;
  }
  if (isIos()) {
    toast('In Safari: tap Share, then "Add to Home Screen".', '');
    return;
  }
  toast('Use your browser menu to install this app.', '');
}

async function boot() {
  document.getElementById('search-form').onsubmit = (e) => {
    e.preventDefault();
    S.filters.search = document.getElementById('search-input').value.trim();
    if (currentRoute().head !== '') navigate('#/');
    else viewMarkets();
  };
  let timer;
  document.getElementById('search-input').oninput = (e) => {
    clearTimeout(timer);
    const value = e.target.value.trim();
    timer = setTimeout(() => {
      S.filters.search = value;
      if (currentRoute().head === '') viewMarkets();
    }, 250);
  };

  setupInstallPrompt();
  S.config = await api('/api/config').catch(() => null);
  if (S.config?.brand?.name) {
    document.title = `${S.config.brand.name} — ${S.config.brand.tagline}`;
    document.querySelectorAll('[data-brand]').forEach((el) => {
      el.textContent = S.config.brand.name;
    });
  }
  await refreshUser();
  window.addEventListener('hashchange', route);

  // Payment pages live on real paths, outside the hash router.
  if (location.pathname === '/checkout') {
    renderNav();
    viewCheckout();
  } else if (location.pathname === '/transfer') {
    renderNav();
    await viewTransfer();
  } else {
    route();
  }

  registerServiceWorker();
  refreshTicker();
  refreshNotifications();
  connectStream();

  // The stream carries trades; these are the safety net for a dropped
  // connection or a browser without EventSource, so they run slowly.
  setInterval(() => {
    if (LIVE.status !== 'live') refreshTicker();
  }, 30_000);
  setInterval(() => {
    if (S.user) refreshNotifications();
  }, 60_000);

  // The browser tells us about connectivity long before a request times out.
  window.addEventListener('online', () => {
    LIVE.status = 'connecting';
    renderLiveStatus();
    connectStream();
    route();
  });
  window.addEventListener('offline', () => {
    LIVE.status = 'offline';
    renderLiveStatus();
  });
  // Coming back to a backgrounded tab should not show a stale board.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && LIVE.status !== 'live') connectStream();
  });
}


/* ================================================================== *
 * Live ticker, hero and celebration effects
 * ================================================================== */

/** Colourful confetti burst. Fires when something good happens to you. */
function celebrate(count = 70) {
  const colors = ['#3fb950', '#6ea8fe', '#f5a524', '#e8739f', '#b98cf5', '#eceae4'];
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  for (let i = 0; i < count; i++) {
    const bit = document.createElement('i');
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colors[i % colors.length];
    bit.style.animationDelay = `${Math.random() * 0.4}s`;
    bit.style.animationDuration = `${1.6 + Math.random() * 1.4}s`;
    bit.style.transform = `rotate(${Math.random() * 360}deg)`;
    layer.append(bit);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 3400);
}

/** Countdown string that conveys urgency as the close approaches. */
function countdown(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return { text: 'closed', urgent: true };
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (d >= 2) return { text: `${d}d left`, urgent: false };
  if (d >= 1) return { text: `${d}d ${h}h left`, urgent: true };
  if (h >= 1) return { text: `${h}h ${m}m left`, urgent: true };
  return { text: `${m}m left`, urgent: true };
}

function tickerItem(item) {
  if (item.kind === 'win') {
    return `<a class="tick win" href="#/market/${esc(item.slug)}">
        <span class="tick-symbol">SETTLED</span>
        <b>${esc(item.topWinner.username)}</b><span class="pos">won ${usd(item.topWinner.won)}</span>
        <span class="faint">${esc(item.question.slice(0, 46))}</span>
      </a>`;
  }
  return `<a class="tick" href="#/market/${esc(item.market.slug)}">
      <span class="tick-symbol">${esc(item.market.symbol || 'GEN')}</span>
      <b>${esc(item.user.username)}</b>
      <span class="${item.side === 'buy' ? 'pos' : 'neg'}">${item.side === 'buy' ? 'bought' : 'sold'}</span>
      <b>${esc(item.outcomeLabel)}</b>
      <span class="muted">${usd(item.cost)} @ ${cents(item.price)}</span>
      <span class="faint">${esc(item.market.question.slice(0, 46))}${item.market.question.length > 46 ? '…' : ''}</span>
    </a>`;
}

async function refreshTicker() {
  const rail = document.getElementById('ticker-rail');
  if (!rail) return;
  try {
    const { activity } = await api('/api/activity?limit=22');
    if (!activity.length) return;
    S.activity = activity;
    paintTicker();
  } catch {
    /* the ticker is decoration — never let it break the page */
  }
}

/**
 * What a first-time visitor sees.
 *
 * The hero this replaces led with a tagline and a row of platform numbers,
 * which tells someone nothing about why they should care. The name is the
 * argument: a tell is what someone believes rather than what they say, which
 * is exactly the difference between a market and a poll.
 */
function heroSection(stats) {
  if (S.user) return statsStrip(stats);
  return `<section class="welcome">
      <div class="welcome-copy">
        <div class="label">${esc(S.config?.brand?.name ?? 'Tell')}</div>
        <h1>A tell is what someone believes,<br />not what they say.</h1>
        <p>Opinions are free. A price is what people will actually risk money on — which is why a
        market beats a poll. Turn any question into one, take a side, and sell whenever you like.</p>
        <div class="welcome-steps">
          <div class="welcome-step"><span class="n">01</span><div>
            <b>Read the price as a probability</b>
            <p>A share pays ${usd(1)} if the outcome happens. At 62¢ the market is saying 62 per cent.</p>
          </div></div>
          <div class="welcome-step"><span class="n">02</span><div>
            <b>Take the side you think is mispriced</b>
            <p>No order book, no waiting for a counterparty — the market maker always quotes both sides.</p>
          </div></div>
          <div class="welcome-step"><span class="n">03</span><div>
            <b>Close whenever you like</b>
            <p>You are not locked in until settlement. Sell the moment the price moves your way.</p>
          </div></div>
        </div>
        <div class="welcome-go">
          <a class="btn sm" href="#/signup">Open an account — ${usd(
            S.config?.settings?.welcomeBonus ?? 1000,
            0,
          )} to start with</a>
          <a class="ghostish" href="#/login">Sign in</a>
        </div>
      </div>
      ${statsStrip(stats)}
    </section>`;
}

/** The platform's own numbers, on one rule. */
function statsStrip(stats) {
  if (!stats) return '';
  const cell = (label, value) => `<div class="figure"><div class="label">${label}</div><dd>${value}</dd></div>`;
  return `<dl class="figures">
      ${cell('24h volume', usd(stats.volume24h, 0))}
      ${cell('24h trades', stats.trades24h.toLocaleString('en-US'))}
      ${cell('Open markets', String(stats.openMarkets))}
      ${cell('Traders', stats.traders.toLocaleString('en-US'))}
    </dl>`;
}

/* ================================================================== *
 * Notifications
 * ================================================================== */

async function refreshNotifications() {
  if (!S.user) {
    S.notifications = { unread: 0, items: [] };
    return;
  }
  try {
    const data = await api('/api/notifications');
    const previous = S.notifications?.items?.[0]?.id ?? null;
    S.notifications = data;
    const newest = data.items[0];
    // A brand new win notification is worth a celebration.
    if (newest && newest.id !== previous && previous !== null && !newest.read) {
      if (newest.kind === 'win' || newest.kind === 'achievement') celebrate();
      toast(newest.title, newest.kind === 'loss' ? '' : 'success');
    }
    renderNav();
  } catch {
    /* ignore */
  }
}

function notificationPanel() {
  const items = S.notifications?.items ?? [];
  return `<div class="popover" id="notif-panel">
      <div class="popover-head"><b>Notifications</b>${
        S.notifications?.unread ? '<button class="linkish" id="notif-read">Mark all read</button>' : ''
      }</div>
      ${
        items.length
          ? items
              .slice(0, 20)
              .map(
                (n) => `<a class="notif ${n.read ? '' : 'unread'}" href="${esc(n.href || '#/')}">
                  <div class="notif-title">${esc(n.title)}</div>
                  <div class="notif-body">${esc(n.body)}</div>
                  <div class="faint" style="font-size:11.5px">${timeAgo(n.createdAt)}</div>
                </a>`,
              )
              .join('')
          : '<div class="muted" style="padding:14px">Nothing yet. Place a trade and we will keep you posted.</div>'
      }
    </div>`;
}

/* ================================================================== *
 * Daily bonus
 * ================================================================== */

async function claimBonus() {
  try {
    const result = await api('/api/bonus/claim', { method: 'POST' });
    S.user = result.user;
    celebrate(90);
    toast(`Day ${result.streak} streak — ${usd(result.amount)} added.`, 'success');
    renderNav();
    if (currentRoute().head === 'wallet') viewWallet();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ================================================================== *
 * Wallet
 * ================================================================== */

async function viewWallet() {
  if (!S.user) return navigate('#/login');
  setApp('<div class="loading">Loading wallet…</div>');
  const [wallet, referrals] = await Promise.all([api('/api/wallet'), api('/api/referrals')]);
  const cfg = S.config?.settings ?? {};
  const level = wallet.user.level;
  const link = `${location.origin}/#/signup?ref=${referrals.code}`;

  setApp(`
    <div class="page-head"><div>
      <h1>Wallet</h1>
      <div class="muted">Deposits, withdrawals and every credit that has ever touched your account.</div>
    </div></div>

    <div class="stat-row">
      <div class="stat"><div class="k">Cash</div><div class="v">${usd(wallet.cash)}</div><div class="faint" style="font-size:12px">withdrawable funds</div></div>
      <div class="stat"><div class="k">Bonus credit</div><div class="v">${usd(wallet.user.bonusBalance)}</div><div class="faint" style="font-size:12px">playable, not cashable</div></div>
      <div class="stat"><div class="k">Available to withdraw</div><div class="v ${wallet.withdrawable > 0 ? 'pos' : ''}">${usd(wallet.withdrawable)}</div>
        ${
          wallet.wageringRemaining > 0
            ? `<div class="faint" style="font-size:12px">${usd(wallet.wageringRemaining)} more volume needed</div>`
            : '<div class="faint" style="font-size:12px">ready to go</div>'
        }
      </div>
      <div class="stat"><div class="k">Level ${level.level} · ${esc(level.name)}</div>
        <div class="v">${Math.round(level.xp).toLocaleString('en-US')} XP</div>
        <div class="xp-bar"><span style="width:${(level.progress * 100).toFixed(1)}%"></span></div>
        <div class="faint" style="font-size:12px">${
          level.nextName ? `${Math.round(level.nextLevelXp - level.xp).toLocaleString('en-US')} XP to ${esc(level.nextName)}` : 'max level'
        }</div>
      </div>
    </div>

    <div class="row-2">
      <div class="card">
        <h3>Add funds</h3>
        <div class="amount-field"><span class="prefix">$</span>
          <input id="dep-amount" type="text" inputmode="decimal" placeholder="${cfg.minDeposit ?? 10}" />
        </div>
        <div class="quick">
          ${[25, 50, 100, 250].map((v) => `<button data-dep="${v}">$${v}</button>`).join('')}
        </div>
        <button class="btn" id="dep-go">Continue to checkout</button>
        <div class="faint" style="font-size:12px;margin-top:8px">
          Min ${usd(cfg.minDeposit ?? 10, 0)}, max ${usd(cfg.maxDeposit ?? 5000, 0)} per deposit.
          Provider: <b>${esc(S.config?.paymentProvider ?? 'mock')}</b>${
            S.config?.paymentProvider === 'mock' ? ' — sandbox, no real money moves.' : ''
          }
        </div>
      </div>

      <div class="card">
        <h3>Withdraw</h3>
        <div class="amount-field"><span class="prefix">$</span>
          <input id="wd-amount" type="text" inputmode="decimal" placeholder="${cfg.minWithdrawal ?? 20}" />
        </div>
        <div class="field" style="margin-bottom:10px">
          <input class="control" id="wd-dest" placeholder="Payout destination (IBAN, wallet address…)" />
        </div>
        <button class="btn ghost" id="wd-go" ${wallet.withdrawable <= 0 ? 'disabled' : ''}>Request withdrawal</button>
        <div class="faint" style="font-size:12px;margin-top:8px">
          ${
            wallet.wageringRemaining > 0
              ? `Bonus funds carry a ${usd(wallet.wageringRequired, 0)} turnover requirement. ${usd(
                  wallet.wageringRemaining,
                )} to go.`
              : `Minimum ${usd(cfg.minWithdrawal ?? 20, 0)}. Fee: ${pct(cfg.withdrawalFeeRate ?? 0, 1)}${
                  cfg.withdrawalFeeFlat ? ` + ${usd(cfg.withdrawalFeeFlat)}` : ''
                }. Reviewed by an admin before payout.`
          }
        </div>
      </div>
    </div>

    <div class="section card referral-card">
      <h3>Invite friends, both get paid</h3>
      <div class="muted" style="margin-bottom:12px">You and everyone you bring in get ${usd(
        cfg.referralBonus ?? 25,
      )} in bonus credit. ${referrals.invited} joined so far, ${usd(referrals.earned)} earned.</div>
      <div class="copy-row">
        <input class="control mono" id="ref-link" readonly value="${esc(link)}" />
        <button class="btn sm" id="ref-copy">Copy</button>
      </div>
    </div>

    ${
      wallet.deposits.length || wallet.withdrawals.length
        ? `<div class="section card">
            <h3>Payments</h3>
            <table class="data">
              <thead><tr><th>Type</th><th>Reference</th><th class="num">Amount</th><th>Status</th><th class="num">When</th></tr></thead>
              <tbody>
                ${wallet.deposits
                  .map(
                    (d) => `<tr><td>Deposit</td><td class="mono faint">${esc(d.reference.slice(0, 16))}</td>
                      <td class="num mono pos">+${usd(d.amount)}</td>
                      <td><span class="tag ${d.status === 'succeeded' ? 'resolved' : ''}">${esc(d.status)}</span></td>
                      <td class="num faint">${timeAgo(d.createdAt)}</td></tr>`,
                  )
                  .join('')}
                ${wallet.withdrawals
                  .map(
                    (w) => `<tr><td>Withdrawal</td><td class="mono faint">${esc(w.destination.slice(0, 16))}</td>
                      <td class="num mono neg">-${usd(w.amount)}</td>
                      <td><span class="tag ${w.status === 'paid' ? 'resolved' : w.status === 'rejected' ? 'closed' : ''}">${esc(w.status)}</span></td>
                      <td class="num faint">${timeAgo(w.createdAt)}</td></tr>`,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>`
        : ''
    }

    <div class="section card">
      <h3>Statement</h3>
      <table class="data">
        <thead><tr><th>Entry</th><th>Detail</th><th class="num">Amount</th><th class="num">Balance</th><th class="num">When</th></tr></thead>
        <tbody>${wallet.statement
          .map(
            (e) => `<tr>
              <td>${esc(kindLabel(e.kind))}${e.account === 'bonus' ? ' <span class="tag">bonus</span>' : ''}</td>
              <td class="muted">${esc(e.marketQuestion ? e.marketQuestion.slice(0, 46) : e.memo)}</td>
              <td class="num mono ${e.amount >= 0 ? 'pos' : 'neg'}">${e.amount >= 0 ? '+' : '−'}${usd(Math.abs(e.amount))}</td>
              <td class="num mono faint">${e.balanceAfter === null ? '' : usd(e.balanceAfter)}</td>
              <td class="num faint">${timeAgo(e.createdAt)}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </div>

    <div class="section card">
      <h3>Play limits</h3>
      <div class="muted" style="margin-bottom:12px">Set your own ceiling, or take a break. Limits apply immediately and a break cannot be lifted early.</div>
      <div class="row-2">
        <div class="field">
          <label for="lim-deposit">24-hour deposit limit</label>
          <input class="control" id="lim-deposit" type="number" min="0" step="10" value="${
            wallet.profile.depositLimit ?? ''
          }" placeholder="No personal limit" />
        </div>
        <div class="field">
          <label for="lim-exclude">Take a break</label>
          <select class="control" id="lim-exclude" style="width:100%">
            <option value="">Keep trading</option>
            <option value="1">24 hours</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="180">6 months</option>
          </select>
        </div>
      </div>
      <button class="btn sm ghost" id="lim-save" style="margin-top:10px">Save limits</button>
    </div>
  `);

  const el = app();
  el.querySelectorAll('[data-dep]').forEach((b) => {
    b.onclick = () => {
      el.querySelector('#dep-amount').value = b.dataset.dep;
    };
  });
  el.querySelector('#dep-go').onclick = async (event) => {
    event.currentTarget.disabled = true;
    try {
      const { checkoutUrl } = await api('/api/wallet/deposit', {
        method: 'POST',
        body: { amount: Number(el.querySelector('#dep-amount').value) },
      });
      location.href = checkoutUrl;
    } catch (err) {
      toast(err.message, 'error');
      event.currentTarget.disabled = false;
    }
  };
  el.querySelector('#wd-go').onclick = async (event) => {
    event.currentTarget.disabled = true;
    try {
      const res = await api('/api/wallet/withdraw', {
        method: 'POST',
        body: { amount: Number(el.querySelector('#wd-amount').value), destination: el.querySelector('#wd-dest').value },
      });
      S.user = res.user;
      renderNav();
      toast(`Withdrawal of ${usd(res.withdrawal.net)} requested. An admin will review it.`, 'success');
      viewWallet();
    } catch (err) {
      toast(err.message, 'error');
      event.currentTarget.disabled = false;
    }
  };
  el.querySelector('#ref-copy').onclick = async () => {
    const input = el.querySelector('#ref-link');
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Invite link copied.', 'success');
    } catch {
      toast('Select and copy the link.', '');
    }
  };
  el.querySelector('#lim-save').onclick = async () => {
    const excludeDays = el.querySelector('#lim-exclude').value;
    if (excludeDays && !confirm(`Take a break for ${excludeDays} day(s)? This cannot be undone early.`)) return;
    try {
      await api('/api/limits', {
        method: 'POST',
        body: { depositLimit: el.querySelector('#lim-deposit').value || null, excludeDays: excludeDays || undefined },
      });
      toast('Limits saved.', 'success');
      viewWallet();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

const KIND_LABELS = {
  deposit: 'Deposit',
  withdrawal_hold: 'Withdrawal',
  withdrawal_refund: 'Withdrawal returned',
  trade_buy: 'Bought shares',
  trade_sell: 'Sold shares',
  payout: 'Settlement payout',
  refund: 'Market cancelled',
  subsidy: 'Liquidity posted',
  subsidy_return: 'Liquidity returned',
  creator_fee: 'Creator fee earned',
  listing_fee: 'Listing fee',
  welcome_bonus: 'Welcome bonus',
  daily_bonus: 'Daily bonus',
  referral: 'Referral bonus',
};
const kindLabel = (kind) => KIND_LABELS[kind] ?? kind.replace(/_/g, ' ');

/* ================================================================== *
 * Sandbox checkout (mock payment provider)
 * ================================================================== */

function viewCheckout() {
  const params = new URLSearchParams(location.search);
  const reference = params.get('ref');
  const amount = Number(params.get('amount') || 0);
  if (!reference) return navigate('#/wallet');

  setApp(`
    <div class="card auth-card checkout">
      <div class="checkout-brand">${esc(S.config?.brand?.name ?? 'Tell')} · secure checkout</div>
      <div class="checkout-amount">${usd(amount)}</div>
      <div class="muted center" style="margin-bottom:18px">Sandbox payment — no real money moves. A live provider would take over from here.</div>
      <div class="fake-card">
        <div class="fake-card-row"><span>Card</span><b class="mono">4242 4242 4242 4242</b></div>
        <div class="fake-card-row"><span>Expiry</span><b class="mono">12 / 30</b></div>
        <div class="fake-card-row"><span>CVC</span><b class="mono">123</b></div>
      </div>
      <button class="btn" id="pay-now">Pay ${usd(amount)}</button>
      <button class="btn ghost" id="pay-fail" style="margin-top:8px">Simulate a failed payment</button>
      <div class="faint center" style="margin-top:12px;font-size:12px">Reference ${esc(reference)}</div>
    </div>
  `);

  const finish = async (fail) => {
    try {
      const res = await api('/api/wallet/deposit/confirm', { method: 'POST', body: { reference, fail } });
      if (fail) {
        toast('Payment failed. Nothing was charged.', 'error');
      } else {
        S.user = res.user;
        celebrate();
        toast(`${usd(amount)} added to your balance.`, 'success');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    // Leave the checkout path with a real navigation so the app boots clean.
    location.replace('/#/wallet');
  };
  document.getElementById('pay-now').onclick = () => finish(false);
  document.getElementById('pay-fail').onclick = () => finish(true);
}

/* ================================================================== *
 * Bank-transfer instructions (providers with no hosted checkout)
 * ================================================================== */

async function viewTransfer() {
  const params = new URLSearchParams(location.search);
  const reference = params.get('ref');
  const amount = Number(params.get('amount') || 0);
  if (!reference) return location.replace('/#/wallet');
  if (!S.user) return location.replace('/#/login');

  const { instructions } = await api('/api/wallet/instructions').catch(() => ({ instructions: null }));
  if (!instructions) {
    setApp('<div class="empty">This deposit method is not configured.</div>');
    return;
  }

  const rows = [
    ['Account holder', instructions.holder],
    ['IBAN', instructions.iban],
    ['BIC / SWIFT', instructions.bic],
    ['Bank', instructions.bank],
    ['Amount', `${usd(amount)} ${esc(instructions.currency ?? '')}`],
  ].filter(([, value]) => value);

  setApp(`
    <div class="card auth-card checkout" style="max-width:460px">
      <div class="checkout-brand">${esc(S.config?.brand?.name ?? 'Tell')} · bank transfer</div>
      <div class="checkout-amount">${usd(amount)}</div>
      <div class="muted center" style="margin-bottom:18px">
        Send a normal bank transfer with the reference below. It is the only thing that tells us the money is yours,
        so it has to be included exactly.
      </div>

      <div class="reference-box">
        <div class="faint" style="font-size:11.5px;letter-spacing:.08em;text-transform:uppercase">Payment reference</div>
        <div class="reference-value mono" id="ref-value">${esc(reference)}</div>
        <button class="btn sm ghost" id="copy-ref">Copy reference</button>
      </div>

      <div class="fake-card" style="margin-top:16px">
        ${rows
          .map(([label, value]) => `<div class="fake-card-row"><span>${esc(label)}</span><b class="mono">${esc(value)}</b></div>`)
          .join('')}
      </div>

      <div class="notice warn" style="margin-bottom:14px">
        Bank transfers are not instant. Your balance updates once the money arrives — usually the same day for SEPA,
        longer across borders. You can close this page.
      </div>
      <a class="btn" href="/#/wallet" style="display:block;text-align:center;text-decoration:none">Back to wallet</a>
    </div>
  `);

  document.getElementById('copy-ref').onclick = async () => {
    try {
      await navigator.clipboard.writeText(reference);
      toast('Reference copied. Paste it into your transfer.', 'success');
    } catch {
      toast('Copy the reference by hand — it must match exactly.', '');
    }
  };
}

/* ================================================================== *
 * Admin: revenue, payouts and the fee dials
 * ================================================================== */

const SETTING_GROUPS = [
  {
    title: 'Revenue',
    hint: 'These are the dials that decide what the house earns.',
    keys: [
      ['platformFeeRate', 'Platform fee', 'percent'],
      ['creatorFeeRate', 'Creator fee', 'percent'],
      ['listingFee', 'Market listing fee', 'money'],
      ['withdrawalFeeRate', 'Withdrawal fee', 'percent'],
      ['withdrawalFeeFlat', 'Withdrawal flat fee', 'money'],
    ],
  },
  {
    title: 'Payments',
    keys: [
      ['minDeposit', 'Minimum deposit', 'money'],
      ['maxDeposit', 'Maximum deposit', 'money'],
      ['minWithdrawal', 'Minimum withdrawal', 'money'],
      ['dailyDepositLimit', 'Default 24h deposit cap', 'money'],
      ['wageringMultiplier', 'Bonus turnover multiple', 'number'],
    ],
  },
  {
    title: 'Growth',
    keys: [
      ['welcomeBonus', 'Welcome bonus', 'money'],
      ['dailyBonusBase', 'Daily bonus per streak day', 'money'],
      ['dailyBonusMax', 'Daily bonus cap', 'money'],
      ['referralBonus', 'Referral bonus', 'money'],
    ],
  },
];

function revenueBars(series) {
  if (!series.length) return '<div class="muted">No revenue booked yet.</div>';
  const max = Math.max(...series.map((d) => d.total), 0.01);
  return `<div class="bars">${series
    .map(
      (d) =>
        `<div class="bar-col" title="${esc(d.day)}: ${usd(d.total)}">
          <span style="height:${Math.max(2, (d.total / max) * 100)}%"></span>
        </div>`,
    )
    .join('')}</div>
    <div class="bars-axis"><span>${esc(series[0].day)}</span><span>${esc(series.at(-1).day)}</span></div>`;
}

async function viewAdmin() {
  if (!S.user?.isAdmin) {
    setApp('<div class="empty">Admins only.</div>');
    return;
  }
  setApp('<div class="loading">Loading control room…</div>');
  const data = await api('/api/admin/overview');
  S.openReports = data.reports?.open ?? 0;
  renderNav();

  setApp(`
    <div class="page-head"><div>
      <h1>Control room</h1>
      <div class="muted">Where the money is, and the dials that decide how much of it you keep.</div>
    </div></div>

    <div class="stat-row">
      <div class="stat accent"><div class="k">Treasury</div><div class="v">${usd(data.treasury)}</div><div class="faint" style="font-size:12px">all-time platform revenue</div></div>
      <div class="stat"><div class="k">Revenue 24h</div><div class="v pos">${usd(data.revenue24h)}</div></div>
      <div class="stat"><div class="k">Deposits</div><div class="v">${usd(data.deposits.total)}</div><div class="faint" style="font-size:12px">${data.deposits.count} payments</div></div>
      <div class="stat"><div class="k">Paid out</div><div class="v">${usd(data.withdrawals.total)}</div><div class="faint" style="font-size:12px">${data.withdrawals.count} withdrawals</div></div>
      <div class="stat"><div class="k">User balances</div><div class="v">${usd(data.liabilities)}</div><div class="faint" style="font-size:12px">what you owe traders</div></div>
      <div class="stat"><div class="k">Volume 24h</div><div class="v">${usd(data.stats.volume24h, 0)}</div><div class="faint" style="font-size:12px">${data.stats.trades24h} trades</div></div>
    </div>

    <div class="row-2">
      <div class="card">
        <h3>Revenue, last 30 days</h3>
        ${revenueBars(data.revenueByDay)}
      </div>
      <div class="card">
        <h3>Where it comes from</h3>
        <table class="data">
          <thead><tr><th>Source</th><th class="num">Events</th><th class="num">Total</th></tr></thead>
          <tbody>${
            data.revenueByKind.length
              ? data.revenueByKind
                  .map(
                    (r) =>
                      `<tr><td>${esc(kindLabel(r.kind))}</td><td class="num mono">${r.count}</td><td class="num mono pos">${usd(r.total)}</td></tr>`,
                  )
                  .join('')
              : '<tr><td colspan="3" class="muted">Nothing yet.</td></tr>'
          }</tbody>
        </table>
      </div>
    </div>

    ${
      S.config?.paymentProvider === 'wise'
        ? `<div class="section card">
            <h3>Bank reconciliation</h3>
            <div class="muted" style="margin-bottom:10px">Match incoming transfers against pending deposits. Runs automatically on every webhook; use this if one was missed.</div>
            <button class="btn sm" id="reconcile-btn">Reconcile now</button>
            <span id="reconcile-result" class="muted" style="margin-left:10px"></span>
          </div>`
        : ''
    }

    <div class="section card">
      <h3>Pending withdrawals (${data.pendingWithdrawals.length})</h3>
      ${
        data.pendingWithdrawals.length
          ? `<table class="data">
              <thead><tr><th>User</th><th>Destination</th><th class="num">Gross</th><th class="num">Fee</th><th class="num">Net</th><th class="num">Requested</th><th></th></tr></thead>
              <tbody>${data.pendingWithdrawals
                .map(
                  (w) => `<tr>
                    <td><a href="#/user/${esc(w.user.username)}">${esc(w.user.username)}</a></td>
                    <td class="mono faint">${esc(w.destination.slice(0, 28))}</td>
                    <td class="num mono">${usd(w.amount)}</td>
                    <td class="num mono">${usd(w.fee)}</td>
                    <td class="num mono">${usd(w.net)}</td>
                    <td class="num faint">${timeAgo(w.createdAt)}</td>
                    <td class="num" style="white-space:nowrap">
                      <button class="btn sm" data-approve="${w.id}">Approve</button>
                      <button class="btn sm ghost" data-reject="${w.id}">Reject</button>
                    </td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table>`
          : '<div class="muted">Nothing waiting for review.</div>'
      }
    </div>

    <div class="section card">
      <h3>Economics</h3>
      <div class="muted" style="margin-bottom:14px">Changes take effect on the very next trade. Fees are charged on trade notional and split between the house and the market creator.</div>
      ${SETTING_GROUPS.map(
        (group) => `<div class="setting-group">
          <div class="setting-title">${esc(group.title)}</div>
          ${group.hint ? `<div class="faint" style="font-size:12.5px;margin-bottom:10px">${esc(group.hint)}</div>` : ''}
          <div class="setting-grid">
            ${group.keys
              .map(
                ([key, label, type]) => `<div class="field">
                  <label for="set-${key}">${esc(label)}${type === 'percent' ? ' (%)' : ''}</label>
                  <input class="control" id="set-${key}" data-setting="${key}" data-type="${type}" type="number"
                         step="${type === 'percent' ? '0.05' : '1'}" min="0"
                         value="${type === 'percent' ? (data.settings[key] * 100).toFixed(2) : data.settings[key]}" />
                </div>`,
              )
              .join('')}
          </div>
        </div>`,
      ).join('')}
      <div class="setting-preview" id="fee-preview"></div>
      <button class="btn" id="settings-save" style="width:auto;padding-inline:26px;margin-top:12px">Save economics</button>
    </div>
  `);

  const el = app();
  const updatePreview = () => {
    const platform = Number(el.querySelector('#set-platformFeeRate').value) / 100;
    const creator = Number(el.querySelector('#set-creatorFeeRate').value) / 100;
    const volume = data.stats.volume24h || 0;
    el.querySelector('#fee-preview').innerHTML = `
      Total fee <b>${pct(platform + creator, 2)}</b> per trade — house keeps <b>${pct(platform, 2)}</b>,
      creators get <b>${pct(creator, 2)}</b>.
      At yesterday's ${usd(volume, 0)} of volume that is <b class="pos">${usd(volume * platform)}</b> to the treasury per day,
      about <b class="pos">${usd(volume * platform * 365, 0)}</b> a year.`;
  };
  el.querySelectorAll('[data-setting]').forEach((input) => {
    input.oninput = updatePreview;
  });
  updatePreview();

  el.querySelector('#settings-save').onclick = async (event) => {
    event.currentTarget.disabled = true;
    const patch = {};
    el.querySelectorAll('[data-setting]').forEach((input) => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      patch[input.dataset.setting] = input.dataset.type === 'percent' ? value / 100 : value;
    });
    try {
      await api('/api/admin/settings', { method: 'POST', body: patch });
      S.config = await api('/api/config');
      toast('Economics updated. Live from the next trade.', 'success');
      viewAdmin();
    } catch (err) {
      toast(err.message, 'error');
      event.currentTarget.disabled = false;
    }
  };

  const decide = async (id, approve) => {
    try {
      await api(`/api/admin/withdrawals/${id}`, { method: 'POST', body: { approve } });
      toast(approve ? 'Withdrawal approved and paid.' : 'Withdrawal rejected and refunded.', 'success');
      viewAdmin();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const reconcile = el.querySelector('#reconcile-btn');
  if (reconcile)
    reconcile.onclick = async () => {
      reconcile.disabled = true;
      try {
        const result = await api('/api/admin/reconcile', { method: 'POST', body: { days: 7 } });
        el.querySelector('#reconcile-result').textContent = result.skipped
          ? result.skipped
          : `Scanned ${result.scanned ?? 0} entries, settled ${result.settled?.length ?? 0}.`;
        if (result.settled?.length) toast(`Settled ${result.settled.length} deposit(s).`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
      reconcile.disabled = false;
    };

  el.querySelectorAll('[data-approve]').forEach((b) => (b.onclick = () => decide(b.dataset.approve, true)));
  el.querySelectorAll('[data-reject]').forEach((b) => (b.onclick = () => decide(b.dataset.reject, false)));
}

/* ================================================================== *
 * Achievements strip, used on profiles
 * ================================================================== */

function achievementStrip(achievements) {
  if (!achievements?.length) return '';
  return `<div class="section card">
      <h3>Achievements (${achievements.filter((a) => a.earned).length}/${achievements.length})</h3>
      <div class="badges">
        ${achievements
          .map(
            (a) => `<div class="badge ${a.earned ? 'earned' : ''}" title="${esc(a.hint)}">
              <span class="badge-mark">${a.earned ? '\u2713' : '\u2014'}</span>
              <span class="badge-title">${esc(a.title)}</span>
              <span class="badge-hint">${esc(a.earned ? 'unlocked' : a.hint)}</span>
            </div>`,
          )
          .join('')}
      </div>
    </div>`;
}



/* ================================================================== *
 * Live stream: server-sent events replace the polling loops
 * ================================================================== */

const LIVE = { source: null, status: 'connecting', retry: 0, timer: null };

/** Paint the connection state into the ticker label. */
function renderLiveStatus() {
  const label = document.querySelector('.ticker-label');
  if (!label) return;
  const text = { live: 'LIVE', connecting: 'CONNECTING', offline: 'OFFLINE' }[LIVE.status] ?? 'LIVE';
  label.textContent = text;
  label.dataset.status = LIVE.status;
  label.title =
    LIVE.status === 'live'
      ? 'Streaming live trades'
      : LIVE.status === 'connecting'
        ? 'Reconnecting to the live feed…'
        : 'No connection — prices may be stale';
  document.body.classList.toggle('is-offline', LIVE.status === 'offline');
}

function connectStream() {
  if (!('EventSource' in window)) return; // falls back to the polling below
  LIVE.source?.close();
  LIVE.status = 'connecting';
  renderLiveStatus();

  const url = S.token ? `/api/stream?token=${encodeURIComponent(S.token)}` : '/api/stream';
  const source = new EventSource(url);
  LIVE.source = source;

  source.onopen = () => {
    LIVE.status = 'live';
    LIVE.retry = 0;
    renderLiveStatus();
  };

  source.onerror = () => {
    // EventSource retries on its own, but only while the response was valid.
    // Back off and rebuild the connection so an auth change is picked up too.
    LIVE.status = navigator.onLine ? 'connecting' : 'offline';
    renderLiveStatus();
    source.close();
    clearTimeout(LIVE.timer);
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(LIVE.retry++, 5));
    LIVE.timer = setTimeout(connectStream, delay);
  };

  source.addEventListener('trade', (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    onTradeEvent(frame);
  });

  source.addEventListener('settled', (event) => {
    try {
      const frame = JSON.parse(event.data);
      // A payout is the most persuasive thing on the platform — show it.
      if (frame.topWinner) {
        S.activity = [{ kind: 'win', id: `win-${frame.at}`, ...frame }, ...S.activity].slice(0, 22);
        paintTicker();
      }
      if (current?.market?.slug === frame.slug) refreshMarket();
      if (S.user) refreshNotifications();
    } catch {
      /* ignore malformed frame */
    }
  });
}

/** Fold a live trade into whatever the user is currently looking at. */
function onTradeEvent(frame) {
  // 1. The ticker gains the newest trade without a round trip.
  S.activity = [
    {
      id: `live-${frame.at}`,
      side: frame.fill.side,
      shares: frame.fill.shares,
      cost: frame.fill.cost,
      price: frame.fill.price,
      outcomeLabel: frame.fill.outcomeLabel,
      user: frame.user,
      market: frame.market,
      createdAt: new Date(frame.at).toISOString(),
    },
    ...S.activity,
  ].slice(0, 22);
  paintTicker();

  // 2. Headline stats move immediately rather than on the next poll.
  if (S.stats) {
    S.stats = { ...S.stats, volume24h: S.stats.volume24h + frame.fill.cost, trades24h: S.stats.trades24h + 1 };
    const figures = document.querySelectorAll('.figures .figure dd');
    if (figures.length >= 2 && ['', 'dashboard'].includes(currentRoute().head)) {
      // Only the platform strip leads with 24h volume; the dashboard's own
      // figures start with net worth, so leave those to their next render.
      const first = document.querySelector('.figures .figure .label');
      if (first && first.textContent.toLowerCase().startsWith('24h')) {
        figures[0].textContent = usd(S.stats.volume24h, 0);
        figures[1].textContent = S.stats.trades24h.toLocaleString('en-US');
      }
    }
  }

  // 3. The row for that market reprices in place and flashes the direction.
  const row = document.querySelector(`.market-row[data-slug="${CSS.escape(frame.slug)}"]`);
  if (row) {
    const chance = row.querySelector('.col-chance');
    if (chance) {
      const next = frame.prices[0];
      const previous = parseFloat(chance.textContent) / 100;
      chance.textContent = pct(next);
      flash(chance, next >= previous);
    }
    // The Yes/No buttons are what people trade from, so they cannot lag.
    row.querySelectorAll('.take button[data-bet]').forEach((button) => {
      const price = frame.prices[Number(button.dataset.bet)];
      const cell = button.querySelector('b');
      if (cell && price != null) cell.textContent = cents(price);
    });
  }

  // 4. The open market page updates its prices in place — no reload, no flicker.
  if (current?.market?.slug === frame.slug) {
    // Keep the previous share vector so the quote preview still works between
    // the push and the refetch below; the server reprices every fill anyway.
    current.market.outcomes = current.market.outcomes.map((o, i) => ({ ...o, price: frame.prices[i] ?? o.price }));
    current.market.volume = frame.volume;
    const headline = document.querySelector('.headline-price .big');
    if (headline) {
      const lead = leadOutcome(current.market);
      const previous = parseFloat(headline.textContent) / 100;
      headline.textContent = pct(lead.price, 1);
      flash(headline, lead.price >= previous);
    }
    document.querySelectorAll('.outcome-btn').forEach((button, i) => {
      const price = button.querySelector('.price');
      if (price && frame.prices[i] != null) price.textContent = cents(frame.prices[i]);
    });
    scheduleMarketRefresh();
  }
}

/** Briefly tint an element green or red when its number moves. */
function flash(el, up) {
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // restart the animation
  el.classList.add(up ? 'flash-up' : 'flash-down');
}

/**
 * A live price is enough to look at, but the trade panel needs the exact share
 * vector to quote against. Refetch, coalesced so a burst costs one request.
 */
let marketRefreshTimer = null;
function scheduleMarketRefresh() {
  clearTimeout(marketRefreshTimer);
  marketRefreshTimer = setTimeout(() => {
    if (current?.market?.slug) refreshMarket().catch(() => {});
  }, 1200);
}

function paintTicker() {
  const rail = document.getElementById('ticker-rail');
  if (!rail || !S.activity.length) return;
  const markup = S.activity.map(tickerItem).join('');
  rail.innerHTML = markup + markup;
  rail.style.animationDuration = `${Math.max(30, S.activity.length * 3.2)}s`;
}

/* ================================================================== *
 * Depth: how far the price moves as an order gets bigger
 * ================================================================== */

/**
 * An AMM has no order book, so the honest equivalent of depth is the cost
 * curve: for each outcome, the price you would actually pay as size grows.
 * Flat means deep; steep means thin.
 */
function depthCurve(market, outcomeIndex, maxSpend) {
  const points = [];
  const steps = 26;
  for (let i = 1; i <= steps; i++) {
    const spend = (maxSpend * i) / steps;
    const shares = sharesForBudget(market.q, market.b, outcomeIndex, spend / (1 + market.feeRate));
    if (!(shares > 0)) continue;
    const next = market.q.slice();
    next[outcomeIndex] += shares;
    points.push({ spend, avgPrice: spend / shares, marginal: pricesOf(next, market.b)[outcomeIndex] });
  }
  return points;
}

function depthChart(market) {
  if (!market.q || !market.tradable) return '';
  const maxSpend = Math.max(200, Math.round(market.volume / 4));
  const w = 800;
  const h = 210;
  const padL = 40;
  const padR = 12;
  const padT = 12;
  const padB = 26;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const series = market.outcomes.map((outcome) => ({
    outcome,
    points: depthCurve(market, outcome.index, maxSpend),
  }));
  const allPrices = series.flatMap((s) => s.points.map((p) => p.avgPrice));
  if (!allPrices.length) return '';
  const lo = Math.max(0, Math.min(...allPrices) - 0.03);
  const hi = Math.min(1, Math.max(...allPrices) + 0.03);
  const span = Math.max(hi - lo, 0.02);

  const x = (spend) => padL + (spend / maxSpend) * innerW;
  const y = (price) => padT + (1 - (price - lo) / span) * innerH;

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const price = lo + span * (1 - f);
      return `<line x1="${padL}" x2="${w - padR}" y1="${(padT + f * innerH).toFixed(1)}" y2="${(padT + f * innerH).toFixed(1)}" stroke="#1a2231"/>
        <text x="${padL - 7}" y="${(padT + f * innerH + 3.5).toFixed(1)}" fill="#5c6880" font-size="10" text-anchor="end">${cents(price)}</text>`;
    })
    .join('');

  const lines = series
    .map(({ outcome, points }) => {
      if (points.length < 2) return '';
      const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.spend).toFixed(1)},${y(p.avgPrice).toFixed(1)}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${colorFor(market, outcome.index)}" stroke-width="2" stroke-linejoin="round"/>`;
    })
    .join('');

  const ticks = [0.25, 0.5, 0.75, 1]
    .map(
      (f) =>
        `<text x="${x(maxSpend * f).toFixed(1)}" y="${h - 7}" fill="#5c6880" font-size="10" text-anchor="middle">${usd(maxSpend * f, 0)}</text>`,
    )
    .join('');

  return `<div class="section card">
      <h3>Depth — what size costs you</h3>
      <div class="muted" style="margin-bottom:10px;font-size:13.5px">
        Average fill price as an order grows. A flat line is deep liquidity; a steep one means your own order moves the price.
      </div>
      <svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Average fill price by order size">
        ${grid}${ticks}${lines}
      </svg>
      <div class="chart-legend">
        ${market.outcomes
          .map((o) => {
            const points = series[o.index].points;
            const slip = points.length ? (points.at(-1).avgPrice - o.price) / Math.max(o.price, 1e-6) : 0;
            return `<span><span class="key" style="background:${colorFor(market, o.index)}"></span>${esc(o.label)}
              <span class="faint">${usd(maxSpend, 0)} moves you ${(slip * 100).toFixed(1)}%</span></span>`;
          })
          .join('')}
      </div>
    </div>`;
}



/* ================================================================== *
 * Quick bet — take a position without leaving the list
 *
 * This is the single biggest difference between browsing and betting. On
 * Polymarket the Yes/No buttons live on the card itself; the market page is
 * for research, not for the decision. Everything below implements that: tap
 * an outcome, pick a size, confirm, stay where you were.
 * ================================================================== */

const QUICK = { market: null, outcome: 0, amount: 10, busy: false };

/** Amounts people actually pick, biggest last so the eye lands on it. */
const QUICK_AMOUNTS = [5, 10, 25, 50, 100];

function openQuickBet(market, outcome) {
  if (!S.user) {
    toast('Create an account to place a bet — it takes a second.', '');
    return navigate('#/signup');
  }
  if (!market.tradable) return toast('This market is closed.', 'error');
  QUICK.market = market;
  QUICK.outcome = outcome;
  QUICK.amount = Math.min(10, Math.max(1, Math.floor(S.user.balance)));
  QUICK.busy = false;
  renderQuickBet();
}

function closeQuickBet() {
  document.getElementById('quick-bet')?.remove();
  document.removeEventListener('keydown', quickBetKeys);
  QUICK.market = null;
}

function quickBetKeys(event) {
  if (event.key === 'Escape') closeQuickBet();
  if (event.key === 'Enter' && !QUICK.busy) confirmQuickBet();
}

/** Local preview: shares, average price and the payout if it comes in. */
function quickBetPreview() {
  const market = QUICK.market;
  const amount = Number(QUICK.amount);
  if (!market?.q || !(amount > 0)) return null;
  const shares = sharesForBudget(market.q, market.b, QUICK.outcome, amount / (1 + market.feeRate));
  if (!(shares > 0)) return null;
  return { shares, avgPrice: amount / shares, payout: shares, profit: shares - amount };
}

function renderQuickBet() {
  const market = QUICK.market;
  if (!market) return;
  const outcome = market.outcomes[QUICK.outcome];
  const preview = quickBetPreview();
  const affordable = S.user && Number(QUICK.amount) <= S.user.balance + 1e-9;
  const kind = market.isBinary ? (QUICK.outcome === 0 ? 'yes' : 'no') : '';

  document.getElementById('quick-bet')?.remove();
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="sheet-backdrop" id="quick-bet" role="dialog" aria-modal="true" aria-label="Place a bet">
      <div class="sheet">
        <button class="sheet-close" id="qb-close" aria-label="Close">×</button>
        <div class="sheet-market">
          <span class="market-symbol sm">${esc(market.symbol || 'GEN')}</span>
          <span>${esc(market.question)}</span>
        </div>

        <div class="qb-outcomes">
          ${market.outcomes
            .map(
              (o) => `<button class="outcome-btn ${market.isBinary ? (o.index === 0 ? 'yes' : 'no') : ''} ${
                o.index === QUICK.outcome ? 'active' : ''
              }" data-qb-outcome="${o.index}">
                <span>${esc(o.label)}</span><span class="price">${cents(o.price)}</span>
              </button>`,
            )
            .join('')}
        </div>

        <div class="qb-amount">
          <span class="prefix">$</span>
          <input id="qb-input" type="text" inputmode="decimal" value="${esc(String(QUICK.amount))}" aria-label="Amount" />
        </div>
        <div class="quick">
          ${QUICK_AMOUNTS.map((v) => `<button data-qb-amount="${v}" class="${Number(QUICK.amount) === v ? 'on' : ''}">$${v}</button>`).join('')}
          <button data-qb-amount="max">Max</button>
        </div>

        <div class="qb-payout ${kind}">
          ${
            preview
              ? `<div class="qb-payout-main">${usd(preview.payout)}</div>
                 <div class="qb-payout-sub">to win if <b>${esc(outcome.label)}</b> — ${num(preview.shares)} shares at ${cents(preview.avgPrice)}</div>`
              : `<div class="qb-payout-sub">Enter an amount</div>`
          }
        </div>

        <button class="btn ${kind}" id="qb-confirm" ${!preview || !affordable || QUICK.busy ? 'disabled' : ''}>
          ${
            QUICK.busy
              ? 'Placing…'
              : !affordable
                ? `Balance is ${usd(S.user?.balance ?? 0)}`
                : `Bet ${usd(Number(QUICK.amount))} on ${esc(outcome.label)}`
          }
        </button>
        <div class="qb-foot faint">Balance ${usd(S.user?.balance ?? 0)} · fee ${pct(market.feeRate, 1)} · you can sell any time before it closes</div>
      </div>
    </div>`,
  );

  const sheet = document.getElementById('quick-bet');
  sheet.onclick = (event) => {
    if (event.target === sheet) closeQuickBet();
  };
  sheet.querySelector('#qb-close').onclick = closeQuickBet;
  sheet.querySelectorAll('[data-qb-outcome]').forEach((b) => {
    b.onclick = () => {
      QUICK.outcome = Number(b.dataset.qbOutcome);
      renderQuickBet();
    };
  });
  sheet.querySelectorAll('[data-qb-amount]').forEach((b) => {
    b.onclick = () => {
      QUICK.amount =
        b.dataset.qbAmount === 'max'
          ? Math.floor((S.user?.balance ?? 0) * 100) / 100
          : Number(b.dataset.qbAmount);
      renderQuickBet();
    };
  });
  const input = sheet.querySelector('#qb-input');
  input.oninput = () => {
    QUICK.amount = input.value.replace(/[^0-9.]/g, '');
    const preview = quickBetPreview();
    const payout = sheet.querySelector('.qb-payout-main');
    if (payout && preview) payout.textContent = usd(preview.payout);
    const confirm = sheet.querySelector('#qb-confirm');
    confirm.disabled = !preview || Number(QUICK.amount) > (S.user?.balance ?? 0);
  };
  sheet.querySelector('#qb-confirm').onclick = confirmQuickBet;
  document.addEventListener('keydown', quickBetKeys);
}

async function confirmQuickBet() {
  const preview = quickBetPreview();
  if (!preview || QUICK.busy) return;
  QUICK.busy = true;
  renderQuickBet();
  const market = QUICK.market;
  try {
    const res = await api(`/api/markets/${market.slug}/trade`, {
      method: 'POST',
      body: {
        outcome: QUICK.outcome,
        side: 'buy',
        budget: Number(QUICK.amount),
        expectedCost: Number(QUICK.amount),
        slippage: 0.05,
      },
    });
    S.user = res.user;
    closeQuickBet();
    renderNav();
    toast(`${num(res.fill.shares)} ${res.fill.outcomeLabel} at ${cents(res.fill.avgPrice)} — ${usd(res.fill.shares)} to win.`, 'success');
    for (const badge of res.unlocked ?? []) {
      celebrate();
      toast(`Achievement unlocked — ${badge.title}`, 'success');
    }
    // Reflect it wherever the user happens to be standing.
    if (currentRoute().head === '') viewMarkets();
    else if (current?.market?.slug === market.slug) refreshMarket();
  } catch (err) {
    QUICK.busy = false;
    renderQuickBet();
    toast(err.message, 'error');
  }
}

/* ------------------------------------------------------------------ *
 * Who is on each side
 * ------------------------------------------------------------------ */

function holdersPanel(holders, market) {
  if (!holders?.length) return '';
  return `<div class="section card">
      <h3>Biggest positions</h3>
      <table class="data">
        <tbody>${holders
          .map(
            (h) => `<tr>
              <td><div class="user-cell">${avatar(h.user, true)}<a href="#/user/${esc(h.user.username)}">${esc(h.user.username)}</a></div></td>
              <td><span class="side-chip" style="--chip:${colorFor(market, h.outcome)}">${esc(h.outcomeLabel)}</span></td>
              <td class="num mono">${num(h.shares)} sh</td>
              <td class="num mono">${usd(h.value)}</td>
              <td class="num mono ${cls(h.unrealized)}">${signed(h.unrealized)}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </div>`;
}



/* ================================================================== *
 * Moderation — reporting, and the queue behind it
 * ================================================================== */

/** Ask why, then file it. Kept to one small dialog: friction loses reports. */
function openReport(kind, targetId, label) {
  if (!S.user) {
    toast('Sign in to report this.', '');
    return navigate('#/login');
  }
  const reasons = S.config?.reportReasons ?? {};
  document.getElementById('report-sheet')?.remove();
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="sheet-backdrop" id="report-sheet" role="dialog" aria-modal="true" aria-label="Report">
      <div class="sheet">
        <button class="sheet-close" id="rp-close" aria-label="Close">×</button>
        <h3 style="margin-bottom:4px">Report this ${esc(kind)}</h3>
        <div class="muted" style="font-size:13.5px;margin-bottom:14px">${esc(label)}</div>
        <div class="report-reasons">
          ${Object.entries(reasons)
            .map(
              ([key, text], i) =>
                `<label class="report-reason"><input type="radio" name="rp-reason" value="${esc(key)}" ${i === 0 ? 'checked' : ''}/><span>${esc(text)}</span></label>`,
            )
            .join('')}
        </div>
        <textarea class="control" id="rp-note" rows="2" maxlength="500" placeholder="Anything else we should know? (optional)"></textarea>
        <button class="btn danger" id="rp-send" style="margin-top:12px">Send report</button>
        <div class="qb-foot faint">A moderator reviews every report. Nothing is removed automatically.</div>
      </div>
    </div>`,
  );
  const sheet = document.getElementById('report-sheet');
  const close = () => sheet.remove();
  sheet.onclick = (event) => {
    if (event.target === sheet) close();
  };
  sheet.querySelector('#rp-close').onclick = close;
  sheet.querySelector('#rp-send').onclick = async (event) => {
    event.currentTarget.disabled = true;
    try {
      const reason = sheet.querySelector('input[name="rp-reason"]:checked')?.value;
      const result = await api('/api/reports', {
        method: 'POST',
        body: { kind, targetId, reason, note: sheet.querySelector('#rp-note').value },
      });
      close();
      toast(result.alreadyReported ? 'You have already reported this — thank you.' : 'Reported. A moderator will look at it.', 'success');
    } catch (err) {
      toast(err.message, 'error');
      event.currentTarget.disabled = false;
    }
  };
}

/** A banner for anyone currently suspended, so the blocks are not a mystery. */
function suspensionBanner() {
  const suspension = S.suspension;
  if (!suspension) return '';
  return `<div class="notice warn" style="margin-bottom:18px">
      <b>Your account is suspended until ${esc(new Date(suspension.until).toLocaleDateString('en-US'))}.</b>
      ${suspension.note ? ` ${esc(suspension.note)}` : ''}
      You can still read and withdraw, but not trade, post or open markets.
    </div>`;
}

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

async function viewModeration() {
  if (!S.user?.isAdmin) {
    setApp('<div class="empty">Admins only.</div>');
    return;
  }
  setApp('<div class="loading">Loading the queue…</div>');
  const status = S.modFilter ?? 'open';
  const { reports, counts } = await api(`/api/admin/reports?status=${encodeURIComponent(status)}`);
  const actions = S.config?.moderationActions ?? {};

  setApp(`
    <div class="page-head"><div>
      <h1>Moderation</h1>
      <div class="muted">Anyone can open a market on anything. This is where that gets checked.</div>
    </div></div>

    <div class="filters">
      <div class="chips">
        ${[
          ['open', `Open (${counts.open})`],
          ['actioned', 'Actioned'],
          ['dismissed', 'Dismissed'],
          ['all', 'All'],
        ]
          .map(([key, label]) => `<button class="chip ${status === key ? 'active' : ''}" data-mod-filter="${key}">${esc(label)}</button>`)
          .join('')}
      </div>
    </div>

    ${
      reports.length
        ? reports
            .map(
              (r) => `<div class="card report-card ${r.status}">
          <div class="report-head">
            <span class="tag ${r.status === 'open' ? 'closed' : 'resolved'}">${esc(r.reasonLabel)}</span>
            ${r.reportCount > 1 ? `<span class="tag">${r.reportCount}× reported</span>` : ''}
            <span class="faint">${esc(r.kind)} · by ${esc(r.reporter)} · ${timeAgo(r.createdAt)}</span>
            <span class="spacer"></span>
            ${r.status !== 'open' ? `<span class="faint">${esc(actions[r.action] ?? r.action)}</span>` : ''}
          </div>

          ${
            r.target
              ? `<div class="report-target">
                  <div class="report-text">${esc(r.target.text)}</div>
                  <div class="faint" style="font-size:12.5px;margin-top:6px">
                    by <a href="#/user/${esc(r.target.author)}">${esc(r.target.author)}</a>
                    ${r.target.slug ? ` · <a href="#/market/${esc(r.target.slug)}">open market</a>` : ''}
                    ${r.target.removed ? ' · <b class="neg">already removed</b>' : ''}
                  </div>
                </div>`
              : '<div class="muted">The target has been deleted.</div>'
          }
          ${r.note ? `<div class="muted" style="font-size:13.5px;margin-top:8px">“${esc(r.note)}”</div>` : ''}

          ${
            r.status === 'open'
              ? `<div class="report-actions">
                  <button class="btn sm ghost" data-act="dismiss" data-report="${r.id}">Leave it up</button>
                  ${
                    r.kind === 'market'
                      ? `<button class="btn sm danger" data-act="hide_market" data-report="${r.id}">Hide market</button>`
                      : `<button class="btn sm danger" data-act="delete_comment" data-report="${r.id}">Remove comment</button>`
                  }
                  <button class="btn sm danger" data-act="suspend_user" data-report="${r.id}">Suspend author 7d</button>
                </div>`
              : ''
          }
        </div>`,
            )
            .join('')
        : '<div class="empty">Nothing in the queue. </div>'
    }
  `);

  const el = app();
  el.querySelectorAll('[data-mod-filter]').forEach((b) => {
    b.onclick = () => {
      S.modFilter = b.dataset.modFilter;
      viewModeration();
    };
  });
  el.querySelectorAll('[data-act]').forEach((button) => {
    button.onclick = async () => {
      const action = button.dataset.act;
      if (action !== 'dismiss' && !confirm(`${actions[action] ?? action}. Continue?`)) return;
      button.disabled = true;
      try {
        const result = await api(`/api/admin/reports/${button.dataset.report}`, {
          method: 'POST',
          body: { action, days: 7 },
        });
        toast(
          result.alsoResolved > 1
            ? `Done — ${result.alsoResolved} reports about the same thing closed.`
            : 'Done.',
          'success',
        );
        viewModeration();
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
      }
    };
  });
}


boot();
