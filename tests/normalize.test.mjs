/**
 * UNIT 验收：归一化规则与查询白名单。
 * 不依赖网络、不依赖 workerd —— 本机 `npm test` 即可跑。
 * 对应 spec：AC-02 / AC-03 / AC-04 / AC-05。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normDate, normTerm, normType, termMonths, legacyAmountToUsd,
  normalizeApi, normalizeLegacy, dedupeKey, DAILY_WINDOW
} from '../src/normalize.ts';
import {
  whitelistDateField, whitelistType, listAuctionsQuery,
  analyticsRowsQuery, monthlyQuery, AUCTION_COLUMNS
} from '../src/db.ts';

const NOW = '2026-11-07T00:00:00.000Z';

/** 上游 2026-10 改版后的字段（实测样本） */
const API_NEW = {
  cusip: '912797WE3',
  competitiveAuctionCloseDate: '2026-11-05T00:00:00',
  issueDate: '2026-11-10T00:00:00',
  maturityDate: '2026-12-08T00:00:00',
  securityType: 'Bill',
  securityTerm: '4-Week',
  offeringAmount: '115000000000',
  treasuryOfferingAnnouncementXmlFileName: 'A_20261103_1.xml'
};

/** 同一条记录用改版前的旧字段名（字段双读契约） */
const API_OLD = {
  cusip: '912797WE3',
  auctionDate: '2026-11-05T00:00:00',
  issueDate: '2026-11-10T00:00:00',
  maturityDate: '2026-12-08T00:00:00',
  securityType: 'Bill',
  securityTerm: '4-Week',
  totalAccepted: '115000000000',
  xmlFilenameAnnouncement: 'A_20261103_1.xml'
};

const LEGACY_ROW = {
  CUSIP: '912810UG1',
  AuctionDate: '2025-04-10 00:00:00',
  IssueDate: '2025-04-15 00:00:00',
  MaturityDate: '2055-02-15 00:00:00',
  AnnouncementDate: '2025-04-03',
  SecurityType: 'BOND',
  SecurityTermWeekYear: '29-YEAR',
  OfferingAmount: 22.0,
  '久期(月数整数)': 358,
  url: 'https://www.treasurydirect.gov/xml/A_20250403_2.xml'
};

test('normDate strips timestamp suffix and ISO time part', () => {
  assert.equal(normDate('2025-04-10 00:00:00'), '2025-04-10');
  assert.equal(normDate('2026-11-05T00:00:00'), '2026-11-05');
  assert.equal(normDate('2025-04-10'), '2025-04-10');
  assert.equal(normDate('garbage'), null);
  assert.equal(normDate(null), null);
});

test('normTerm fixes whitespace/newline and keeps case-only changes clean', () => {
  assert.deepEqual(normTerm('1317\nWEEK'), { value: '1317-WEEK', dirty: true });
  assert.deepEqual(normTerm('4-Week'), { value: '4-WEEK', dirty: false });
  assert.equal(normType('Bill'), 'BILL');
  assert.equal(normType('unknown-thing'), 'UNKNOWN');
});

test('field aliases: renamed upstream fields produce the same row (AC-04)', () => {
  const a = normalizeApi(API_NEW, NOW);
  const b = normalizeApi(API_OLD, NOW);
  assert.equal(a.error, null);
  assert.equal(b.error, null);
  assert.equal(a.row.auction_date, '2026-11-05');
  assert.equal(a.row.auction_date, b.row.auction_date);
  assert.equal(a.row.offering_amount_usd, b.row.offering_amount_usd);
  assert.equal(a.row.source_key, b.row.source_key);
});

test('new API amount is already USD, no scaling', () => {
  const n = normalizeApi(API_NEW, NOW);
  assert.equal(n.row.offering_amount_usd, 115_000_000_000);
  assert.equal(n.row.security_type, 'BILL');
  assert.equal(n.row.term_months, 1);
});

