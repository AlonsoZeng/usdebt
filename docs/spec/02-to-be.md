# 02 · Spec → Spec（To-Be 规格）

> **阶段**：Spec → Spec｜**状态**：**APPROVED v2**（已应用 `03` 的 P-01～P-14 全部补丁，DOR-1～4 已收敛）
> **输入**：`01-as-is.md` 的 `AS-xx` / `F-xx` / `DF-xx`｜**输出**：可实现的规格契约｜**下游**：实现以本文件为唯一事实源
> **编号**：`TB-xx` 对应 `AS-xx`；`AC-xx` 为可机器验证的验收条件；`DOR-xx` 为已收敛决策
> **v2 变更索引**：P-01 CPU 窗口｜P-02 缺口补齐 BLOCKER｜P-03 唯一键｜P-04 单位判定｜P-05 runs 不加列｜P-06 禁 `SELECT *`｜P-07 凭据｜P-08/09 i18n 断言｜P-10 验收分层｜P-11 通知｜P-12 行数上限｜P-13 回退链｜P-14 图表轴

---

## 0. 目标、范围与不可协商约束

### 0.1 用户已确认的范围

| 项 | 决议 |
|---|---|
| 业务范围 | **只做 TreasuryDirect 国债发行一条**；`cdyieldcurve.py` / `WTREGEN.csv` / 中债收益率曲线一律排除 |
| 历史数据 | `usdebt.db` 的 4014 行**直接导入**（按 `TB-03` 归一化，不是原样拷贝） |
| 缺陷 | `DF-01`～`DF-06` **六个全部要改**；`DF-07`～`DF-15` 中影响数据正确性的一并改 |
| 语言 | 本期**不产出英文界面**，但架构必须使后续多语言化无需改数据模型或 API |
| 落点 | 已上线的 `daily-tracker`（Cloudflare Worker + D1 + Cron） |
| 成本 | 零成本；免费额度内运行 |

### 0.1b DOR 决议（用户授权「听你推荐」，2026-11-07 收敛）

| 编号 | 决议 | 理由 |
|---|---|---|
| DOR-1 | **离线补齐 19 个月缺口**：`search` 按 `competitiveAuctionCloseDate` 逐月分段，`2025-04-11` → 今天；补数脚本本地跑，Worker 永不调用 | 实测分段有效（F-32）；不补则默认视图是空白断崖，属验收阻塞 |
| DOR-2 | **Resend 邮件告警到账号注册邮箱**，发件人 `onboarding@resend.dev`（免域名） | 告警接收者是强哥本人在国内，Telegram 不可达；1 封/天 ≪ 100 封/日上限 |
| DOR-3 | **删除功能本期完全不做**（含软删除） | 数据是上游公开数据，错误应靠重抓覆盖；少一个写接口即少一个攻击面 |
| DOR-4 | **暂不 `git init`**；立即补全 `.gitignore` 并轮换 `MANUAL_KEY` | 当前无协作/自动构建需求，初始化只引入口令入库风险；接 GitHub 时再做 |

> 这 4 条替换 v1 的 `OPEN-01`～`OPEN-04`。`OPEN-04` 的图表库选 Chart.js 一并在此定案（等距类目轴，见 TB-06）。

### 0.2 硬约束

| 约束 | 数值 | 对规格的强制影响 |
|---|---|---|
| C-1 Worker CPU | 免费版 **10 ms / 次** | 禁止全量 JSON 解析、透视、均线、PDF/图片处理；**所有接口须有 CPU 预算上限** |
| C-2 Worker 内存 | 128 MB | 单次抓取响应体必须小（v2 定 `< 300 KB`） |
| C-3 D1 | 单库 500 MB；读 500 万行/天、写 10 万行/天 | 4011 历史行 + ~350 补数行可一次性导入；日常增量 1～5 行 |
| C-4 上游 `auctioned` | `pagesize` 硬上限 250；日期/翻页参数全无效；只返回最新 N 条 | 每日增量只能取「最新窗口」 |
| C-5 上游 `search` | 无参数全量 >12.6 MB / 64 s 未传完；**但按月分段有效** | 禁止 Worker 调用；只允许离线脚本按月分段 |
| C-6 本机 | `wrangler dev` 不可用 | 验收靠纯函数单测 + `tsc` + `deploy --dry-run` + 远端 `d1 execute` |
| C-7 会话代理 | 不放行 `workers.dev` | HTTP 验收由用户浏览器确认；spec 不得声称「已自测通过」 |

