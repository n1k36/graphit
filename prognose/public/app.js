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
  `<span class="avatar ${small ? 'sm' : ''}" style="background:${esc(user?.avatar || '#4f8cff')}">${esc(
    (user?.username || '?')[0].toUpperCase(),
  )}</span>`;

const OUTCOME_COLORS = ['#14c46a', '#f43f5e', '#2d7fff', '#a855f7', '#f6b83f', '#14b8a6', '#ec4899', '#94a3b8'];
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

function sparkline(market) {
  const values = market.spark && market.spark.length > 1 ? market.spark : [1 / market.outcomes.length];
  if (values.length < 2) return '<div style="height:34px"></div>';
  const w = 260;
  const h = 34;
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
  const color = rising ? '#14c46a' : '#f43f5e';
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
  const links = [link('#/', 'Markets'), link('#/leaderboard', 'Leaderboard')];

  if (S.user) {
    const level = S.user.level ?? { level: 1, name: 'Rookie', progress: 0 };
    links.push(link('#/portfolio', 'Portfolio'), `<a href="#/create">Create</a>`);
    if (S.user.isAdmin) links.push(link('#/admin', 'Admin'));
    if (S.user.bonusReady) {
      links.push(`<button class="bonus-pill" id="bonus-btn" title="Claim your daily bonus">🎁 Claim daily</button>`);
    } else if (S.user.streak > 0) {
      links.push(`<span class="streak-pill" title="Daily streak">🔥 ${S.user.streak}</span>`);
    }
    links.push(
      `<button class="bell" id="bell-btn" aria-label="Notifications">🔔${
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
    links.push(`<a href="#/login" class="ghostish">Sign in</a>`, `<a href="#/signup" class="signin">Get $${
      S.config?.settings?.welcomeBonus ?? 1000
    } free</a>`);
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

function marketCard(market) {
  const lead = leadOutcome(market);
  const prices = displayPrices(market);
  const clock = countdown(market.closesAt);
  const statusTag =
    market.status === 'resolved'
      ? `<span class="tag resolved">Resolved: ${esc(market.outcomes[market.resolvedOutcome].label)}</span>`
      : market.status === 'cancelled'
        ? '<span class="tag cancelled">Cancelled</span>'
        : market.closed
          ? '<span class="tag closed">Closed</span>'
          : `<span class="${clock.urgent ? 'urgent' : 'faint'}">${clock.urgent ? '⏱ ' : ''}${clock.text}</span>`;

  const rows = market.isBinary
    ? ''
    : `<div class="outcome-rows">${market.outcomes
        .map((o) => ({ ...o, price: prices[o.index] }))
        .sort((a, b) => b.price - a.price)
        .slice(0, 3)
        .map(
          (o) => `<div class="outcome-row">
            <span class="label">${esc(o.label)}</span>
            <span class="bar"><span style="width:${(o.price * 100).toFixed(1)}%;background:${colorFor(market, o.index)}"></span></span>
            <span class="pct">${pct(o.price, 1)}</span>
          </div>`,
        )
        .join('')}${
        market.outcomes.length > 3 ? `<div class="outcome-row faint">+${market.outcomes.length - 3} more</div>` : ''
      }</div>`;

  return `<article class="market-card ${market.hot ? 'hot' : ''}" data-slug="${esc(market.slug)}">
      ${market.hot ? '<span class="hot-flag">🔥 HOT</span>' : ''}
      <div class="head">
        <div class="market-emoji">${esc(market.emoji || '📈')}</div>
        <div class="question">${esc(market.question)}</div>
        <div class="chance">
          <div class="chance-value" style="color:${market.isBinary ? colorFor(market, 0) : 'inherit'}">${pct(lead.price)}</div>
          <div class="chance-label">${esc(market.isBinary ? 'chance' : lead.outcome.label)}</div>
        </div>
      </div>
      ${market.isBinary ? sparkline(market) : rows}
      <div class="card-foot">
        <span class="tag">${esc(market.category)}</span>
        <span>${usd(market.volume, 0)} vol</span>
        ${market.volume24h > 0 ? `<span class="pos">+${usd(market.volume24h, 0)} 24h</span>` : ''}
        <span class="spacer"></span>
        ${statusTag}
      </div>
    </article>`;
}

async function viewMarkets() {
  setApp('<div class="loading">Loading markets…</div>');
  const params = new URLSearchParams({
    search: S.filters.search,
    category: S.filters.category,
    status: S.filters.status,
    sort: S.filters.sort,
  });
  const [{ markets }, stats] = await Promise.all([
    api(`/api/markets?${params}`),
    S.stats ? Promise.resolve(S.stats) : api('/api/stats').catch(() => null),
  ]);
  S.stats = stats;
  const categories = ['All', ...(S.config?.categories ?? [])];

  setApp(`
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
          ['hot', '🔥 Hot right now'],
          ['volume', 'Top volume'],
          ['activity', 'Most traded'],
          ['newest', 'Newest'],
          ['closing', 'Closing soon'],
        ]
          .map(([v, l]) => `<option value="${v}" ${S.filters.sort === v ? 'selected' : ''}>${l}</option>`)
          .join('')}
      </select>
    </div>
    ${
      markets.length
        ? `<div class="grid">${markets.map(marketCard).join('')}</div>`
        : `<div class="empty">No markets match that. <a href="#/create" style="color:var(--accent)">Create one?</a></div>`
    }
  `);

  app().querySelectorAll('.market-card').forEach((card) => {
    card.onclick = () => navigate(`#/market/${card.dataset.slug}`);
  });
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
  const { market, history, trades, comments, positions } = current;
  const lead = leadOutcome(market);
  const shown = displayPrices(market);
  const canSettle = S.user && (S.user.id === market.creator?.id || S.user.isAdmin) && market.status === 'open';

  setApp(`
    <a href="#/" class="muted" style="font-size:13.5px">← All markets</a>
    <div class="detail" style="margin-top:14px">
      <div>
        <div class="detail-head">
          <div class="market-emoji">${esc(market.emoji || '📈')}</div>
          <div style="flex:1;min-width:0">
            <h1>${esc(market.question)}</h1>
            <div class="meta-row">
              <span class="tag">${esc(market.category)}</span>
              <span>${usd(market.volume, 0)} volume</span>
              <span>${market.traders ?? 0} traders</span>
              <span>${market.status === 'open' ? `closes ${dateLabel(market.closesAt)}` : `settled ${dateLabel(market.resolvedAt)}`}</span>
              <span>by ${esc(market.creator?.username ?? 'unknown')}</span>
            </div>
          </div>
        </div>

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

        ${
          market.description
            ? `<div class="section card"><h3>Resolution criteria</h3><div class="prose">${esc(market.description)}</div></div>`
            : ''
        }

        ${canSettle ? settlePanel(market) : ''}

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
            .map(
              (c) => `<div class="comment">${avatar(c.user)}
                <div class="body">
                  <div class="who">${esc(c.user.username)} <span class="faint" style="font-weight:400">· ${timeAgo(c.createdAt)}</span></div>
                  <div class="text">${esc(c.body)}</div>
                </div></div>`,
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
      toast(`${badge.icon} Achievement unlocked: ${badge.title}`, 'success');
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
            <td><a href="#/market/${esc(p.slug)}">${esc(p.emoji || '📈')} ${esc(p.question.slice(0, 60))}${
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
              u.streak > 2 ? `<span class="streak-mini">🔥${u.streak}</span>` : ''
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
  const cfg = S.config;
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
          <label for="m-emoji">Icon</label>
          <input class="control" id="m-emoji" maxlength="8" placeholder="📈" />
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
          <input class="control" id="m-subsidy" type="number" min="${cfg?.minSubsidy}" max="${cfg?.maxSubsidy}" step="5" value="${cfg?.defaultSubsidy}" />
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
          emoji: el.querySelector('#m-emoji').value,
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
    setApp(`<div class="empty">${esc(err.message)}</div>`);
  }
}

async function refreshUser() {
  if (!S.token) {
    renderNav();
    return;
  }
  try {
    const { user } = await api('/api/me');
    S.user = user;
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
    toast('Installed. Prophit now lives on your home screen.', 'success');
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
  setInterval(refreshTicker, 12_000);
  setInterval(() => {
    if (S.user) refreshNotifications();
  }, 20_000);
  // Keep the headline stats fresh without a reload.
  setInterval(async () => {
    if (currentRoute().head !== '') return;
    S.stats = await api('/api/stats').catch(() => S.stats);
  }, 30_000);
}


/* ================================================================== *
 * Live ticker, hero and celebration effects
 * ================================================================== */

/** Colourful confetti burst. Fires when something good happens to you. */
function celebrate(count = 70) {
  const colors = ['#14c46a', '#2d7fff', '#f6b83f', '#ec4899', '#a855f7', '#ffffff'];
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
  return `<a class="tick" href="#/market/${esc(item.market.slug)}">
      <span class="tick-emoji">${esc(item.market.emoji || '📈')}</span>
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
    // Rendered twice so the marquee can loop seamlessly.
    const markup = activity.map(tickerItem).join('');
    rail.innerHTML = markup + markup;
    rail.style.animationDuration = `${Math.max(30, activity.length * 3.2)}s`;
  } catch {
    /* the ticker is decoration — never let it break the page */
  }
}

