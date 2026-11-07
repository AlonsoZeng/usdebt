/**
 * daily-tracker · Worker 入口
 * 规格：docs/spec/02-to-be.md（唯一事实源）
 *
 * 一个 Worker 承担三件事：
 *   1. 分发 public/ 静态页（边缘直出，不消耗 Worker 额度）
 *   2. 4 个只读 API + 1 个写接口（POST /api/run，需 x-manual-key）
 *   3. 每天 UTC 01:05 由 Cron 唤醒，抓「最新 20 条」→ 归一化 → 幂等 upsert → 告警
 *
 * CPU 纪律：免费版只有 10ms/次。这里不做透视、不做均线、不解析大响应；
 * 所有聚合都在浏览器（public/lib.js）完成。
 */

import {
  DAILY_WINDOW,
  MAX_WINDOW,
  BATCH_FAIL_RATIO,
  normalizeApi,
  type Auction,
  type Dict
} from './normalize';
import {
  listAuctionsQuery,
  analyticsRowsQuery,
  monthlyQuery,
  healthQuery,
  upsertSql,
  upsertBinds,
  whitelistDateField,
  whitelistType
} from './db';
import { notify } from './notify';

export interface Env {
  DB: D1Database;
  MANUAL_KEY?: string;
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL?: string;
  NOTIFY_WEBHOOK?: string;
}

interface RunResult {
  ok: boolean;
  written: number;
  skipped: number;
  failed: number;
  changed: number;
  error?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      switch (url.pathname) {
        case '/api/health':
          return health(env);
        case '/api/auctions':
          return listAuctions(url.searchParams, env);
        case '/api/analytics/rows':
          return analyticsRows(url.searchParams, env);
        case '/api/analytics/monthly':
          return monthly(url.searchParams, env);
      }
    }
    if (url.pathname === '/api/run') return manualRun(request, url.searchParams, env);
    return json({ ok: false, error: 'Not Found' }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // waitUntil 保证 Worker 返回后任务继续跑完
    ctx.waitUntil(runOnce(env, { window: DAILY_WINDOW, kind: 'daily' }));
  }
} satisfies ExportedHandler<Env>;

/* ------------------------------- 只读接口 ------------------------------- */

async function health(env: Env): Promise<Response> {
  const t0 = Date.now();
  try {
    const row = await env.DB.prepare(healthQuery().sql).first<{
      auctions: number;
      data_through: string | null;
      last_started: string | null;
      last_status: string | null;
      last_success_at: string | null;
    }>();
    const lastSuccess = row?.last_success_at ?? null;
    const stale = !lastSuccess || Date.now() - Date.parse(lastSuccess) > 36 * 3600_000;
    return json({
      ok: true,
      db: 'connected',
      auctions: row?.auctions ?? 0,
      dataThrough: row?.data_through ?? null,
      lastRun: row?.last_started ?? null,
      lastStatus: row?.last_status ?? null,
      lastSuccessAt: lastSuccess,
      stale,
      notify: env.RESEND_API_KEY || env.NOTIFY_WEBHOOK ? 'configured' : 'skipped',
      latencyMs: Date.now() - t0,
      now: new Date().toISOString()
    });
  } catch (error) {
    return json({ ok: false, db: 'error', error: messageOf(error) }, 500);
  }
}

async function listAuctions(p: URLSearchParams, env: Env): Promise<Response> {
  if (p.get('type') && !whitelistType(p.get('type'))) {
    return json({ ok: false, error: 'invalid type' }, 400);
  }
  try {
    const q = listAuctionsQuery(p);
    const { results } = await env.DB.prepare(q.sql).bind(...q.binds).all();
    const rows = results ?? [];
    const nextCursor = rows.length ? rows[rows.length - 1].id : null;
    return json({ ok: true, rows, nextCursor });
  } catch (error) {
    return json({ ok: false, error: messageOf(error) }, 500);
  }
}

