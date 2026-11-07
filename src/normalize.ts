/**
 * 归一化规则 —— 唯一事实源：docs/spec/02-to-be.md §3.3
 *
 * 纯函数模块：不依赖 Cloudflare / D1 / fetch，可被 node --test 直接加载。
 * 三个消费方共用本文件，避免规则漂移：
 *   1. src/index.ts         每日 Cron 抓到的上游记录
 *   2. scripts/build_sql.mjs 历史迁移 + 缺口补齐（离线）
 *   3. tests/*.test.mjs      契约测试
 *
 * 关键约定（改之前先读 README「三条最容易踩的约定」）：
 *   - offering_amount_usd 一律 USD 绝对值；历史库 OfferingAmount 是「十亿美元」
 *   - 日期一律 YYYY-MM-DD；历史库混有 ' 00:00:00' 后缀
 *   - 唯一键 (cusip, auction_date, security_term)，CUSIP 本身不唯一
 */

export const DAILY_WINDOW = 20; // 约 1 周余量，响应 ~140KB；见 spec §4.2 / AC-04b
export const MAX_WINDOW = 250; // 上游硬上限；仅管理态 ?window= 可用
export const DAYS_PER_MONTH = 30.41667; // 与旧 pandas 实现保持一致
export const BATCH_FAIL_RATIO = 0.2; // 整批失败率 >20% 判定为上游改版

export type Dict = Record<string, unknown>;

/** 与 schema.sql 的 auctions 表一一对应 */
export interface Auction {
  cusip: string;
  auction_date: string;
  issue_date: string | null;
  maturity_date: string | null;
  announcement_date: string | null;
  security_type: string;
  security_term: string;
  term_months: number;
  offering_amount_usd: number;
  source: 'legacy_sqlite' | 'treasurydirect_api';
  source_key: string | null;
  raw_json: string;
  imported_at: string;
  updated_at: string;
}

export interface Normalized {
  row: Auction | null;
  error: string | null;
  dirty: string[];
}

export interface LegacyContext {
  now: string;
  /** 整列 max(OfferingAmount)，用于单位判定（P-04）。历史库实测 95 */
  maxOffering: number;
}

/* ------------------------------- 基础变换 ------------------------------- */

