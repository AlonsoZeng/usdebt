#!/usr/bin/env node
/**
 * 远端数据验收（DATA 层）—— 规格 AC-03 / AC-09。
 *
 * 为什么不用 `wrangler d1 execute --file`：该模式只回「执行了 9 条语句」的摘要，
 * 拿不到 SELECT 的数值，等于没法断言。这里改用 `--command --json` 读回真实结果。
 * SQL 源文件是 scripts/verify.sql（单一事实源，不在本文件重复写一遍）。
 *
 * 执行：npm run db:verify
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sql = readFileSync(join(ROOT, 'scripts', 'verify.sql'), 'utf-8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--') && line.trim())
  .join('\n')
  .trim();

// 直接用 node 执行 wrangler 的 CLI 入口：Windows 上 spawn npx.cmd 会 EINVAL，
// 走 shell 又会被 SQL 里的引号/空格搅乱。用 JS 入口最稳且跨平台。
const wranglerCli = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
let row;
try {
  const out = execFileSync(
    process.execPath,
    [wranglerCli, 'd1', 'execute', 'daily_tracker', '--remote', '--command', sql, '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: ROOT }
  );
  const parsed = JSON.parse(out);
  row = Array.isArray(parsed) ? parsed[0].results[0] : parsed.results[0];
} catch (e) {
  console.error('[verify] cannot query remote D1:', e.message);
  process.exit(1);
}

const today = new Date();
const checks = [
  ['legacy_count', row.legacy_count, 4011],
  ['legacy_min', row.legacy_min, '2014-01-06'],
  ['messy_dates', row.messy_dates, 0],
  ['duplicate_keys', row.dup_keys, 0],
  ['bad_term_months', row.bad_months, 0],
  ['null_amounts', row.bad_amounts, 0],
  ['sample_amount_usd', row.sample_amount, 22_000_000_000]
];

let failed = 0;
for (const [name, actual, expected] of checks) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(20)} actual=${String(actual).padEnd(14)} expected=${expected}`);
}

const fresh = row.days_behind !== null && row.days_behind <= 7;
if (!fresh) failed++;
console.log(`${fresh ? 'PASS' : 'FAIL'}  ${'data_freshness'.padEnd(20)} dataThrough=${row.data_through} daysBehind=${row.days_behind}`);

console.log(`\n  total_rows     = ${row.total_rows}`);
console.log(`  legacy         = ${row.legacy_count}`);
console.log(`  backfill       = ${row.backfill_count}`);
console.log(`  dataThrough    = ${row.data_through} (today ${today.toISOString().slice(0, 10)})`);

if (failed) {
  console.error(`\n[verify] ${failed} check(s) FAILED — fix before deploying.`);
  process.exit(1);
}
console.log('\n[verify] ALL PASS');
