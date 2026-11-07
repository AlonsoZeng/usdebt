/**
 * daily-tracker schema
 * 规格唯一事实源：docs/spec/02-to-be.md §3.2 / §3.1 R-3f
 * 执行：npm run db:init
 *
 * 全部语句均为 CREATE TABLE IF NOT EXISTS，可重复执行且不丢数据。
 * 不给 runs 加列：运行详情以 JSON 存进既有 detail TEXT 列（见 R-3f）。
 * 下方 metrics / runs 为 v0 遗留结构，保留但 metrics 不再写入。
 */

-- 规范化主表：一行 = 一场国债拍卖
-- 单位约定：offering_amount_usd 一律 USD 绝对值；日期一律 YYYY-MM-DD (UTC)
CREATE TABLE IF NOT EXISTS auctions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  cusip               TEXT    NOT NULL,
  auction_date        TEXT    NOT NULL,
  issue_date          TEXT,
  maturity_date       TEXT,
  announcement_date   TEXT,
  security_type       TEXT    NOT NULL,   -- BILL|NOTE|BOND|TIPS|FRN|CMB|UNKNOWN
  security_term       TEXT    NOT NULL DEFAULT '',
  term_months         INTEGER NOT NULL,   -- round((maturity-issue).days / 30.41667)
  offering_amount_usd REAL    NOT NULL,
  source              TEXT    NOT NULL,   -- legacy_sqlite | treasurydirect_api
  source_key          TEXT,
  raw_json            TEXT,               -- 原始记录保真；列表查询禁止 SELECT *
  imported_at         TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  UNIQUE (cusip, auction_date, security_term)
);

CREATE INDEX IF NOT EXISTS idx_auctions_date ON auctions (auction_date DESC);
CREATE INDEX IF NOT EXISTS idx_auctions_type ON auctions (security_type, auction_date DESC);

-- ============ 以下为 v0 遗留结构，保留兼容 ============

-- 指标表：每个数据源每天一条
-- 主键 (source, day) 是幂等的基础：重跑、补跑都不会产生重复行
CREATE TABLE IF NOT EXISTS metrics (
  source TEXT NOT NULL,
  day    TEXT NOT NULL,          -- YYYY-MM-DD，统一按 UTC 记
  value  REAL NOT NULL,
  raw    TEXT,                   -- 原始返回，便于回溯校验
  PRIMARY KEY (source, day)
);

CREATE INDEX IF NOT EXISTS idx_metrics_day ON metrics (day DESC);

-- 运行记录：用来回答"这东西最近还活着吗"
-- 没有这张表，失败只能靠你想起去看
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,     -- running | ok | failed
  detail      TEXT               -- 失败时存错误信息
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);

-- 可选：灌几条假数据，方便先把界面调通（不需要时删掉这段）
-- INSERT INTO metrics (source, day, value) VALUES
--   ('demo', '2026-11-05', 12.4),
--   ('demo', '2026-11-06', 13.1),
--   ('demo', '2026-11-07', 11.8);