/** 字段双读（R-4c）：按别名顺序取第一个非空值，兼容上游 2026-10 改名 */
export function pick(obj: Dict, ...names: string[]): unknown {
  for (const name of names) {
    const value = obj[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** 归一化日期：只保留 YYYY-MM-DD，丢弃 ' 00:00:00' / ISO 时间部分 */
export function normDate(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

const KNOWN_TYPES = new Set(['BILL', 'NOTE', 'BOND', 'TIPS', 'FRN', 'CMB']);

export function normType(value: unknown): string {
  const s = (text(value) ?? '').toUpperCase();
  return KNOWN_TYPES.has(s) ? s : 'UNKNOWN';
}

/** 期限：大写、压缩空白、把 '1317 WEEK' 修成 '1317-WEEK'（DF-11） */
export function normTerm(value: unknown): { value: string; dirty: boolean } {
  const raw = text(value) ?? '';
  const cleaned = raw.replace(/\s+/g, ' ').trim().toUpperCase();
  const normalized = cleaned.replace(/\s+(WEEK|MONTH|YEAR|DAY)$/, '-$1');
  // 只有「空白/换行/缺连字符」才算脏；大小写差异（如 '4-Week'）是正常归一化
  return { value: normalized, dirty: cleaned !== normalized };
}

/** P-04：整列 max < 1000 才判定为「十亿美元」，否则视为已是 USD */
export function legacyAmountToUsd(value: unknown, maxOffering: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return maxOffering < 1000 ? n * 1e9 : n;
}

/**
 * P-13 回退链：由日期现算 → 历史派生列 → 解析 security_term → 0 + dirty
 * 与旧 pandas round(days / 30.41667) 语义一致（实测 4011 行差异 0）
 */
export function termMonths(
  issue: string | null,
  maturity: string | null,
  fallback: unknown,
  term: string
): { value: number; dirty: boolean } {
  if (issue && maturity) {
    const a = Date.parse(`${issue}T00:00:00Z`);
    const b = Date.parse(`${maturity}T00:00:00Z`);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
      const days = (b - a) / 86_400_000;
      return { value: Math.round(days / DAYS_PER_MONTH), dirty: false };
    }
  }
  // 注意：Number(null) === 0，不能把「无回退值」误当成合法的 0
  const fb = fallback === null || fallback === undefined || fallback === '' ? NaN : Number(fallback);
  if (Number.isFinite(fb) && fb >= 0) return { value: Math.round(fb), dirty: true };

  const m = /^(\d+)-(WEEK|MONTH|YEAR|DAY)$/.exec(term);
  if (m) {
    const n = Number(m[1]);
    const factor =
      m[2] === 'YEAR' ? 12 : m[2] === 'MONTH' ? 1 : m[2] === 'WEEK' ? 7 / DAYS_PER_MONTH : 1 / DAYS_PER_MONTH;
    return { value: Math.round(n * factor), dirty: true };
  }
  return { value: 0, dirty: true };
}

/** 唯一键，同时供离线去重与 UPSERT 冲突键使用 */
export function dedupeKey(r: Pick<Auction, 'cusip' | 'auction_date' | 'security_term'>): string {
  return `${r.cusip}|${r.auction_date}|${r.security_term}`;
}

/* ------------------------------ 归一化入口 ------------------------------ */

interface Fields {
  cusip: unknown;
  auctionDate: unknown;
  issueDate: unknown;
  maturityDate: unknown;
  announcementDate: unknown;
  securityType: unknown;
  securityTerm: unknown;
  termMonthsFallback: unknown;
  offeringAmountUsd: number | null;
  source: Auction['source'];
  sourceKey: unknown;
  raw: Dict;
}

/** 去掉空值字段，避免 raw_json 里 187 个字段有一半是 ""，把 SQL 撑到 4MB+ */
function compact(obj: Dict): Dict {
  const out: Dict = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** 必填契约校验 + 组装（R-4d） */
function finalize(f: Fields, now: string): Normalized {
  const dirty: string[] = [];
  const cusip = (text(f.cusip) ?? '').toUpperCase();
  const auction_date = normDate(f.auctionDate);
  const security_type = normType(f.securityType);
  const term = normTerm(f.securityTerm);

  if (!cusip) return { row: null, error: 'missing cusip', dirty };
  if (!auction_date) return { row: null, error: 'missing/invalid auction date', dirty };
  if (!f.securityType) return { row: null, error: 'missing securityType', dirty };
  if (f.offeringAmountUsd === null || !Number.isFinite(f.offeringAmountUsd)) {
    return { row: null, error: 'missing/invalid offeringAmount', dirty };
  }

  if (term.dirty) dirty.push(`security_term normalized from ${JSON.stringify(f.securityTerm)}`);
  if (security_type === 'UNKNOWN') dirty.push('unknown security_type');
  if (f.offeringAmountUsd <= 0) dirty.push('non-positive offering amount');

  const issue_date = normDate(f.issueDate);
  const maturity_date = normDate(f.maturityDate);
  const months = termMonths(issue_date, maturity_date, f.termMonthsFallback, term.value);
  if (months.dirty) dirty.push('term_months used fallback');

  const row: Auction = {
    cusip,
    auction_date,
    issue_date,
    maturity_date,
    announcement_date: normDate(f.announcementDate),
    security_type,
    security_term: term.value,
    term_months: months.value,
    offering_amount_usd: f.offeringAmountUsd,
    source: f.source,
    source_key: text(f.sourceKey),
    raw_json: JSON.stringify(compact(f.raw)),
    imported_at: now,
    updated_at: now
  };
  return { row, error: null, dirty };
}

/** 新端点（auctioned / search）的一条记录 → auctions 行 */
export function normalizeApi(raw: Dict, now: string): Normalized {
  const rawAmount = pick(raw, 'offeringAmount', 'totalAccepted', 'grandTotalParAwarded');
  const amount = rawAmount === null ? null : Number(rawAmount);
  return finalize(
    {
      cusip: pick(raw, 'cusip'),
      auctionDate: pick(raw, 'competitiveAuctionCloseDate', 'auctionDate'),
      issueDate: pick(raw, 'issueDate'),
      maturityDate: pick(raw, 'maturityDate'),
      announcementDate: pick(raw, 'announcementDate'),
      securityType: pick(raw, 'securityType'),
      securityTerm: pick(raw, 'securityTerm', 'originalSecurityTerm'),
      termMonthsFallback: null,
      offeringAmountUsd: amount !== null && Number.isFinite(amount) ? amount : null,
      source: 'treasurydirect_api',
      sourceKey: pick(raw, 'treasuryOfferingAnnouncementXmlFileName', 'xmlFilenameAnnouncement'),
      raw
    },
    now
  );
}

/** 旧 SQLite `mytable` 的一行（77 列）→ auctions 行 */
export function normalizeLegacy(row: Dict, ctx: LegacyContext): Normalized {
  return finalize(
    {
      cusip: row.CUSIP,
      auctionDate: row.AuctionDate,
      issueDate: row.IssueDate,
      maturityDate: row.MaturityDate,
      announcementDate: row.AnnouncementDate,
      securityType: row.SecurityType,
      securityTerm: row.SecurityTermWeekYear,
      termMonthsFallback: row['久期(月数整数)'],
      offeringAmountUsd: legacyAmountToUsd(row.OfferingAmount, ctx.maxOffering),
      source: 'legacy_sqlite',
      sourceKey: row.url,
      raw: row
    },
    ctx.now
  );
}
