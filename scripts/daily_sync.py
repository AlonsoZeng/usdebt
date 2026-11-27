#!/usr/bin/env python3
"""
本地每日同步 · 抓取 → 生成 SQL → 推送 D1 → 记录 runs

为什么抓取必须放在本地（CHG-04，实测依据）：
    TreasuryDirect 的 F5 只在 TLS 握手层丢弃来自 Cloudflare 网络的连接。
    诊断证据（/api/diag，2026-11-27）：
        treasury_http  → 302 / 149ms   明文可通，说明 TCP/IP/服务器都正常
        treasury_https → 超时 / 525    TLS 握手建立不起来
        tls12_only     → 200 / 275ms   出站能协商 TLS 1.2，排除协议不兼容
    Cloudflare 无法改变出口 IP 与 TLS 指纹，因此 Worker 侧无解，抓取下沉本机。

为什么窗口是「今天往前 40 天」而不是「最新 20 条」：
    上游 auctioned 端点只给最新 20 条（约 14 天），断档超过这个跨度就永久补不回；
    search + 日期分段可以精确指定区间，取 40 天有跨月余量，且写入幂等
    （ON CONFLICT DO UPDATE），连续漏跑几天也能自愈。

职责边界：本脚本只做编排，抓取/归一化/SQL 生成全部复用既有实现，不复制规则。

执行：python scripts/daily_sync.py
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RUN_SQL = DATA / "_run.sql"

WRANGLER = ROOT / "node_modules" / "wrangler" / "bin" / "wrangler.js"
DB_NAME = "daily_tracker"

WINDOW_DAYS = 40          # 跨月余量，抗连续漏跑
EARLIEST = date(2025, 4, 11)  # 历史库最后一天是 2025-04-10


def run(cmd: list[str], label: str) -> str:
    """执行子命令，失败即抛错（由 main 统一记录 failed）。"""
    print(f"[sync] {label} ...")
    proc = subprocess.run(
        cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise RuntimeError(f"{label} failed (exit {proc.returncode})\n{out[-800:]}")
    tail = [ln for ln in out.splitlines() if ln.strip()][-3:]
    for ln in tail:
        print(f"       {ln}")
    return out


def record_run(status: str, detail: dict) -> None:
    """把本次执行写入 runs，供 /api/health 与页面展示。写失败不应掩盖主流程结果。"""
    now = datetime.now(timezone.utc).isoformat()
    payload = json.dumps(detail, ensure_ascii=False).replace("'", "''")
    DATA.mkdir(parents=True, exist_ok=True)
    RUN_SQL.write_text(
        "INSERT INTO runs (started_at, finished_at, status, detail) VALUES "
        f"('{now}', '{now}', '{status}', '{payload}');\n",
        encoding="utf-8",
    )
    try:
        run(
            ["node", str(WRANGLER), "d1", "execute", DB_NAME, "--remote",
             "--file=./data/_run.sql"],
            f"record runs ({status})",
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[sync] WARN 写 runs 失败：{exc}")


def main() -> int:
    started = datetime.now(timezone.utc)
    start = max(EARLIEST, started.date() - timedelta(days=WINDOW_DAYS))
    print(f"[sync] window {start} ~ {started.date()}  ({WINDOW_DAYS} 天)")

    try:
        run([sys.executable, "scripts/backfill.py", start.isoformat()], "fetch upstream")
        run(["node", "scripts/build_sql.mjs"], "build sql")
        run(
            ["node", str(WRANGLER), "d1", "execute", DB_NAME, "--remote",
             "--file=./data/backfill.sql"],
            "push to d1",
        )
    except Exception as exc:  # noqa: BLE001
        err = str(exc)
        print(f"[sync] FAILED\n{err}")
        record_run("failed", {"kind": "local_push", "error": err[:1500]})
        return 1

    raw_count = json.loads((DATA / "backfill-raw.json").read_text(encoding="utf-8"))
    closes = sorted(
        str(r.get("competitiveAuctionCloseDate") or "")[:10] for r in raw_count
    )
    detail = {
        "kind": "local_push",
        "window": f"{start}~{started.date()}",
        "fetched": len(raw_count),
        "range": f"{closes[0]}~{closes[-1]}" if closes else None,
        "elapsed_ms": int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
    }
    record_run("ok", detail)
    print(f"[sync] DONE {detail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
