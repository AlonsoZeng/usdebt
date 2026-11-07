#!/usr/bin/env python3
"""
离线迁移 · 第 1 步：把旧 SQLite 的原始行导出为 JSON。

职责边界（很重要）：
    本脚本 **不做任何归一化**。单位换算、日期清洗、枚举大写、去重、派生
    全部由 scripts/build_sql.mjs 调用 src/normalize.ts 统一完成。
    这样归一化规则全项目只有一份实现，不会出现 Python/TS 两套规则漂移。

输入：工作区根目录 usdebt.db（来自 github.com/AlonsoZeng/usdebt）
输出：data/legacy-raw.json  —— 4014 行 × 77 列的原始 dict 数组

执行：npm run data:migrate
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DB = ROOT.parent / "usdebt.db"
OUTPUT = ROOT / "data" / "legacy-raw.json"

EXPECTED_ROWS = 4014
# 记录校验和以便复现；来源 https://raw.githubusercontent.com/AlonsoZeng/usdebt/main/server/mydatabase.db
EXPECTED_SHA256 = "4cae45e87e627feaf3beb9f0b80ede8bd458c29761274a63ea1e7e20cb7059a8"


def main() -> None:
    if not SOURCE_DB.exists():
        raise SystemExit(f"missing input: {SOURCE_DB}")

    digest = hashlib.sha256(SOURCE_DB.read_bytes()).hexdigest()
    if digest != EXPECTED_SHA256:
        raise SystemExit(
            f"input checksum mismatch\n  expected {EXPECTED_SHA256}\n  actual   {digest}\n"
            "If the source file was intentionally updated, update EXPECTED_SHA256 and re-verify."
        )

    conn = sqlite3.connect(SOURCE_DB)
    conn.row_factory = sqlite3.Row
    try:
        rows = [dict(r) for r in conn.execute("SELECT * FROM mytable")]
    finally:
        conn.close()

    if len(rows) != EXPECTED_ROWS:
        raise SystemExit(f"expected {EXPECTED_ROWS} rows, got {len(rows)}")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    print(f"[migrate_legacy] sha256 ok, exported {len(rows)} rows -> {OUTPUT}")
    print(f"[migrate_legacy] next: npm run data:backfill && node scripts/build_sql.mjs")


if __name__ == "__main__":
    main()
