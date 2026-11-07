/**
 * 前端计算层 —— 纯函数，无 DOM 依赖。
 * 规格：docs/spec/02-to-be.md §5（透视、堆叠、MA、ISO 周全在浏览器算）
 *
 * 这个文件可被浏览器 <script type="module"> 直接加载，
 * 也能被 node --test 加载，所以图表逻辑同样可离线验收。
 */

export const BILLION = 1e9;

/** ISO 周：返回 ISO year（不是 calendar year），修掉旧项目 12 行跨年周错配 */
export function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay() || 7; // Mon=1 ... Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // 该周的周四，决定 ISO year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/** 可排序的 X 轴键；YYYY-Www / YYYY-MM 字典序即时间序 */
export function isoWeekKey(dateStr) {
  const { year, week } = isoWeek(dateStr);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

/** 与 pandas rolling(window, min_periods=1).mean() 语义一致 */
export function movingAverage(values, window) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    out.push(sum / Math.min(i + 1, window));
  }
  return out;
}

/**
 * Core: turn lightweight /api/analytics/rows into stacked series.
 * rows: [{ d: 'YYYY-MM-DD', m: term_months, a: USD, t: type }]
 * Output unit is USD bn.
 */
export function buildStack(rows, xMode = 'week') {
  const keyFn = xMode === 'month' ? monthKey : isoWeekKey;
  const byX = new Map();
  const terms = new Set();

  for (const r of rows) {
    const k = keyFn(r.d);
    if (!byX.has(k)) byX.set(k, { total: 0, byTerm: new Map() });
    const g = byX.get(k);
    g.total += r.a;
    g.byTerm.set(r.m, (g.byTerm.get(r.m) ?? 0) + r.a);
    terms.add(r.m);
  }

  const labels = [...byX.keys()].sort();
  const sortedTerms = [...terms].sort((a, b) => a - b);
  const datasets = sortedTerms.map((m) => ({
    term: m,
    label: termLabel(m),
    data: labels.map((k) => (byX.get(k).byTerm.get(m) ?? 0) / BILLION)
  }));

  const totals = labels.map((k) => byX.get(k).total);
  const mas = {};
  for (const w of [5, 10, 20, 60, 120]) {
    mas[w] = movingAverage(totals, w).map((v) => v / BILLION);
  }
  return { labels, datasets, totals: totals.map((v) => v / BILLION), mas };
}

/** 期限桶的可读标签（用于图例，文案本身走 i18n，这里只给数值） */
export function termLabel(months) {
  if (months >= 12) return `${Math.round((months / 12) * 10) / 10}y`;
  return `${months}m`;
}

/** 默认「上一完整周 vs 再上一周」，按久期桶堆叠对比 */
export function weeklyCompare(rows, todayStr = new Date().toISOString().slice(0, 10)) {
  const currentKey = isoWeekKey(todayStr);
  const byWeek = new Map();
  for (const r of rows) {
    const k = isoWeekKey(r.d);
    if (k >= currentKey) continue; // 排除未完整的一周
    if (!byWeek.has(k)) byWeek.set(k, new Map());
    const m = byWeek.get(k);
    m.set(r.m, (m.get(r.m) ?? 0) + r.a);
  }
  const keys = [...byWeek.keys()].sort().slice(-2);
  const terms = [...new Set(rows.map((r) => r.m))].sort((a, b) => a - b);
  return {
    keys,
    labels: terms.map(termLabel),
    series: keys.map((k) => ({
      key: k,
      data: terms.map((m) => (byWeek.get(k).get(m) ?? 0) / BILLION)
    }))
  };
}

/** 日度序列补齐空缺日（原 pandas resample('D').sum() 的等价物） */
export function fillDaily(days, values) {
  return values.map((v, i) => ({ day: days[i], value: (v ?? 0) / BILLION }));
}