async function analyticsRows(p: URLSearchParams, env: Env): Promise<Response> {
  try {
    // 默认区间以 dataThrough 为锚，不用「今天」，避免数据缺口造成空白断崖（P-02）
    const max = await env.DB.prepare('SELECT MAX(auction_date) AS d FROM auctions').first<{ d: string | null }>();
    const q = analyticsRowsQuery(p, max?.d ?? null);
    const { results } = await env.DB.prepare(q.sql).bind(...q.binds).all<{
      auction_date: string; term_months: number; offering_amount_usd: number; security_type: string;
    }>();
    // 短键名压体积：d/m/a/t，前端 public/lib.js 负责还原
    const rows = (results ?? []).map((r) => ({
      d: r.auction_date,
      m: r.term_months,
      a: r.offering_amount_usd,
      t: r.security_type
    }));
    return json({ ok: true, rows, dataThrough: max?.d ?? null });
  } catch (error) {
    return json({ ok: false, error: messageOf(error) }, 500);
  }
}

async function monthly(p: URLSearchParams, env: Env): Promise<Response> {
  const field = whitelistDateField(p.get('field') ?? 'auction_date');
  if (!field) return json({ ok: false, error: 'invalid field' }, 400); // 注入尝试在此被拒
  const year = Number(p.get('year'));
  const month = Number(p.get('month'));
  if (!Number.isInteger(year) || year < 1900 || year > 2200 || !Number.isInteger(month) || month < 1 || month > 12) {
    return json({ ok: false, error: 'invalid year/month' }, 400);
  }
  try {
    const cur = monthlyQuery(field, year, month);
    const prev = monthlyQuery(field, year - 1, month);
    const [a, b] = await Promise.all([
      env.DB.prepare(cur.sql).bind(...cur.binds).all<{ d: string; a: number }>(),
      env.DB.prepare(prev.sql).bind(...prev.binds).all<{ d: string; a: number }>()
    ]);
    const byDate = (rows: { d: string; a: number }[] | undefined) => {
      const m = new Map<string, number>();
      for (const r of rows ?? []) m.set(r.d, r.a);
      return m;
    };
    const cm = byDate(a.results);
    const pm = byDate(b.results);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const days: string[] = [], current: number[] = [], previous: number[] = [];
    for (let i = 1; i <= daysInMonth; i++) {
      const dd = String(i).padStart(2, '0');
      days.push(`${year}-${String(month).padStart(2, '0')}-${dd}`);
      current.push(cm.get(`${year}-${String(month).padStart(2, '0')}-${dd}`) ?? 0);
      previous.push(pm.get(`${year - 1}-${String(month).padStart(2, '0')}-${dd}`) ?? 0);
    }
    return json({ ok: true, field, year, month, days, current, previous, unit: 'USD' });
  } catch (error) {
    return json({ ok: false, error: messageOf(error) }, 500);
  }
}

/* ------------------------------- 写接口 -------------------------------- */

async function manualRun(request: Request, p: URLSearchParams, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405);
  if (!env.MANUAL_KEY) return json({ ok: false, error: 'MANUAL_KEY not configured' }, 503);
  if (request.headers.get('x-manual-key') !== env.MANUAL_KEY) {
    return json({ ok: false, error: 'Forbidden' }, 403);
  }
  const raw = Number(p.get('window'));
  const window = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_WINDOW) : DAILY_WINDOW;
  const result = await runOnce(env, { window, kind: 'manual' });
  return json(result, result.ok ? 200 : 500);
}

/* ------------------------------- 主流程 -------------------------------- */

