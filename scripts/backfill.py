#!/usr/bin/env python3
"""
离线补齐 · 第 2 步：按月分段拉取 2025-04-11 至今的拍卖数据。

为什么按月分段（spec §0.2b / F-32~F-34）：
    - `search` 不带日期参数会返回 >12.6MB 且 64s 传不完，Worker 更不能碰
    - `auctioned` 只能返回最新 250 条（最早到 2025-05-08），补不齐缺口
    - 实测 `search?...&startDate=&endDate=&dateFieldName=competitiveAuctionCloseDate`
      单月返回 40 条 / 270KB / 2.3s，日期范围精确

⚠️ `dateFieldName=competitiveAuctionCloseDate` 不可省略（F-33）：
    省略后会按其它日期字段过滤，结果偏移约 6 天，会静默污染数据。

职责边界：只负责 HTTP 与粗过滤，不做归一化；归一化统一在
scripts/build_sql.mjs → src/normalize.ts 完成。

输出：data/backfill-raw.json
执行：npm run data:backfill
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "data" / "backfill-raw.json"

BASE_URL = "https://www.treasurydirect.gov/TA_WS/securities/search"
START = date(2025, 4, 11)  # 历史库最后一天是 2025-04-10，从次日开始补
TODAY = datetime.now(timezone.utc).date()
REQUEST_TIMEOUT = 60
MAX_RETRIES = 3


def month_segments(start: date, end: date):
    """生成 [月初, 次月初) 区间；第一段从 start 当日开始，最后一段到 end 当日结束。"""
    cursor = start
    while cursor <= end:
        if cursor.month == 12:
            nxt = date(cursor.year + 1, 1, 1)
        else:
            nxt = date(cursor.year, cursor.month + 1, 1)
        seg_end = min(nxt - timedelta(days=1), end)
        yield cursor, seg_end
        cursor = nxt


def fetch_segment(seg_start: date, seg_end: date) -> list[dict]:
    # endDate 用「不含」语义更安全：这里按官方闭区间传 seg_end 当天
    params = urllib.parse.urlencode(
        {
            "format": "json",
            "startDate": seg_start.isoformat(),
            "endDate": seg_end.isoformat(),
            "dateFieldName": "competitiveAuctionCloseDate",
        }
    )
    url = f"{BASE_URL}?{params}"
    last_err: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "daily-tracker/1.0 (+personal research)"}
            )
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                raw = resp.read().decode("utf-8")
            data = json.loads(raw)
            if not isinstance(data, list):
                raise ValueError(f"unexpected payload type {type(data).__name__}")
            return data
        except Exception as exc:  # 网络抖动 / 上游 5xx，退避重试
            last_err = exc
            print(f"  retry {attempt}/{MAX_RETRIES}: {exc}")
            time.sleep(1.5 * attempt)
    raise RuntimeError(f"segment {seg_start}~{seg_end} failed: {last_err}")


def main() -> None:
    collected: list[dict] = []
    today_iso = TODAY.isoformat()

    for seg_start, seg_end in month_segments(START, TODAY):
        rows = fetch_segment(seg_start, seg_end)
        kept = 0
        for r in rows:
            close = str(r.get("competitiveAuctionCloseDate") or "")[:10]
            offering = r.get("offeringAmount")
            # 排除尚未举行的 announced，以及无发行金额的记录
            if not close or close > today_iso or not offering:
                continue
            collected.append(r)
            kept += 1
        print(f"  {seg_start}~{seg_end}: {len(rows)} fetched, {kept} kept")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(collected, ensure_ascii=False), encoding="utf-8")
    print(f"[backfill] total {len(collected)} raw records -> {OUTPUT}")
    print("[backfill] next: node scripts/build_sql.mjs")


if __name__ == "__main__":
    main()
