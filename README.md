# daily-tracker

美国国债发行数据（TreasuryDirect）的边缘端分析面板。零服务器、零成本：一个 Cloudflare Worker + 一个 D1 + 一个 Cron。

**规格是唯一事实源**：`docs/spec/02-to-be.md`（APPROVED v2）。改代码前先读它；实现与规格不一致时，先改规格，不要只改代码。

## 给新接手的 Agent：5 分钟读懂

```
docs/spec/01-as-is.md            旧系统做了什么（FROZEN，只读）
docs/spec/02-to-be.md    ★       目标规格：数据模型、API、抓取、迁移、验收条件
docs/spec/03-adversarial-review.md  规格审查与补丁记录（已 CLOSED）

src/normalize.ts         ★ 归一化唯一实现：字段双读 / 单位 / 日期 / 枚举
src/index.ts                Worker 入口：Cron + 4 个 GET 接口 + 1 个写接口
src/db.ts                   D1 查询（列名白名单，禁止 SELECT *）
src/notify.ts               Resend 告警
public/                     单页仪表盘 + i18n 字典
scripts/migrate_legacy.py   离线：usdebt.db → data/migration.sql
scripts/backfill.py         离线：按月补 2025-04-11 起缺口 → data/backfill.sql
tests/                      纯函数 fixture 与验收断言
schema.sql                  全部 IF NOT EXISTS，可重复执行
```

三条最容易踩的约定：

1. **`offering_amount_usd` 是 USD 绝对值**。历史库 `OfferingAmount=22.0` 是「十亿美元」，迁移时 × 1e9；上游新接口 `offeringAmount="115000000000"` 已是 USD。
2. **唯一键是 `(cusip, auction_date, security_term)`**。CUSIP 不唯一（增发债同码多场）；日期必须归一化到 `YYYY-MM-DD`，否则同一场拍卖会因 `00:00:00` 后缀产生重复行。
3. **Worker 免费版 CPU 只有 10 ms/次**。透视、堆叠、MA 均线全在浏览器算；Worker 只返回轻量行。每日抓取窗口固定 20 条（约 140 KB），不许拉 250 条那个 1.7 MB 响应。

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

离线数据流水线：`python scripts/migrate_legacy.py` → `python scripts/backfill.py` → `npm run db:init` → `db:migrate` → `db:backfill` → `db:verify`。

## 环境与限制

- 本机 Windows 上 `workerd` 会栈溢出，**`wrangler dev` 不可用**。开发循环是 `改代码 → npm run deploy → 刷新页面`。
- 会话内网络代理不放行 `*.workers.dev`，**HTTP 与页面验收必须由人在浏览器完成**；spec 中所有 `LIVE` 验收项都不声称自动通过。
- 仓库：`https://github.com/AlonsoZeng/usdebt`。旧版 Flask 项目保留在 `legacy/v1` 分支及 `main` 的历史提交中，可随时 `git checkout legacy/v1` 找回（含 `server/mydatabase.db` 迁移输入）。
- `.gitignore` 已排除全部凭据与生成物：`.manual-key.txt`、`.dev.vars`、`*.db`、`*.exe`、`data/`、`node_modules/`、`.wrangler/`、`dist/`。**推代码前请确认这些文件未被 `git add -f`**。

## 线上

- URL：`https://daily-tracker.alonsozeng.workers.dev`
- D1：`daily_tracker`（`80d7ee7d-a4d3-4e91-a7d9-3d056f07a13c`，WNAM/LAX）
- Cron：`5 1 * * *`（UTC 01:05，刻意避开整点高峰）
- 当前版本：`c9681811-07af-4da6-bac7-fea29956ba7e`
- Secrets：`MANUAL_KEY`（已轮换）、`NOTIFY_EMAIL`（`alonsozeng@gmail.com`）、`RESEND_API_KEY`（**待提供**）

### 每日自动更新怎么工作

```
UTC 01:05（北京 09:05）  Cron 唤醒 Worker
  → GET auctioned?format=json&pagesize=20     最新 20 条，约 140 KB
  → normalizeApi() 逐条归一化（字段双读 / 单位 / 日期）
  → 幂等 upsert 到 D1（cusip | auction_date | security_term）
  → runs 表记一条 ok / failed + detail JSON
  → notify()（本期跳过，见下方待办）
```

- 上游忽略所有日期与翻页参数，只能取「最新 N 条」。窗口 20 条实测覆盖约 14 个自然日 / 9 个拍卖日，对「每天一次」余量充足。
- **断档保护**：若连续超过约 14 天没成功跑，恢复后 20 条窗口补不回更早缺口，需拉大窗口手动补跑：
  `curl -X POST -H "x-manual-key: <MANUAL_KEY>" "https://daily-tracker.alonsozeng.workers.dev/api/run?window=250"`
- **怎么确认它在跑**：看 `/api/health` 的 `lastRun` / `lastStatus` / `stale`，或查 `runs` 表。`runs` 为空即表示一次都没跑过。
- 没有新拍卖的日子也会把这 20 条幂等重放一遍，`runs.detail.changed = 0` 属正常，不是空转故障。

### 低优先级待办（本期明确不做）

1. **通知渠道**：`src/notify.ts` 与 secret `NOTIFY_EMAIL` 已就位，只缺一枚第三方 key。二选一：
   - Resend：`resend.com` 用 `alonsozeng@gmail.com` 注册 → 生成 key → `echo '<key>' | npx wrangler secret put RESEND_API_KEY`
   - 国内可达机器人：`echo '<webhook>' | npx wrangler secret put NOTIFY_WEBHOOK`
   
   未配置时 `/api/health.notify = "skipped"` 是**预期状态**，不是故障。失败信息仍完整落在 `runs.detail`，页面 `stale` 字段可替代被动监控。
2. **英文界面**：架构已字典化，加 `public/i18n/en.json` 即可，无需改 DB / API。

### 验收状态（2026-11-07）

| 层 | 结果 |
|---|---|
| UNIT | ✅ `npm test` 22/22 通过（归一化、单位、日期、ISO 周、MA、SQL 白名单） |
| BUILD | ✅ `tsc --noEmit`、`wrangler deploy --dry-run` |
| DATA | ✅ `npm run db:verify` ALL PASS：4698 行、数据截至 `2026-11-05`、落后 2 天 |
| DEPLOY | ✅ 静态 5 个资源 + Worker，Cron `5 1 * * *` 已注册，启动 2 ms |
| CRON | ⏳ **首次真实触发待验证**：部署时间已过当日 UTC 01:05，`runs` 表当前为空，下一次为北京时间 2026-11-08 09:05。上游窗口 20 条 → 归一化 20/20 通过 → upsert 契约已本地空跑验证，但线上 cron 本体未跑过 |
| LIVE | ⏳ **待人工**：会话网络不放行 `workers.dev`，页面与 CPU 实 tail 需在浏览器确认 |

LIVE 待看三件事：概览页 6 项状态、堆积图能渲染且末端到 `2026-11-05`、次日 `runs` 新增一条 `ok`（或用 `POST /api/run` 手动触发后 `npm run db:verify` 仍全绿）。

**注意**：库里 `2026-11-05` 那批数据来自离线补数脚本，不是 cron 自动抓的，别把「有最新数据」误判成「自动更新已验证」。