### 0.2b 补充实测（v2 新增，`01` 为 FROZEN 不回改）

| 编号 | 事实 |
|---|---|
| F-32 | `search?format=json&startDate=2025-04-01&endDate=2025-05-01&dateFieldName=competitiveAuctionCloseDate` → **200 / 40 条 / 270,795 B / 2.35 s**，日期范围精确落在 `2025-04-01`～`2025-05-01`，187 字段 |
| F-33 | 同上但**不带** `dateFieldName` → 42 条，范围 `2025-03-26`～`2025-04-29`（有偏移）→ **补数必须显式带 `dateFieldName=competitiveAuctionCloseDate`** |
| F-34 | `auctioned?pagesize=250` → 250 条 / 1,707,406 B / 4.94 s，范围 `2025-05-08`～`2026-11-05` |
| F-35 | FiscalData `v1/accounting/od/auctions_query` 可用（1979 起），本期不采用，仅作备选源 |

### 0.3 架构总决议（R-0）

> **把「服务端算完吐整页 HTML」翻成「边缘只存规范化数据 + 浏览器算图」。**
> Worker 只做三件事：① 每日抓一小窗口并 upsert；② 按范围返回轻量规范化行；③ 分发静态页。
> 透视、堆叠、MA5/10/20/60/120、周/月分桶、locale 格式化**全部在浏览器**完成。
> **历史迁移与缺口补齐全部离线完成，产物是 SQL 文件，由 `wrangler d1 execute --remote` 灌入。**

---

## 1. 运行形态 `TB-01`

| To-Be | 理由 |
|---|---|
| 单 Worker（`daily-tracker`）+ 单 D1 库（`daily_tracker`）+ 1 个 Cron；`public/` 边缘直出 | 已有落点 F-30 |
| 目录：`docs/spec/`（本套规格）、`scripts/`（离线迁移/补数）、`data/`（生成物，不入库）、`src/`（Worker）、`public/`（前端）、`tests/`（纯函数 fixture） | 让新 Agent 用最小 token 理解项目 |
| `README.md` 指向 `docs/spec/` 并说明「规格是唯一事实源」；依赖由 `package.json` + lockfile 声明 | 修 DF-06 可复现性 |
| **不初始化 Git**（DOR-4）；`.gitignore` 预先排除 `.manual-key.txt` / `*.db` / `data/` / `*.exe` / `myenv/` / `.dev.vars` / `scripts/*.sql` | P-07：当前项目不是 git 仓库，`.manual-key.txt` 已存在 |

**AC-01**：`daily-tracker/` 根目录无 `.exe` / `.db` / 虚拟环境；`npm ci` 可重建依赖；**`.gitignore` 内容断言**（逐条包含上述 7 项）；`MANUAL_KEY` 已轮换且旧 key 作废。

## 2. 功能清单 → 接口契约 `TB-02`

所有响应统一 `{ ok: boolean, ... }`；错误 `{ ok:false, error:string }` + 非 2xx。**所有 SQL 用 prepared statement；所有列表/分析查询必须显式列白名单，禁止 `SELECT *`（P-06）；外部列名一律过白名单**（修 DF-03）。

