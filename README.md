# daily-tracker

美国国债发行数据（TreasuryDirect）的边缘端分析面板。零服务器、零成本：一个 Cloudflare Worker + 一个 D1 + 一个 Cron。

**规格是唯一事实源**：`docs/spec/02-to-be.md`（APPROVED v2）。改代码前先读它；实现与规格不一致时，先改规格，不要只改代码。

## 给新接手的 Agent：5 分钟读懂

```
docs/spec/01-as-is.md            旧系统做了什么（FROZEN，只读）
docs/spec/02-to-be.md    ★       目标规格：数据模型、API、抓取、迁移、验收条件
docs/spec/03-adversarial-review.md  规格审查与补丁记录（已 CLOSED）

src/normalize.ts         ★ 归一化唯一实现：字段双读 / 单位 / 日期 / 枚举
src/index.ts                Worker 入口：4 个 GET 接口 + 1 个写接口 + /api/diag
src/db.ts                   D1 查询（列名白名单，禁止 SELECT *）
src/notify.ts               Resend / webhook 告警（本期未启用，见待办）
public/                     单页仪表盘 + i18n 字典
scripts/migrate_legacy.py   离线：usdebt.db → data/migration.sql
scripts/backfill.py         离线：按日期分段抓取 → data/backfill-raw.json（支持 --start）
scripts/daily_sync.py   ★   每日同步：抓取 → 生成 SQL → 推 D1 → 记 runs
scripts/build_sql.mjs       归一化 + 生成幂等 SQL（复用 src/normalize.ts）
sync_daily.cmd              Windows 包装器（自动化 / 手动双击，日志写 logs/）
tests/                      纯函数 fixture 与验收断言
schema.sql                  全部 IF NOT EXISTS，可重复执行
```

三条最容易踩的约定：

1. **`offering_amount_usd` 是 USD 绝对值**。历史库 `OfferingAmount=22.0` 是「十亿美元」，迁移时 × 1e9；上游新接口 `offeringAmount="115000000000"` 已是 USD。
2. **唯一键是 `(cusip, auction_date, security_term)`**。CUSIP 不唯一（增发债同码多场）；日期必须归一化到 `YYYY-MM-DD`，否则同一场拍卖会因 `00:00:00` 后缀产生重复行。
3. **抓取只能在本机跑，云端 cron 已废弃**。上游的 F5 在 TLS 握手层丢弃 Cloudflare 网络连接（诊断证据见下节），不要再把抓取写回 Worker。Worker 只负责存储与展示，CPU 10 ms 的限制依旧，聚合仍在浏览器算。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 纯函数单测（离线，不依赖网络） |
| `npm run deploy` | 部署到 Cloudflare |
| `npm run tail` | 看线上实时日志 / CPU 耗时 |
| `npm run db:init` | 建表（幂等） |
| `npm run db:migrate` | 灌入 4011 条历史数据 |
| `npm run db:backfill` | 灌入补数数据 |
| `npm run db:verify` | 远端 SQL 断言 |
| `npm run data:sync` | ★ 每日同步：抓取 → 生成 SQL → 推 D1 → 记 runs（本地跑） |

离线数据流水线：`python scripts/migrate_legacy.py` → `python scripts/backfill.py` → `npm run db:init` → `db:migrate` → `db:backfill` → `db:verify`。

## 环境与限制

- 本机 Windows 上 `workerd` 会栈溢出，**`wrangler dev` 不可用**。开发循环是 `改代码 → npm run deploy → 刷新页面`。
- 会话内网络代理不放行 `*.workers.dev`，**HTTP 与页面验收必须由人在浏览器完成**；spec 中所有 `LIVE` 验收项都不声称自动通过。
- **`schtasks.exe` 被本机安全策略列入程序黑名单**（不可绕过），因此每日定时改用 **WorkBuddy 自动化**：任务名「daily-tracker 每日数据同步」，每天 09:30 跑 `scripts/daily_sync.py`。要改时间或暂停，在 WorkBuddy 自动化列表里操作即可。
- 若要在系统层做定时（不依赖 WorkBuddy），需先解除该程序黑名单，再 `schtasks /Create /TN "daily-tracker-sync" /TR "<仓库路径>\sync_daily.cmd" /SC DAILY /ST 09:30`。
- 仓库：`https://github.com/AlonsoZeng/usdebt`。旧版 Flask 项目保留在 `legacy/v1` 分支及 `main` 的历史提交中，可随时 `git checkout legacy/v1` 找回（含 `server/mydatabase.db` 迁移输入）。
- `.gitignore` 已排除全部凭据与生成物：`.manual-key.txt`、`.dev.vars`、`*.db`、`*.exe`、`data/`、`node_modules/`、`.wrangler/`、`dist/`。**推代码前请确认这些文件未被 `git add -f`**。

## 线上

