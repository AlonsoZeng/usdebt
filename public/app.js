/**
 * UI controller. All user-visible strings come from i18n/*.json; no Chinese
 * literals live in HTML/JS/CSS (spec AC-06). All aggregation happens here in
 * the browser because the Worker free tier only allows 10ms CPU per request.
 */

import { buildStack, weeklyCompare, BILLION } from './lib.js';

const $ = (sel) => document.querySelector(sel);
const lang = new URLSearchParams(location.search).get('lang') || 'zh-CN';
let dict = {};
const charts = {};
const rowCache = new Map(); // years -> rows[]
let dataThrough = null;
let xMode = 'week';
let years = 5;
let tableCursor = null;

const t = (key) => dict[key] ?? key;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function showError(id, err) {
  const el = $(id);
  if (el) el.textContent = err ? `${t('error.generic')}: ${err.message || err}` : '';
}

async function loadI18n() {
  let target = lang;
  try {
    const res = await fetch(`./i18n/${target}.json`);
    if (!res.ok) throw new Error(String(res.status));
    dict = await res.json();
  } catch {
    if (target !== 'zh-CN') {
      console.warn('[i18n] locale not available, falling back to zh-CN');
      target = 'zh-CN';
      const res = await fetch('./i18n/zh-CN.json');
      dict = await res.json();
    }
  }
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.title = t('app.title');
}

/* ------------------------------- overview ------------------------------- */

async function loadHealth() {
  try {
    const h = await api('/api/health');
    dataThrough = h.dataThrough;
    $('#data-as-of').textContent = `${t('app.dataAsOf')} ${h.dataThrough ?? '-'}`;
    $('#health-note').textContent = h.stale ? t('health.stale') : t('health.fresh');
    const stats = [
      [t('health.db'), h.db === 'connected' ? t('health.connected') : t('health.error'), h.db === 'connected' ? 'ok' : 'bad'],
      [t('health.records'), h.auctions.toLocaleString(), ''],
      [t('health.dataThrough'), h.dataThrough ?? '-', ''],
      [t('health.lastRun'), h.lastRun ?? t('health.never'), ''],
      [t('health.lastStatus'), h.lastStatus ?? '-', h.lastStatus === 'ok' ? 'ok' : 'warn'],
      [t('health.notify'), h.notify === 'configured' ? t('health.configured') : t('health.skipped'),
        h.notify === 'configured' ? 'ok' : 'warn']
    ];
    $('#health-grid').innerHTML = stats.map(([k, v, cls]) =>
      `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div></div>`
    ).join('');
  } catch (err) {
    showError('#health-note', err);
  }
}

/* -------------------------------- stack --------------------------------- */

async function loadRows(y) {
  if (rowCache.has(y)) return rowCache.get(y);
  const from = y === 'all' ? '2014-01-01' : shiftYears(dataThrough, Number(y));
  const q = new URLSearchParams({ from, limit: y === 'all' ? '5000' : '2000' });
  const res = await api(`/api/analytics/rows?${q}`);
  dataThrough = res.dataThrough ?? dataThrough;
  rowCache.set(y, res.rows);
  return res.rows;
}

function shiftYears(anchor, n) {
  const base = anchor ? new Date(`${anchor}T00:00:00Z`) : new Date();
  base.setUTCFullYear(base.getUTCFullYear() - n);
  return base.toISOString().slice(0, 10);
}

const MA_COLORS = { 5: '#f85149', 10: '#58a6ff', 20: '#3fb950', 60: '#bc8cff', 120: '#d29922' };

function termColor(i, n) {
  const hue = Math.round((200 + (i / Math.max(n, 1)) * 170) % 360);
  return `hsla(${hue}, 62%, 55%, 0.78)`;
}