| # | 方法 | 路径 | 契约 |
|---|---|---|---|
| TB-02.1 | GET | `/api/health` | `{ok, db, auctions, dataThrough, lastRun, lastSuccessAt, stale, notify, latencyMs, now}`；`stale = 距上次成功 > 36h` |
| TB-02.2 | GET | `/api/auctions` | 明细分页 `?from&to&type&limit(≤500)&cursor=<id>`；**游标用稳定 `id`，禁用 offset/行号**；`type` 白名单；返回显式列 |
| TB-02.3 | GET | `/api/analytics/rows` | **核心**。轻量行 `[{d,m,a,t}]` = `auction_date`/`term_months`/`offering_amount_usd`/`security_type`；`?from&to`；**默认区间取 `[dataThrough-5y, dataThrough]`**（不硬编码「今天」）；默认上限 **2000**，硬上限 5000 需分页（P-12） |
| TB-02.4 | GET | `/api/analytics/monthly` | `?field=auction_date\|issue_date\|announcement_date&year&month` → `{days[], current[], previous[], unit:'USD'}`；`field` 白名单，非法值 400。承接旧 `/get_data` + 孤儿页（修 DF-04） |
| TB-02.5 | POST | `/api/run` | 需 `x-manual-key`；手动补跑；`?window=N`（管理态，默认 20，上限 250）供漏跑多天时一次性补；返回 `{ok, written, skipped, failed}` |
| TB-02.6 | — | ~~DELETE~~ | **删除接口整体取消**（DOR-3）。前端无任何删除入口 |
| TB-02.7 | GET | `/` | 单页仪表盘，tabs：概览 / 堆积图 / 周对比 / 月内 / 明细 |
| — | — | ~~`/fetchmonthlydata`~~ | 孤儿页删除，功能并入 TB-02.4 + 月内 tab |

**写操作硬规定**：唯一写接口是 `POST /api/run`，一律要求 `x-manual-key`；未配置 secret 时返回 503，不降级为开放。

**AC-02（UNIT）**：`field=xxx; DROP TABLE auctions--` 返回 400 且表仍在；`type=BILL'; --` 返回 400；`cursor` 翻两页无重复无遗漏；`git grep -n "to_html\|render_template\|SELECT \*" src/` 无结果。
**AC-02（LIVE）**：用户在浏览器确认以上 3 个 HTTP 行为。

## 3. 数据模型 `TB-03`

### 3.1 设计决议

- **R-3a 分层**：`auctions` 只保留分析必需列；原始记录整条存 `raw_json`。新增字段读 `raw_json`，不必改表/重抓（修 DF-12）。**实施补充（v2.1）**：`raw_json` **仅对 `treasurydirect_api` 记录填充**；`legacy_sqlite` 行写 `NULL`——原始 77 列完整保存在 `usdebt.db`（SHA-256 已固定并登记），再往 D1 复制约 8 MB 没有回溯价值，只会撑大迁移 SQL。后续如需历史原始字段，从 `usdebt.db` 按 `(cusip, auction_date)` 回查即可。
- **R-3b 全英文**：列名、枚举、API 字段、日志一律英文；**不导入任何中文派生列**（修 DF-14、DF-10）。
- **R-3c 单位统一**：所有金额一律 **USD 绝对值**，列名带 `_usd`（修 DF-09）。
- **R-3d 日期统一**：一律 `YYYY-MM-DD` 字符串，UTC 语义；禁 `TIMESTAMP` 伪类型、`00:00:00` 后缀（修 DF-08）。
- **R-3e 唯一键**：`UNIQUE(cusip, auction_date, security_term)`（P-03）。历史归一化后三元组 `distinct = 4011`，与二元组相同，故迁移结果不变；加 `security_term` 是为了防止未来同码同日多场被静默覆盖。
- **R-3f 不动旧表**（P-05 的更优解）：**取消给 `runs` 加列**。`rows_written` / `kind` / `failed` 等以 JSON 存进既有 `detail TEXT` 列，`runs` 表结构原封不动。好处：零 `ALTER`、零迁移幂等风险、脚本可重复执行；代价仅是运行详情需解析 JSON，而它本来就是给人看的字符串。因此本期**不需要 `schema_migrations`**——`schema.sql` 全部是 `CREATE TABLE IF NOT EXISTS`，天然幂等。

### 3.2 规格 DDL（契约）

```sql
-- 规范化主表：一行 = 一场拍卖。全部 IF NOT EXISTS，可重复执行
CREATE TABLE IF NOT EXISTS auctions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  cusip               TEXT    NOT NULL,
  auction_date        TEXT    NOT NULL,   -- YYYY-MM-DD, UTC
  issue_date          TEXT,
  maturity_date       TEXT,
  announcement_date   TEXT,
  security_type       TEXT    NOT NULL,   -- BILL|NOTE|BOND|TIPS|FRN|CMB|UNKNOWN
  security_term       TEXT    NOT NULL DEFAULT '',
  term_months         INTEGER NOT NULL,   -- round((maturity-issue).days / 30.41667)
  offering_amount_usd REAL    NOT NULL,   -- USD 绝对值
  source              TEXT    NOT NULL,   -- legacy_sqlite | treasurydirect_api
  source_key          TEXT,
  raw_json            TEXT,               -- 保真，仅单条详情按需读取，禁止进列表查询
  imported_at         TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  UNIQUE (cusip, auction_date, security_term)
);
CREATE INDEX IF NOT EXISTS idx_auctions_date ON auctions (auction_date DESC);
CREATE INDEX IF NOT EXISTS idx_auctions_type ON auctions (security_type, auction_date DESC);

-- runs / metrics 沿用 v0 结构，不再新增列；runs.detail 存 JSON 详情
-- metrics 表保留但不再写入（legacy）
```