test('legacy amount is billions -> USD (AC-03 sample)', () => {
  const n = normalizeLegacy(LEGACY_ROW, { now: NOW, maxOffering: 95 });
  assert.equal(n.error, null);
  assert.equal(n.row.offering_amount_usd, 22_000_000_000);
  assert.equal(n.row.auction_date, '2025-04-10');
  assert.equal(n.row.term_months, 358);
  assert.equal(n.row.source_key, LEGACY_ROW.url);
});

test('unit heuristic: max>=1000 means already USD (P-04)', () => {
  assert.equal(legacyAmountToUsd(22, 95), 22_000_000_000);
  assert.equal(legacyAmountToUsd(22_000_000_000, 95_000_000_000), 22_000_000_000);
});

test('termMonths falls back when dates are missing (P-13)', () => {
  assert.equal(termMonths(null, null, 36, '3-YEAR').value, 36);
  assert.equal(termMonths(null, null, null, '3-YEAR').value, 36);
  assert.equal(termMonths('2025-01-01', '2028-01-01', 999, '').value, 36);
  assert.equal(termMonths(null, null, null, '').value, 0);
});

test('dedupeKey uses the 3-part key and normalizes date suffix away', () => {
  const a = normalizeLegacy(LEGACY_ROW, { now: NOW, maxOffering: 95 }).row;
  const b = normalizeLegacy(
    { ...LEGACY_ROW, AuctionDate: '2025-04-10' }, { now: NOW, maxOffering: 95 }
  ).row;
  assert.equal(dedupeKey(a), dedupeKey(b)); // 3 duplicate pairs collapse correctly
});

test('required-field contract rejects broken records (R-4d)', () => {
  assert.match(normalizeApi({ ...API_NEW, cusip: '' }, NOW).error, /cusip/);
  assert.match(normalizeApi({ ...API_NEW, offeringAmount: '' }, NOW).error, /offeringAmount/);
  assert.match(normalizeApi({ ...API_NEW, competitiveAuctionCloseDate: 'xxx' }, NOW).error, /auction date/);
});

test('raw_json drops empty fields (keeps SQL small)', () => {
  const n = normalizeApi({ ...API_NEW, emptyField: '', nullField: null }, NOW);
  const raw = JSON.parse(n.row.raw_json);
  assert.ok(!('emptyField' in raw));
  assert.ok(!('nullField' in raw));
  assert.equal(raw.cusip, '912797WE3');
});

/* --------------------------- query safety (AC-02) --------------------------- */

test('SQL injection attempts are rejected by whitelists', () => {
  assert.equal(whitelistDateField("auction_date; DROP TABLE auctions--"), null);
  assert.equal(whitelistDateField('auction_date'), 'auction_date');
  assert.equal(whitelistType("BILL' OR 1=1--"), null);
  assert.equal(whitelistType('bill'), 'BILL');
});

test('all queries use explicit columns, never SELECT * (P-06)', () => {
  const queries = [
    listAuctionsQuery(new URLSearchParams('from=2025-01-01')),
    analyticsRowsQuery(new URLSearchParams(), '2026-11-05'),
    monthlyQuery('auction_date', 2026, 11)
  ];
  for (const q of queries) {
    assert.ok(q.sql.length > 0);
    assert.ok(!/SELECT\s+\*/i.test(q.sql), q.sql);
    assert.ok(!q.sql.includes('raw_json') || q.sql.includes(AUCTION_COLUMNS));
  }
});

test('analytics default range is anchored on dataThrough, not today (P-02)', () => {
  const q = analyticsRowsQuery(new URLSearchParams(), '2026-11-05');
  assert.deepEqual(q.binds[0], '2021-11-05');
  assert.deepEqual(q.binds[1], '2026-11-05');
  assert.equal(q.binds[2], 2000);
});

test('daily window stays small enough for the 10ms CPU budget (P-01)', () => {
  assert.ok(DAILY_WINDOW <= 20);
});