function heroSection(stats) {
  if (!stats) return '';
  return `<section class="hero">
      <div class="hero-glow"></div>
      <div class="hero-content">
        <div class="live-badge"><span class="dot"></span>LIVE</div>
        <h1 class="hero-title">${esc(S.config?.brand?.tagline ?? 'Bet on anything.')}</h1>
        <p class="hero-sub">Every price is a probability, set by people with money on the line. Trade it, or make your own market and earn the fees.</p>
        <div class="hero-stats">
          <div><b>${usd(stats.volume24h, 0)}</b><span>24h volume</span></div>
          <div><b>${stats.trades24h.toLocaleString('en-US')}</b><span>24h trades</span></div>
          <div><b>${stats.openMarkets}</b><span>open markets</span></div>
          <div><b>${stats.traders.toLocaleString('en-US')}</b><span>traders</span></div>
        </div>
        ${
          S.user
            ? `<a class="btn sm hero-cta" href="#/create">Create a market →</a>`
            : `<a class="btn sm hero-cta" href="#/signup">Claim ${usd(S.config?.settings?.welcomeBonus ?? 1000, 0)} free →</a>`
        }
      </div>
    </section>`;
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
      <div class="checkout-brand">${esc(S.config?.brand?.name ?? 'Prophit')} · secure checkout</div>
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
      <div class="checkout-brand">${esc(S.config?.brand?.name ?? 'Prophit')} · bank transfer</div>
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
              <span class="badge-icon">${a.icon}</span>
              <span class="badge-title">${esc(a.title)}</span>
              <span class="badge-hint">${esc(a.earned ? 'unlocked' : a.hint)}</span>
            </div>`,
          )
          .join('')}
      </div>
    </div>`;
}


boot();