### 3.3 归一化规则表（唯一事实源，两份实现共用）

| 目标字段 | 历史库来源 | 新端点来源 | 变换 |
|---|---|---|---|
| `cusip` | `CUSIP` | `cusip` | trim / 大写 |
| `auction_date` | `AuctionDate` | `competitiveAuctionCloseDate`（兼容旧名 `auctionDate`） | `slice(0,10)` |
| `issue_date` | `IssueDate` | `issueDate` | `slice(0,10)` |
| `maturity_date` | `MaturityDate` | `maturityDate` | `slice(0,10)` |
| `announcement_date` | `AnnouncementDate` | `announcementDate` | `slice(0,10)` |
| `security_type` | `SecurityType` | `securityType` | 大写；未知→`UNKNOWN` |
| `security_term` | `SecurityTermWeekYear` | `securityTerm` | 大写 + `trim` + 去换行；`'1317\nWEEK'`→`'1317-WEEK'` 并标脏 |
| `term_months` | `久期(月数整数)` | 由 `issue_date`/`maturity_date` 现算 | **P-13 回退链**：现算 → 历史 `久期(月数整数)` → 解析 `security_term` → `0` + `dirty` |
| `offering_amount_usd` | `OfferingAmount` | `Number(offeringAmount)` | **P-04 单位判定**：历史列先 `assert max < 1000` 才乘 `1e9`，否则视为已是 USD 不换算；新接口已是 USD。有限数校验，`≤0` 标脏但保留 |
| `source` / `source_key` | `legacy_sqlite` / `url` | `treasurydirect_api` / `treasuryOfferingAnnouncementXmlFileName`（兼容 `xmlFilenameAnnouncement`） | — |

**AC-03（迁移后 SQL 断言）**：
1. `COUNT(*) = 4011`；`MIN/MAX(auction_date) = 2014-01-06 / 2025-04-10`
2. `CUSIP=912810UG1, 2025-04-10` → `offering_amount_usd = 22000000000`
3. `COUNT(*) WHERE auction_date LIKE '% %' = 0`；`PRAGMA table_info(auctions)` 无中文列名
4. `SUM(offering_amount_usd) = 去重后原 `SUM(OfferingAmount)` × 1e9`（P-04 总量断言）
5. `COUNT(DISTINCT cusip||'|'||auction_date||'|'||security_term) = COUNT(*)`（P-03）
6. `term_months` 无 NULL / 无负值 / 与历史列相关系数 > 0.99（P-13）
7. `COUNT(*) WHERE offering_amount_usd IS NULL = 0`

## 4. 抓取链路 `TB-04`

### 4.1 决议

- **R-4a 弃用两步法**：删除 `search → JSONP → 正则 "e4" → 逐条抓 XML` 整条链路，改 `auctioned?format=json` 一次拿 187 字段。XML 端点仅作 `source_key` 与回溯线索，不再请求。
- **R-4b 动态年份**：无硬编码年份；Cron 取「最新窗口」+ upsert 幂等（修 DF-01）。
- **R-4c 字段双读**：`auctionDate`/`competitiveAuctionCloseDate`、`xmlFilenameAnnouncement`/`treasuryOfferingAnnouncementXmlFileName`、`totalAccepted`/`grandTotalParAwarded` 新旧名都认（修 DF-02）。
- **R-4d 契约校验**：必填 `cusip`/`auction_date`/`offeringAmount`/`securityType`；单条缺失则跳过并计 `failed`；整批 >20% 失败 → 判上游改版，`status='failed'` + 告警，不静默写空。
- **R-4e 变更审计**（P-03）：upsert 时若 `offering_amount_usd` 与既有值不同，把差异写入 `runs.detail` JSON 的 `changed[]`。

