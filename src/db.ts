/**
 * D1 查询构造 —— 规格 docs/spec/02-to-be.md §2 / TB-08「安全」
 *
 * 两条不可违反的规则：
 *   1. 所有查询显式列出列，禁止「SELECT 加星号」（raw_json 会把 200KB 变十几 MB，爆 10ms CPU）
 *   2. 外部输入只能作为「值」或「经白名单映射后的列名」，绝不直接拼进 SQL
 *
 * 本模块只产出 { sql, binds }，不执行；执行在 src/index.ts，便于独立测试。
 */

export interface Query {
  sql: string;
  binds: unknown[];
}

/** 明细接口的显式列（不含 raw_json） */
export const AUCTION_COLUMNS =
  'id, cusip, auction_date, issue_date, maturity_date, announcement_date, ' +
  'security_type, security_term, term_months, offering_amount_usd, source, source_key';

/** 分析接口的轻量列 —— 前端算透视/堆叠/MA 只需要这 4 个 */
export const ANALYTIC_COLUMNS = 'auction_date, term_months, offering_amount_usd, security_type';

/** 允许作为日期过滤字段的列（TB-02.4 的 field 参数） */
const DATE_FIELDS: Record<string, string> = {
  auction_date: 'auction_date',
  issue_date: 'issue_date',
  announcement_date: 'announcement_date',
  maturity_date: 'maturity_date'
};

/** 允许作为 security_type 过滤值的枚举 */
const TYPES = new Set(['BILL', 'NOTE', 'BOND', 'TIPS', 'FRN', 'CMB', 'UNKNOWN']);

export function whitelistDateField(input: string | null): string | null {
  if (!input) return null;
  return DATE_FIELDS[input] ?? null;
}

export function whitelistType(input: string | null): string | null {
  if (!input) return null;
  const v = input.toUpperCase();
  return TYPES.has(v) ? v : null;
}

function validDate(input: string | null): string | null {
  return input && /^\d{4}-\d{2}-\d{2}$/.test(input) ? input : null;
}

function clampLimit(input: string | null, fallback: number, max: number): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** TB-02.2 明细分页：cursor 用稳定 id，禁用 offset/行号 */
export function listAuctionsQuery(p: URLSearchParams): Query {
  const binds: unknown[] = [];
  const where: string[] = [];
  const from = validDate(p.get('from'));
  const to = validDate(p.get('to'));
  if (from) { where.push('auction_date >= ?'); binds.push(from); }
  if (to) { where.push('auction_date <= ?'); binds.push(to); }

  const type = whitelistType(p.get('type'));
  if (p.get('type') && !type) return { sql: '', binds: [] }; // 交由 handler 返回 400
  if (type) { where.push('security_type = ?'); binds.push(type); }

  const cursor = Number(p.get('cursor'));
  if (Number.isFinite(cursor) && cursor > 0) {
    where.push('id > ?');
    binds.push(Math.floor(cursor));
  }

  const limit = clampLimit(p.get('limit'), 100, 500);
  const sql =
    `SELECT ${AUCTION_COLUMNS} FROM auctions` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY id ASC LIMIT ?';
  binds.push(limit);
  return { sql, binds };
}

/** TB-02.3 核心分析数据源：只取 4 列，默认上限 2000（P-12） */
export function analyticsRowsQuery(p: URLSearchParams, dataThrough: string | null): Query {
  const binds: unknown[] = [];
  const where: string[] = [];
  let from = validDate(p.get('from'));
  const to = validDate(p.get('to')) ?? dataThrough;

  if (!from && to) {
    // 默认区间 = [dataThrough - 5 年, dataThrough]，不硬编码「今天」（P-02）
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 5);
    from = d.toISOString().slice(0, 10);
  }
  if (from) { where.push('auction_date >= ?'); binds.push(from); }
  if (to) { where.push('auction_date <= ?'); binds.push(to); }

  const limit = clampLimit(p.get('limit'), 2000, 5000);
  const sql =
    `SELECT ${ANALYTIC_COLUMNS} FROM auctions` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY auction_date ASC LIMIT ?';
  binds.push(limit);
  return { sql, binds };
}

/**
 * TB-02.4 月内日度汇总 + 去年同月。
 * field 已由 handler 白名单映射，这里再校验一次，纵深防御。
 */
export function monthlyQuery(field: string, year: number, month: number): Query {
  const col = DATE_FIELDS[field];
  if (!col) return { sql: '', binds: [] };
  const pad = String(month).padStart(2, '0');
  const start = `${year}-${pad}-01`;
  const endYear = month === 12 ? year + 1 : year;
  const endMonth = month === 12 ? '01' : String(month + 1).padStart(2, '0');
  const end = `${endYear}-${endMonth}-01`;
  const sql =
    `SELECT ${col} AS d, SUM(offering_amount_usd) AS a FROM auctions ` +
    `WHERE ${col} >= ? AND ${col} < ? GROUP BY ${col} ORDER BY ${col} ASC`;
  return { sql, binds: [start, end] };
}

/** /api/health：一次拿全，避免多次往返 */
export function healthQuery(): Query {
  return {
    sql:
      'SELECT ' +
      "(SELECT COUNT(*) FROM auctions) AS auctions, " +
      "(SELECT MAX(auction_date) FROM auctions) AS data_through, " +
      "(SELECT started_at FROM runs ORDER BY id DESC LIMIT 1) AS last_started, " +
      "(SELECT status FROM runs ORDER BY id DESC LIMIT 1) AS last_status, " +
      "(SELECT finished_at FROM runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1) AS last_success_at",
    binds: []
  };
}

/** UPSERT：冲突键与 schema.sql 的 UNIQUE 一致（P-03） */
export function upsertSql(): string {
  return (
    'INSERT INTO auctions (' +
    'cusip, auction_date, issue_date, maturity_date, announcement_date, ' +
    'security_type, security_term, term_months, offering_amount_usd, ' +
    'source, source_key, raw_json, imported_at, updated_at' +
    ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(cusip, auction_date, security_term) DO UPDATE SET ' +
    'issue_date = excluded.issue_date, ' +
    'maturity_date = excluded.maturity_date, ' +
    'announcement_date = excluded.announcement_date, ' +
    'security_type = excluded.security_type, ' +
    'term_months = excluded.term_months, ' +
    'offering_amount_usd = excluded.offering_amount_usd, ' +
    'source = excluded.source, ' +
    'source_key = excluded.source_key, ' +
    'raw_json = excluded.raw_json, ' +
    'updated_at = excluded.updated_at'
  );
}

export function upsertBinds(r: {
  cusip: string; auction_date: string; issue_date: string | null; maturity_date: string | null;
  announcement_date: string | null; security_type: string; security_term: string;
  term_months: number; offering_amount_usd: number; source: string; source_key: string | null;
  raw_json: string; imported_at: string; updated_at: string;
}): unknown[] {
  return [
    r.cusip, r.auction_date, r.issue_date, r.maturity_date, r.announcement_date,
    r.security_type, r.security_term, r.term_months, r.offering_amount_usd,
    r.source, r.source_key, r.raw_json, r.imported_at, r.updated_at
  ];
}