async function runOnce(env: Env, opts: { window: number; kind: 'daily' | 'manual' }): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const day = startedAt.slice(0, 10);
  let runId: number | null = null;
  try {
    const r = await env.DB.prepare('INSERT INTO runs (started_at, status) VALUES (?, ?) RETURNING id')
      .bind(startedAt, 'running').first<{ id: number }>();
    runId = r?.id ?? null;
  } catch (error) {
    await notify(env, `❌ ${day} cannot write runs table\n${messageOf(error)}`);
    return { ok: false, written: 0, skipped: 0, failed: 0, changed: 0, error: messageOf(error) };
  }

  try {
    const rawRecords = await fetchUpstream(opts.window);
    const now = new Date().toISOString();
    const rows: Auction[] = [];
    const failures: string[] = [];
    const dirtyCount = { n: 0 };

    for (const rec of rawRecords) {
      const n = normalizeApi(rec as Dict, now);
      if (n.row) {
        rows.push(n.row);
        if (n.dirty.length) dirtyCount.n++;
      } else {
        failures.push(n.error ?? 'unknown');
      }
    }

    // R-4d：整批失败率过高 = 上游改版，判失败，不静默写空
    const total = rawRecords.length;
    if (total > 0 && failures.length / total > BATCH_FAIL_RATIO) {
      throw new Error(`upstream contract changed: ${failures.length}/${total} records rejected`);
    }

    const changed = await writeRows(env, rows);
    const detail = JSON.stringify({
      kind: opts.kind, window: opts.window, written: rows.length,
      skipped: 0, failed: failures.length, dirty: dirtyCount.n,
      changed, errors: failures.slice(0, 5)
    });
    await env.DB.prepare('UPDATE runs SET status = ?, finished_at = ?, detail = ? WHERE id = ?')
      .bind('ok', new Date().toISOString(), detail, runId).run();
    await notify(env, `✅ ${day} ${rows.length} rows upserted, ${changed} changed, ${failures.length} rejected`);
    return { ok: true, written: rows.length, skipped: 0, failed: failures.length, changed };
  } catch (error) {
    const detail = messageOf(error);
    try {
      await env.DB.prepare('UPDATE runs SET status = ?, finished_at = ?, detail = ? WHERE id = ?')
        .bind('failed', new Date().toISOString(), JSON.stringify({ kind: opts.kind, error: detail }), runId)
        .run();
    } catch { /* 下面仍要发通知 */ }
    await notify(env, `❌ ${day} run failed\n${detail}`);
    return { ok: false, written: 0, skipped: 0, failed: 0, changed: 0, error: detail };
  }
}

/** 幂等 upsert + 金额变更审计（P-03）。窗口 ≤20 条，CPU 开销可忽略。 */
async function writeRows(env: Env, rows: Auction[]): Promise<number> {
  if (rows.length === 0) return 0;
  const dates = rows.map((r) => r.auction_date).sort();
  const existing = await env.DB.prepare(
    'SELECT cusip, auction_date, security_term, offering_amount_usd FROM auctions ' +
    'WHERE auction_date >= ? AND auction_date <= ?'
  ).bind(dates[0], dates[dates.length - 1]).all<{
    cusip: string; auction_date: string; security_term: string; offering_amount_usd: number;
  }>();
  const before = new Map<string, number>();
  for (const r of existing.results ?? []) {
    before.set(`${r.cusip}|${r.auction_date}|${r.security_term}`, r.offering_amount_usd);
  }
  let changed = 0;
  for (const r of rows) {
    const prev = before.get(`${r.cusip}|${r.auction_date}|${r.security_term}`);
    if (prev !== undefined && prev !== r.offering_amount_usd) changed++;
  }
  const stmt = env.DB.prepare(upsertSql());
  await env.DB.batch(rows.map((r) => stmt.bind(...upsertBinds(r))));
  return changed;
}

/** 只拉「最新窗口」，不带任何日期参数（上游会忽略）；带响应体大小保护 */
async function fetchUpstream(window: number): Promise<Dict[]> {
  const url =
    'https://www.treasurydirect.gov/TA_WS/securities/auctioned' +
    `?format=json&pagesize=${window}`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'daily-tracker/1.0 (+personal research)' }
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  const body = await res.text();
  if (body.length > 400_000) throw new Error(`upstream payload too large: ${body.length} bytes`);
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error('upstream response is not an array');
  return parsed as Dict[];
}

/* -------------------------------- 工具 --------------------------------- */

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.message}\n${error.stack ?? ''}`.trim();
  return String(error);
}