### 4.2 每日增量规格（P-01）

```
DAILY_WINDOW = 20        // ≈1 周余量，响应 ~140KB；auctioned 只按最新返回
Cron 5 1 * * * (UTC 01:05)
  → GET auctioned?format=json&pagesize=20
  → normalizeAuction() × ≤20（双读 + 单位 + 枚举 + 日期）
  → INSERT ... ON CONFLICT(cusip, auction_date, security_term) DO UPDATE（幂等）
  → 写 runs(status, detail=JSON{written,skipped,failed,changed})
  → notify()（成功一行摘要；失败带原文）
```

- 漏跑超过一周：管理态 `POST /api/run?window=250`（显式、带 key、一次性），**不进 cron 默认路径**。
- 每次固定 1 Cron + 1 上游请求，不新增 R2/KV/DO。

**AC-04（UNIT）**：`git grep -n "e4\|jsonp\|jQuery36\|start_year\|2025" src/` 无结果；把 `competitiveAuctionCloseDate` 改回 `auctionDate` 的 fixture 产出相同 `auction_date`；必填缺失样本计入 `failed` 不写库；同日连续两次 `/api/run` 的 `COUNT(*)` 不变。
**AC-04b（LIVE，P-01）**：部署后 `wrangler tail` 实测 `cpuTimeMs < 10`、上游响应 `< 300 KB`；测不过继续降 `DAILY_WINDOW`，**不许改付费档**。`/api/analytics/rows` 默认请求同样满足该 CPU 门槛。

## 5. 派生计算 `TB-05`

| 原服务端计算 | To-Be 落点 | 规则 |
|---|---|---|
| `久期` / `久期(月数整数)` | 入库时算一次 `term_months` | 由归一化日期现算，不信任历史中文列 |
| `*星期` / `*月份` 中文串 | **删除，不落库** | 前端按 UTC + **ISO year** 现算，按 locale 格式化 |
| 透视表 / 堆叠 | 前端 | 按 `term_months` 分桶求和 |
| MA5/10/20/60/120 | 前端 | `rolling(window, min_periods=1)`，与 AS-05 语义一致 |
| 周对比 | 前端 | 默认「上一完整周 vs 再上一周」，UTC 周一～周日 |
| 日度重采样 | 前端 | 按 `auction_date` 分组求和，空缺日补 0 |

**删除中文列的两条理由**：① i18n；② **C-02 实测：12 行 ISO-year 错配**（`2014-12-29` 记作 `2014年第01周`，ISO 应为 `2015年第01周`），跨年周被透视表折叠进同一分组，是真实聚合错误。注意：补零的 `YYYY年第WW周` 字典序**等于**时间序，不会乱序——01 的 `DF-10` 措辞以本条为准。

**排序硬规定**：X 轴先按日期键（`YYYY-MM-DD` 或 `YYYY-Www`）升序，再格式化显示；禁止用格式化文案排序。

**AC-05（UNIT）**：`2014-12-29` → ISO year `2015`；`2024-W52` 排在 `2025-W01` 前；同一区间前端 MA5 与 pandas 容差内一致（抽样 1 个月）。

## 6. 前端 `TB-06`

- `public/index.html` + `public/app.js` + `public/styles.css` + `public/i18n/zh-CN.json`；无框架、无构建；Chart.js CDN。
- **P-14 零额外依赖**：不用时间轴，用**等距类目轴** + 日期键排序后格式化显示。
- Tabs：概览（`hello 强哥` + 健康卡）/ 堆积图 / 周对比 / 月内 / 明细。
- **P-09**：`hello 强哥` 是用户明示需求，登记为 i18n 字典条目 `greeting`（专名，不翻译），不视为硬编码泄漏。
- 所有用户可见文案走 `t(key)`；本期唯一字典 `zh-CN.json`；未来加 `en.json` 即可切换，无需改 DB/API。
- 无删除入口（DOR-3）。图表单位统一 `USD bn`（`offering_amount_usd / 1e9`）。
- 概览显示 `Data as of <dataThrough>`，与 `/api/health.dataThrough` 一致（P-02）。

