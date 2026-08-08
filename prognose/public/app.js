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
    links.push(
      link('#/portfolio', 'Portfolio'),
      `<a href="#/create" class="">Create</a>`,
      `<span class="balance-chip mono" title="Cash balance">${usd(S.user.balance)} ${avatar(S.user)}</span>`,
      `<button id="logout-btn">Sign out</button>`,
    );
  } else {
    links.push(`<a href="#/login" class="signin">Sign in</a>`);
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
  const statusTag =
    market.status === 'resolved'
      ? `<span class="tag resolved">Resolved: ${esc(market.outcomes[market.resolvedOutcome].label)}</span>`
      : market.status === 'cancelled'
        ? '<span class="tag cancelled">Cancelled</span>'
        : market.closed
          ? '<span class="tag closed">Closed</span>'
          : `<span class="faint">${until(market.closesAt)}</span>`;

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

  return `<article class="market-card" data-slug="${esc(market.slug)}">
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
  const { markets } = await api(`/api/markets?${params}`);
  const categories = ['All', ...(S.config?.categories ?? [])];

  setApp(`
    <div class="page-head">
      <div>
        <h1>Markets</h1>
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
  renderPortfolio(await api(`/api/users/${encodeURIComponent(username)}`), { own: S.user?.username === username });
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
      <thead><tr><th></th><th>Trader</th><th class="num">Net worth</th><th class="num">Cash</th>
      <th class="num">Positions</th><th class="num">Profit</th><th class="num">Trades</th><th class="num">Markets</th></tr></thead>
      <tbody>${users
        .map(
          (u) => `<tr>
            <td class="rank ${u.rank <= 3 ? 'top' : ''}">#${u.rank}</td>
            <td><div class="user-cell">${avatar(u, true)}<a href="#/user/${esc(u.username)}">${esc(u.username)}</a></div></td>
            <td class="num mono"><b>${usd(u.netWorth)}</b></td>
            <td class="num mono">${usd(u.balance)}</td>
            <td class="num mono">${usd(u.positionValue + u.creatorEquity)}</td>
            <td class="num mono ${cls(u.profit)}">${signed(u.profit)}</td>
            <td class="num mono">${u.trades}</td>
            <td class="num mono">${u.marketsCreated}</td>
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

function viewAuth(mode = 'login') {
  setApp(`
    <div class="card auth-card">
      <h1 style="font-size:20px">${mode === 'login' ? 'Sign in' : 'Create an account'}</h1>
      <div class="muted" style="margin-bottom:16px">${
        mode === 'login'
          ? 'Try the demo account: <b>demo</b> / <b>demo123</b>.'
          : `Every new account starts with ${usd(S.config?.startingBalance ?? 1000, 0)} in play money.`
      }</div>
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
  if (!S.token) return;
  try {
    const { user } = await api('/api/me');
    S.user = user;
  } catch {
    setToken(null);
  }
  renderNav();
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

  S.config = await api('/api/config').catch(() => null);
  await refreshUser();
  window.addEventListener('hashchange', route);
  route();
}

boot();