async function renderStack() {
  try {
    showError('#stack-error', null);
    const rows = await loadRows(years);
    if (!rows.length) { showError('#stack-error', new Error(t('stack.empty'))); return; }
    const stack = buildStack(rows, xMode);
    const barSets = stack.datasets.map((d, i) => ({
      type: 'bar', label: d.label, data: d.data,
      backgroundColor: termColor(i, stack.datasets.length),
      stack: 'amount', borderWidth: 0, maxBarThickness: 26
    }));
    const lineSets = [5, 10, 20, 60, 120].map((w) => ({
      type: 'line', label: `MA${w}`, data: stack.mas[w],
      borderColor: MA_COLORS[w], borderWidth: 2, pointRadius: 0,
      tension: 0.25, fill: false
    }));
    charts.stack?.destroy();
    charts.stack = new window.Chart($('#chart-stack'), {
      data: { labels: stack.labels, datasets: [...barSets, ...lineSets] },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, ticks: { maxTicksLimit: 24, font: { size: 10 } }, grid: { display: false } },
          y: { stacked: true, title: { display: true, text: t('axis.amount') }, beginAtZero: true }
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 11, font: { size: 10 }, filter: (item) => !item.text.startsWith('MA') || ['MA5', 'MA20'].includes(item.text) } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(2)} bn` } }
        }
      }
    });
  } catch (err) { showError('#stack-error', err); }
}

/* ------------------------------- compare -------------------------------- */

async function renderCompare() {
  try {
    showError('#compare-error', null);
    const rows = await loadRows(1);
    const cmp = weeklyCompare(rows);
    if (cmp.keys.length < 2) { showError('#compare-error', new Error(t('compare.empty'))); return; }
    charts.compare?.destroy();
    charts.compare = new window.Chart($('#chart-compare'), {
      type: 'bar',
      data: {
        labels: cmp.labels,
        datasets: cmp.series.map((s, i) => ({
          label: s.key, data: s.data,
          backgroundColor: i === 0 ? 'rgba(88,166,255,.75)' : 'rgba(63,185,80,.75)'
        }))
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, title: { display: true, text: t('axis.amount') } } },
        plugins: { legend: { position: 'bottom' } }
      }
    });
  } catch (err) { showError('#compare-error', err); }
}

/* ------------------------------- monthly -------------------------------- */

function initMonthlyControls() {
  const nowYear = dataThrough ? Number(dataThrough.slice(0, 4)) : new Date().getUTCFullYear();
  const nowMonth = dataThrough ? Number(dataThrough.slice(5, 7)) : new Date().getUTCMonth() + 1;
  $('#monthly-year').innerHTML = Array.from({ length: 12 }, (_, i) => nowYear - i)
    .map((y) => `<option value="${y}"${y === nowYear ? ' selected' : ''}>${y}</option>`).join('');
  $('#monthly-month').innerHTML = Array.from({ length: 12 }, (_, i) => i + 1)
    .map((m) => `<option value="${m}"${m === nowMonth ? ' selected' : ''}>${String(m).padStart(2, '0')}</option>`).join('');
}

async function renderMonthly() {
  try {
    showError('#monthly-error', null);
    const q = new URLSearchParams({ year: $('#monthly-year').value, month: $('#monthly-month').value });
    const m = await api(`/api/analytics/monthly?${q}`);
    charts.monthly?.destroy();
    charts.monthly = new window.Chart($('#chart-monthly'), {
      type: 'bar',
      data: {
        labels: m.days.map((d) => d.slice(8)),
        datasets: [
          { label: `${m.year} · ${t('monthly.current')}`, data: m.current.map((v) => v / BILLION), backgroundColor: 'rgba(88,166,255,.75)' },
          { label: `${m.year - 1} · ${t('monthly.previous')}`, data: m.previous.map((v) => v / BILLION), backgroundColor: 'rgba(139,148,158,.55)' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, title: { display: true, text: t('axis.amount') } } },
        plugins: { legend: { position: 'bottom' } }
      }
    });
  } catch (err) { showError('#monthly-error', err); }
}

/* -------------------------------- table --------------------------------- */

async function loadTable(reset = false) {
  try {
    showError('#table-error', null);
    if (reset) { tableCursor = null; $('#table-body').innerHTML = ''; }
    const q = new URLSearchParams({ limit: '100' });
    if (tableCursor) q.set('cursor', String(tableCursor));
    const res = await api(`/api/auctions?${q}`);
    const html = res.rows.map((r) => `<tr>
      <td>${esc(r.auction_date)}</td><td>${esc(r.cusip)}</td>
      <td>${esc(r.security_type)}</td><td>${esc(r.security_term)}</td>
      <td class="num">${esc(r.term_months)}</td>
      <td class="num">${(r.offering_amount_usd / BILLION).toFixed(2)}</td>
      <td>${esc(r.source)}</td></tr>`).join('');
    $('#table-body').insertAdjacentHTML('beforeend', html);
    tableCursor = res.nextCursor;
    $('#table-more').textContent = res.rows.length < 100 ? t('table.noMore') : t('table.loadMore');
    $('#table-more').disabled = res.rows.length < 100;
  } catch (err) { showError('#table-error', err); }
}

/* --------------------------------- tabs --------------------------------- */

const TAB_RENDER = {
  overview: loadHealth,
  stack: renderStack,
  compare: renderCompare,
  monthly: renderMonthly,
  table: () => loadTable(true)
};

function bindEvents() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('main section').forEach((s) => {
      s.hidden = s.id !== `tab-${btn.dataset.tab}`;
    });
    TAB_RENDER[btn.dataset.tab]?.();
  });

  $('#health-refresh').addEventListener('click', loadHealth);

  document.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => {
    xMode = b.dataset.x;
    document.querySelectorAll('[data-x]').forEach((o) => o.classList.toggle('active', o === b));
    renderStack();
  }));

  document.querySelectorAll('[data-years]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.years;
    years = v === 'all' ? 'all' : Number(v);
    document.querySelectorAll('[data-years]').forEach((o) => o.classList.toggle('active', o === b));
    renderStack();
  }));

  $('#monthly-go').addEventListener('click', renderMonthly);
  $('#table-more').addEventListener('click', () => loadTable(false));
}

(async function init() {
  await loadI18n();
  bindEvents();
  await loadHealth();
  initMonthlyControls();
})();