**AC-06**：`git grep -n "堆积图\|年第\|发行星期" -- public/*.js public/*.html public/*.css` 无结果（**排除 `i18n/`，P-08**）；字典含 `greeting`；`?lang=en` 缺字典时回退 `zh-CN` 并输出明确日志，无中文硬编码泄漏。

## 7. 缺陷修复矩阵 `TB-07`

| 缺陷 | To-Be 决议 | 验收 |
|---|---|---|
| DF-01 硬编码 2025 | 最新窗口 + 幂等 upsert，无年份参数 | AC-04 |
| DF-02 上游改版 | 弃 search/JSONP/正则；`auctioned` + 字段双读 + 必填契约校验 + fixture | AC-04 |
| DF-03 注入 / RCE | 无模板渲染、无动态 SQL、列名白名单、写接口鉴权 | AC-02 |
| DF-04 孤儿页 | 删模板，功能并入 `/api/analytics/monthly` + 月内 tab | AC-02 |
| DF-05 删除按行号 | **删除功能整体取消**；列表用 `cursor` + 稳定 `id` | AC-02 |
| DF-06 大文件入库 | `.gitignore` 7 项 + lockfile；迁移输入不入库但记 SHA-256 与来源 URL | AC-01 |
| DF-07 主键缺失 | `UNIQUE(cusip, auction_date, security_term)` + 显式去重 | AC-03 |
| DF-08 日期混用 | 全表 `YYYY-MM-DD` | AC-03 |
| DF-09 单位混用 | 全表 `_usd` + 单位判定 assert | AC-03 |
| DF-10 ISO 周 | 不落中文列；前端按日期键排序 + ISO year | AC-05 |
| DF-11 脏值 | trim / 大写 / 去换行 / 有限数校验 / `≤0` 标脏保留 | AC-03 |
| DF-12 宽表 | 规范化列 + `raw_json` 分层 | AC-03 |
| DF-13 无观测 | `runs.detail` JSON + `health.stale` + **主动邮件告警** | TB-08 |
| DF-14 中文耦合 | 全英文 DB/API + UI 字典 | AC-06 |
| DF-15 19 个月缺口 | **DOR-1 离线按月补齐**，不再是可选项 | AC-09 |

## 8. 非功能规格 `TB-08`

| 主题 | 规格 |
|---|---|
| 安全 | SQL 全 prepared；外部输入只作「值」或「白名单映射后列名」；`MANUAL_KEY` 用 `wrangler secret` 并已轮换；无服务端模板渲染；**无任何删除接口** |
| 可观测 | `runs.detail` 存 JSON；`/api/health` 暴露 `lastSuccessAt`/`stale`/`notify`；失败通知带错误原文；**P-11 明确：`stale` 是被动的，不构成监控**，主动告警靠 DOR-2 的邮件 |
| 通知 | Resend `onboarding@resend.dev` → 账号注册邮箱；`NOTIFY_EMAIL` / `RESEND_API_KEY` 为 secret；未配置时返回 `notify:'skipped'` 并在日志标注，不静默 |
| 幂等 | Cron 与 `/api/run` 共用 `runOnce()`；`ON CONFLICT DO UPDATE`；重复执行不产生重复行 |
| 免费额度 | 每日 1 Cron + 1 上游请求（~140 KB）+ ≤5 行 D1 写；`/api/analytics/rows` 默认 ≤2000 行；**所有接口须满足 CPU < 10 ms**；不新增 R2/KV/DO |
| i18n | 见 TB-06；禁止中文进入 DB 列名、枚举、API 字段、日志 |
| 上游韧性 | 字段双读；必填契约；批量失败率 20% 阈值；fixture 随代码留存（不含密钥） |
| 环境 | 本机不跑 workerd；验收：`纯函数单测` → `tsc --noEmit` → `deploy --dry-run` → 远端 `d1 execute` 断言 → 用户浏览器 |

## 9. 迁移、补数与验收 `TB-09`

### 9.1 输入

- `usdebt.db`（工作区根，2,019,328 B），来源 `raw.githubusercontent.com/AlonsoZeng/usdebt/main/server/mydatabase.db`；**不入库**，`docs/spec/` 记 SHA-256 与 URL。
- 补数源：`search?format=json&startDate=&endDate=&dateFieldName=competitiveAuctionCloseDate`（F-32/F-33）。