- URL：`https://daily-tracker.alonsozeng.workers.dev`
- D1：`daily_tracker`（`80d7ee7d-a4d3-4e91-a7d9-3d056f07a13c`，WNAM/LAX）
- Cron：**已移除**（CHG-04，见下节诊断结论）；`wrangler.jsonc` 保留注释，上游解封可恢复
- 当前版本：`e5bbd6e7-e491-4389-a7db-1deba22d6544`
- 每日抓取：WorkBuddy 自动化「daily-tracker 每日数据同步」，每天 09:30
- Secrets：`MANUAL_KEY`（已轮换）、`NOTIFY_EMAIL`（`alonsozeng@gmail.com`）、`RESEND_API_KEY`（**待提供**）

### 每日自动更新怎么工作（CHG-04：抓取已下沉本地）

```
WorkBuddy 自动化（每天 09:30）
  → python scripts/daily_sync.py
      ├─ backfill.py      按日期分段拉「今天往前 40 天」，本机直连上游
      ├─ build_sql.mjs    复用 src/normalize.ts 归一化 + 生成幂等 SQL
      ├─ wrangler d1      --remote --file=data/backfill.sql 写入
      └─ runs 表          记一条 ok / failed（detail.kind = local_push）
```

**为什么不在云端抓**：TreasuryDirect 的 F5 只在 **TLS 握手层**丢弃来自 Cloudflare 网络的连接。2026-11-27 用 `/api/diag` 实测：

| 目标 | 结果 | 推论 |
|---|---|---|
| `treasury_http`（明文 80） | 302 / 149 ms | TCP、IP、上游服务器全部正常 |
| `treasury_https`（TLS 443） | 超时 8 s（cron 中报 `525`） | 仅 TLS 握手被拒 |
| `tls12_only.badssl.com` | 200 / 275 ms | 出站能协商 TLS 1.2，排除协议不兼容 |
| `google.com` | 302 | 出站链路本身健康 |

Cloudflare 无法改变出口 IP 与 TLS 指纹，因此 **Worker 侧无解**，`wrangler.jsonc` 里的 cron 已移除（保留注释，上游解封可恢复）。

- **窗口 40 天而不是「最新 20 条」**：上游 `auctioned` 只给最新 20 条（约 14 天），断档超过就补不回；`search` 可按日期精确分段，40 天有跨月余量，写入幂等，连续漏跑几天能自愈。
- **手动跑**：`npm run data:sync`，或双击 `sync_daily.cmd`（会追加日志到 `logs/daily_sync.log`）。
- **怎么确认它在跑**：`runs` 表最新一条 `status='ok'` 且 `detail.kind='local_push'`；或看 `/api/health` 的 `lastRun` / `stale`（超过 36 小时无成功即 `stale=true`）。
- **依赖**：这台电脑要开机且能直连 `treasurydirect.gov`。关机就断更，恢复后 40 天窗口会自动补齐。
- **只读诊断**：`GET /api/diag` 会并行探测 4 个固定目标（不接受外部参数，不能当 SSRF 跳板），结果写入 `runs(status='diag')`，用于将来排查上游变化。

### 低优先级待办（本期明确不做）

1. **通知渠道**：`src/notify.ts` 与 secret `NOTIFY_EMAIL` 已就位，只缺一枚第三方 key。二选一：
   - Resend：`resend.com` 用 `alonsozeng@gmail.com` 注册 → 生成 key → `echo '<key>' | npx wrangler secret put RESEND_API_KEY`
   - 国内可达机器人：`echo '<webhook>' | npx wrangler secret put NOTIFY_WEBHOOK`
   
   未配置时 `/api/health.notify = "skipped"` 是**预期状态**，不是故障。失败信息仍完整落在 `runs.detail`，页面 `stale` 字段可替代被动监控。
2. **英文界面**：架构已字典化，加 `public/i18n/en.json` 即可，无需改 DB / API。

### 验收状态（2026-11-27）

| 层 | 结果 |
|---|---|
| UNIT | ✅ `npm test` 22/22（归一化、单位、日期、ISO 周、MA、SQL 白名单） |
| BUILD | ✅ `tsc --noEmit`、`wrangler deploy`（21.99 KiB / gzip 6.35 KiB） |
| DATA | ✅ `db:verify` ALL PASS：**4727 行**（4011 历史 + 716 补数），数据截至 `2026-11-25`，落后 2 天 |
| DEPLOY | ✅ 版本 `e5bbd6e7`，6 个静态资源，cron 已移除 |
| CRON（已废弃） | ❌ **连续 20 天全失败**：2026-11-08 ~ 11-27 每天 01:05 UTC 准点触发，全部 `upstream HTTP 525`。根因为上游 TLS 层定向拦截（见上节诊断表），cron 移除、抓取下沉本地 |
| LOCAL SYNC | ✅ 端到端跑通：40 天窗口 → 抓 55 条 → 幂等写入 → `runs` 记 `ok / local_push`，13.5 s |
| AUTOMATION | ✅ WorkBuddy 自动化已建（每天 09:30），下次运行 2026-11-28 09:30 |
| LIVE | ⏳ **待人工**：会话网络不放行 `workers.dev`，页面渲染仍需在浏览器确认 |

**这一轮的两件关键事实**：① 2026-11-05 → 11-25 的 20 天数据缺口已补齐；② `runs` 表现在同时承载云端诊断（`status='diag'`）与本地同步（`kind='local_push'`），健康检查只统计 `ok`/`failed`，诊断记录不会污染状态。
