-- 单条标量子查询：一次拿到全部验收数值，供 scripts/verify.mjs 断言。
-- 不用 UNION ALL —— D1 对 compound SELECT 的 term 数限制比标准 SQLite 更严。
-- 对应 spec：AC-03 / AC-09。
SELECT
  (SELECT COUNT(*) FROM auctions WHERE source = 'legacy_sqlite') AS legacy_count,
  (SELECT MIN(auction_date) FROM auctions WHERE source = 'legacy_sqlite') AS legacy_min,
  (SELECT COUNT(*) FROM auctions WHERE auction_date LIKE '% %') AS messy_dates,
  (SELECT COUNT(*) FROM auctions) -
    (SELECT COUNT(*) FROM (SELECT DISTINCT cusip, auction_date, security_term FROM auctions)) AS dup_keys,
  (SELECT COUNT(*) FROM auctions WHERE term_months IS NULL OR term_months < 0) AS bad_months,
  (SELECT COUNT(*) FROM auctions WHERE offering_amount_usd IS NULL) AS bad_amounts,
  (SELECT CAST(offering_amount_usd AS INTEGER) FROM auctions
     WHERE cusip = '912810UG1' AND auction_date = '2025-04-10') AS sample_amount,
  (SELECT MAX(auction_date) FROM auctions) AS data_through,
  (SELECT CAST(julianday('now') - julianday(MAX(auction_date)) AS INTEGER) FROM auctions) AS days_behind,
  (SELECT COUNT(*) FROM auctions WHERE source = 'treasurydirect_api') AS backfill_count,
  (SELECT COUNT(*) FROM auctions) AS total_rows;
