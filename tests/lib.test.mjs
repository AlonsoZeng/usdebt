/**
 * UNIT 验收：前端聚合逻辑（AC-05）。
 * public/lib.js 是纯函数，浏览器与 node 都能加载，所以图表数学可离线验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isoWeek, isoWeekKey, monthKey, movingAverage,
  buildStack, weeklyCompare, fillDaily, BILLION
} from '../public/lib.js';

test('ISO year, not calendar year, for cross-year weeks (C-02 / AC-05)', () => {
  assert.deepEqual(isoWeek('2014-12-29'), { year: 2015, week: 1 });
  assert.equal(isoWeekKey('2014-12-29'), '2015-W01');
  assert.equal(isoWeekKey('2018-12-31'), '2019-W01');
  assert.equal(isoWeekKey('2025-01-02'), '2025-W01');
});

test('week keys sort chronologically as strings', () => {
  const keys = ['2025-W01', '2024-W52', '2015-W01', '2024-W01'].sort();
  assert.deepEqual(keys, ['2015-W01', '2024-W01', '2024-W52', '2025-W01']);
  assert.ok('2024-W52' < '2025-W01');
});

test('monthKey keeps YYYY-MM', () => {
  assert.equal(monthKey('2025-04-10'), '2025-04');
});

test('movingAverage matches pandas rolling(window, min_periods=1)', () => {
  assert.deepEqual(movingAverage([1, 2, 3, 4, 5], 3), [1, 1.5, 2, 3, 4]);
  assert.deepEqual(movingAverage([10], 5), [10]);
  assert.deepEqual(movingAverage([], 5), []);
});

const ROWS = [
  { d: '2025-01-06', m: 1, a: 30 * BILLION, t: 'BILL' },
  { d: '2025-01-07', m: 1, a: 20 * BILLION, t: 'BILL' },
  { d: '2025-01-08', m: 120, a: 10 * BILLION, t: 'NOTE' },
  { d: '2025-01-13', m: 1, a: 5 * BILLION, t: 'BILL' },
  { d: '2025-01-14', m: 120, a: 15 * BILLION, t: 'NOTE' }
];

test('buildStack groups by ISO week and sums by term bucket', () => {
  const s = buildStack(ROWS, 'week');
  assert.deepEqual(s.labels, ['2025-W02', '2025-W03']);
  assert.deepEqual(s.totals, [60, 20]);
  const short = s.datasets.find((d) => d.term === 1);
  const long = s.datasets.find((d) => d.term === 120);
  assert.deepEqual(short.data, [50, 5]);
  assert.deepEqual(long.data, [10, 15]);
  assert.equal(s.mas[5].length, 2);
  assert.equal(s.mas[5][1], 40); // (60 + 20) / 2
});

test('buildStack month mode', () => {
  const s = buildStack(ROWS, 'month');
  assert.deepEqual(s.labels, ['2025-01']);
  assert.deepEqual(s.totals, [80]);
});

test('weeklyCompare excludes the unfinished current week', () => {
  // 2025-01-20 falls in W04, so W02 and W03 are both complete weeks
  const cmp = weeklyCompare(ROWS, '2025-01-20');
  assert.deepEqual(cmp.keys, ['2025-W02', '2025-W03']);
  assert.equal(cmp.series.length, 2);
  assert.deepEqual(cmp.series[0].data, [50, 10]);
});

test('fillDaily pads missing values with zero', () => {
  assert.deepEqual(
    fillDaily(['2025-01-01', '2025-01-02'], [BILLION, 0]),
    [{ day: '2025-01-01', value: 1 }, { day: '2025-01-02', value: 0 }]
  );
});
