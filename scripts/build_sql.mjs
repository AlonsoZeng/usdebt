#!/usr/bin/env node
/**
 * 离线建表 · 第 3 步：把两份原始 JSON 变成可执行 SQL。
 *
 * 归一化**不在本文件实现**，而是直接 import src/normalize.ts —— 与 Worker
 * 运行时、单元测试共用同一份规则（spec §3.3「唯一事实源」）。
 *
 * 输入：data/legacy-raw.json（4014 行）、data/backfill-raw.json（补数）
 * 输出：data/migration.sql（4011 行）、data/backfill.sql（补数行）
 *
 * 执行：npm run data:build
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  normalizeLegacy,
  normalizeApi,
  dedupeKey,
  BATCH_FAIL_RATIO
} from '../src/normalize.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const NOW = '2026-11-07T00:00:00.000Z'; // 固定时间戳，保证脚本可重复生成同样的 SQL

const LEGACY_EXPECTED = 4014;
const LEGACY_UNIQUE = 4011; // 归一化并去掉 3 组日期格式重复后的真实记录数
// D1 的单条 statement 有长度上限（SQLITE_TOOBIG）。补数行带 raw_json 约 3KB/行，
// 100 行一条 INSERT 会超限；10 行约 30KB，实测可安全灌入。
const BATCH_SIZE = 10;

function readJson(name) {
  const p = join(DATA, name);
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch (e) {
    throw new Error(`cannot read ${p} — run the collector scripts first: ${e.message}`);
  }
}

/** SQLite 字符串字面量转义；null/undefined → NULL */
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

const COLUMNS = [
  'cusip', 'auction_date', 'issue_date', 'maturity_date', 'announcement_date',
  'security_type', 'security_term', 'term_months', 'offering_amount_usd',
  'source', 'source_key', 'raw_json', 'imported_at', 'updated_at'
];

/**
 * 历史行不写 raw_json：
 * 原始 77 列完整保存在 usdebt.db（sha256 已固定并记录在 docs/spec），
 * 再往 D1 塞一份约 8MB 的副本没有回溯价值，只会撑大 SQL 文件。
 * 新抓取的上游记录才写 raw_json（187 字段，日后扩字段不必重抓）。
 */
function values(r) {
  return [
    r.cusip, r.auction_date, r.issue_date, r.maturity_date, r.announcement_date,
    r.security_type, r.security_term, r.term_months, r.offering_amount_usd,
    r.source, r.source_key, r.source === 'legacy_sqlite' ? null : r.raw_json,
    r.imported_at, r.updated_at
  ].map(lit).join(', ');
}

function toSql(rows) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const tuples = batch.map((r) => `(${values(r)})`).join(',\n');
    chunks.push(
      `INSERT INTO auctions (${COLUMNS.join(', ')}) VALUES\n${tuples}\n` +
      `ON CONFLICT(cusip, auction_date, security_term) DO UPDATE SET\n` +
      `  issue_date = excluded.issue_date,\n` +
      `  maturity_date = excluded.maturity_date,\n` +
      `  announcement_date = excluded.announcement_date,\n` +
      `  security_type = excluded.security_type,\n` +
      `  term_months = excluded.term_months,\n` +
      `  offering_amount_usd = excluded.offering_amount_usd,\n` +
      `  source = excluded.source,\n` +
      `  source_key = excluded.source_key,\n` +
      `  raw_json = COALESCE(excluded.raw_json, auctions.raw_json),\n` +
      `  updated_at = excluded.updated_at;\n`
    );
  }
  return chunks.join('\n');
}

function assertBatch(label, total, failures) {
  const ratio = total ? failures / total : 0;
  if (ratio > BATCH_FAIL_RATIO) {
    throw new Error(`${label}: ${failures}/${total} records rejected (${(ratio * 100).toFixed(1)}%) — upstream contract may have changed`);
  }
}