### 9.2 离线脚本（一次性，可重复执行）

```
scripts/migrate_legacy.py   usdebt.db → 归一化 → 去重 → data/migration.sql
scripts/backfill.py         逐月拉 2025-04-11..今天 → 归一化 → data/backfill.sql
scripts/verify.py           对生成的 SQL 做迁移前断言（AC-03 的本地等价检查）
```

**migrate 步骤**
1. 读 `mytable` 4014 行；2. 归一化（含 `assert max(OfferingAmount) < 1000`）；3. 按 `(cusip, auction_date, security_term)` 去重，**预期恰好 3 组、每组 2 行且业务字段全同**，否则中止报告；4. 分批 INSERT（≤200 行/批），用 `ON CONFLICT DO UPDATE` 保证可重复执行。

**backfill 步骤**
1. 从 `2025-04-11` 到今天逐月构造 `[monthStart, nextMonthStart)` 区间，**必须带 `dateFieldName=competitiveAuctionCloseDate`**（F-33）；
2. 过滤：`competitiveAuctionCloseDate <= today` 且 `offeringAmount` 非空（排除未举行的 announced）；
3. 复用同一张归一化规则表（§3.3），`source='treasurydirect_api'`；
4. 生成 `data/backfill.sql`，同样 `ON CONFLICT DO UPDATE`。

**执行顺序**：`schema.sql` → `migration.sql` → `backfill.sql` → `verify.sql`（远端 SQL 断言）。

### 9.3 验收分层（P-10）

| 层 | 内容 | 执行方 |
|---|---|---|
| UNIT | 归一化、单位判定、去重、ISO 周、MA、白名单、fixture | 本地 `python -m unittest` / `node --test`，不依赖网络 |
| BUILD | `tsc --noEmit`、`wrangler deploy --dry-run` | 本地 |
| DATA | AC-03 全部 SQL 断言 + AC-09 | 远端 `wrangler d1 execute` |
| LIVE | AC-02 的 HTTP 行为、AC-04b 的 CPU 实 tail、页面渲染 | **用户浏览器**，因 C-7 不由本会话代为声明 |

**AC-09（P-02）**：`MAX(auction_date)` = `dataThrough`；堆积图最后一个非空桶日期 = `dataThrough`；`dataThrough` 与今天相差 ≤ 7 天（否则说明补数或 cron 失效）。

---

## 10. 状态与追溯

| 项 | 状态 |
|---|---|
| DOR-1～4 | ✅ 已收敛（§0.1b） |
| P-01～P-14 | ✅ 全部应用（见 v2 变更索引） |
| 03 的自我纠错 C-01～C-03 | ✅ 已并入（§5 / §4.1 / §0.2b） |
| 偏离说明 | P-05 采用**更优解**：取消 `ALTER TABLE`，改用既有 `detail` 列存 JSON，零迁移幂等风险 |
| **spec 状态** | **APPROVED v2 — 可进入实现** |

> 实现阶段产物（`src/` / `scripts/` / `public/` / `schema.sql`）必须与本文件编号对齐；任何偏离须先回改本文件，不得只改代码。

---

## 11. 实施期范围变更（2026-11-07）

| 编号 | 变更 | 决议 | 影响 |
|---|---|---|---|
| CHG-01 | DOR-2 通知渠道 | 由「本期交付」降级为**低优先级待办，本期不做** | `src/notify.ts` 与 `NOTIFY_EMAIL` 保留但不配 key；`/api/health.notify = "skipped"` 属预期值而非故障；失败留痕由 `runs.detail` 承担。**不新增、不放宽任何验收项** |
| CHG-02 | Git 与代码托管 | 初始化 git，主分支替换为重构版，旧版完整保留在 `legacy/v1` 分支及历史提交 | 不影响任何 AC；离线流水线所需的 `server/mydatabase.db` 从 `legacy/v1` 获取 |
| CHG-03 | Cron 验证口径 | 明确「库里有最新数据」来自离线补数，**不等于** cron 已验证 | `runs` 为空时 AC-04b / AC-09 的 LIVE 部分仍为待验证；DATA 层 ALL PASS 不得据此升级为全绿 |

**状态**：spec 保持 **APPROVED v2**。以上变更只收窄交付范围、澄清验收口径，未放宽任何验收条件。