/* ------------------------------ 历史迁移 ------------------------------ */

function buildLegacy() {
  const raw = readJson('legacy-raw.json');
  if (raw.length !== LEGACY_EXPECTED) {
    throw new Error(`legacy rows ${raw.length} != ${LEGACY_EXPECTED}`);
  }
  // P-04：整列单位判定，max < 1000 才认定历史列是「十亿美元」
  const maxOffering = Math.max(...raw.map((r) => Number(r.OfferingAmount) || 0));
  if (!(maxOffering < 1000)) {
    throw new Error(`unit heuristic failed: max(OfferingAmount)=${maxOffering}, expected < 1000`);
  }
  const ctx = { now: NOW, maxOffering };

  const groups = new Map();
  let failures = 0, dirty = 0;
  for (const r of raw) {
    const n = normalizeLegacy(r, ctx);
    if (!n.row) { failures++; continue; }
    if (n.dirty.length) dirty++;
    const key = dedupeKey(n.row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n.row);
  }
  assertBatch('legacy', raw.length, failures);

  // 预期恰好 3 组重复，且每组业务字段完全一致（否则中止，不静默取舍）
  const dupGroups = [...groups.entries()].filter(([, v]) => v.length > 1);
  if (dupGroups.length !== 3 || dupGroups.some(([, v]) => v.length !== 2)) {
    throw new Error(`expected exactly 3 duplicate pairs, got ${JSON.stringify(dupGroups.map(([k, v]) => [k, v.length]))}`);
  }
  for (const [key, pair] of dupGroups) {
    const sig = JSON.stringify(pair.map((r) => [r.offering_amount_usd, r.security_type, r.term_months]));
    const [a, b] = pair;
    if (JSON.stringify([a.offering_amount_usd, a.security_type, a.term_months]) !==
        JSON.stringify([b.offering_amount_usd, b.security_type, b.term_months])) {
      throw new Error(`duplicate group has conflicting business values: ${key} ${sig}`);
    }
  }

  const rows = [...groups.values()].map((v) => v[0]);
  if (rows.length !== LEGACY_UNIQUE) {
    throw new Error(`unique rows ${rows.length} != ${LEGACY_UNIQUE}`);
  }
  writeFileSync(join(DATA, 'migration.sql'), toSql(rows), 'utf-8');
  console.log(`[build_sql] legacy: ${raw.length} raw -> ${rows.length} unique (${dupGroups.length} dup pairs), ${failures} rejected, ${dirty} dirty`);
  return rows;
}

/* ------------------------------ 缺口补齐 ------------------------------ */

function buildBackfill() {
  const raw = readJson('backfill-raw.json');
  const map = new Map();
  let failures = 0, dirty = 0;
  for (const r of raw) {
    const n = normalizeApi(r, NOW);
    if (!n.row) { failures++; continue; }
    if (n.dirty.length) dirty++;
    // 跨月边界会有重复；同键保留最后一条即可
    map.set(dedupeKey(n.row), n.row);
  }
  assertBatch('backfill', raw.length, failures);
  const rows = [...map.values()].sort((a, b) => a.auction_date.localeCompare(b.auction_date));
  writeFileSync(join(DATA, 'backfill.sql'), toSql(rows), 'utf-8');
  const dates = rows.map((r) => r.auction_date);
  console.log(`[build_sql] backfill: ${raw.length} raw -> ${rows.length} unique, ${failures} rejected, ${dirty} dirty`);
  console.log(`[build_sql] backfill range: ${dates[0] ?? '-'} ~ ${dates.at(-1) ?? '-'}`);
}

mkdirSync(DATA, { recursive: true });
const legacy = buildLegacy();
const dates = legacy.map((r) => r.auction_date).sort();
console.log(`[build_sql] legacy range: ${dates[0]} ~ ${dates.at(-1)}`);
buildBackfill();
console.log('[build_sql] done -> data/migration.sql, data/backfill.sql');
