# 03 · Spec Adversarial Review（对抗性审查）

> **阶段**：Spec Adversarial Review｜**被审对象**：`02-to-be.md` DRAFT v1｜**事实基线**：`01-as-is.md` 的 `F-xx`
> **方法**：红队视角，假设实现者会**严格照抄 spec**、且不会替 spec 补漏；只接受可复验证据，不接受「应该没问题」。
> **结论**：**CONDITIONAL PASS** —— 2 项致命、5 项严重、7 项中等，另含 3 处审查者自我纠错。全部补丁应用后，spec 方可进入实现。

---

## 0. 裁决摘要

| 严重度 | 数量 | 处置 |
|---|---|---|
| P0 致命（照抄即失败/数据错） | 2 | P-01、P-02 |
| P1 严重（会静默错、返工或留攻击面） | 5 | P-03 ～ P-07 |
| P2 中等（自相矛盾、验收不可执行、脆弱） | 7 | P-08 ～ P-14 |
| 自我纠错（推翻本次会话早前断言 / 01 措辞） | 3 | C-01 ～ C-03 |

**最关键的一句**：`02` 自己在 §0.2 写下了 `C-1 Worker CPU 10 ms`，却在 `TB-04` 指定了 `pagesize=250`（1.7 MB JSON）——**规格违反了它自己的硬约束**。这类矛盾正是本阶段要抓的东西。

---

## 1. P0 · 致命项

### P-01 `pagesize=250` 必然打爆免费 Worker 的 CPU 与内存

- **攻击**：`TB-04.2` 要求 Cron 抓 `auctioned?format=json&pagesize=250`。实测该响应 **1,707,406 B**（`F-25`）。免费 Worker 是 `10 ms CPU / 128 MB`（`C-1`/`C-2`）。仅 `JSON.parse` 一个 1.7 MB 字符串通常就超过 10 ms，更不用说 250 条归一化 + 250 次 `prepare/bind` + 一次 `batch`。结果是 cron 每次执行都因 CPU 超限被掐断，`runs` 里天天是 `failed`，或更糟——静默写一半。
- **证据**：`F-25`（250 条 = 1.7 MB）、`F-26`（187 字段）、`C-1`。
- **影响**：每日任务 100% 失败；且 `02` 的 `AC-04` 完全没覆盖 CPU，所以测试也发现不了。
- **裁决**：**REJECT，必须改**。
- **补丁 P-01**：
  1. `TB-04.2` 的 `pagesize` 改为 **20**（约 140 KB），常量化 `DAILY_WINDOW = 20` 并注释理由：`auctioned` 只按最新返回，美国国债拍卖约 1～3 场/工作日，20 条≈一周余量，可容忍 cron 漏跑 1～2 天。
  2. 漏跑超过一周时，用管理态 `POST /api/run?window=250` 显式补，**一次性、带 key**，不进 cron 默认路径。
  3. 新增 `AC-04b`：部署后用 `wrangler tail` 实测 `cpuTimeMs < 10` 且响应体 `< 300 KB`；测不过就继续降 N，不许改付费档。
  4. `TB-08` 的「免费额度」行补上 CPU 预算这一列。

### P-02 19 个月数据缺口被降级成「可选决策」，但它是验收阻塞项

- **攻击**：`OPEN-01` 把 `2025-04-10` 到 `2026-11-07` 的缺口列为「候选方案，默认建议 ②」。而 `TB-02.3` 规定 `/api/analytics/rows` **默认最近 5 年**，`TB-06` 规定堆积图是首页核心。今天用户打开页面，5 年窗口的最后 19 个月是空的，图上一条断崖；Cron 从明天起每天只加 1 天。产品看起来就是坏的。这不是优化，是「默认视图不可用」。
- **证据**：`F-14`（止于 2025-04-10）、`F-27`（新端点窗口覆盖 2025-05-08 起）、`F-22`（2025 仅 124 行）。
- **影响**：核心功能首屏即失真；且 `OPEN` 状态意味着实现者可能直接跳过，验收时才发现要返工。
- **裁决**：**升级为 BLOCKER，不允许带着未知开工**。
- **补丁 P-02**：
  1. `OPEN-01` 从「决策待定」改为 **准入条件 DOR-1**：实现前必须选定并验证补数路径。
  2. 三条路径的**已核实可行性**必须写清：`auctioned` 硬上限 250（`F-25`）→ 单独不够；`search` 全量 >12.6 MB 且 64 s 未传完（`F-24`）→ 需分段时间参数或换源；FiscalData 官方 CSV/JSON（1979 至今）→ **本次尚未验证，必须实现前实测，不得假设可用**。
  3. 若用户选择「不补数」，则 `TB-02.3` 的默认区间必须改为「数据实际范围」，`/api/health` 增加 `dataThrough`，UI 明示 `Data as of YYYY-MM-DD`，禁止用「最近 5 年」制造空白断崖。
  4. 新增 `AC-09`：`MAX(auction_date)` 与 `dataThrough` 一致，且堆积图最后一个非空桶的日期 = `dataThrough`。

---

## 2. P1 · 严重项

### P-03 upsert 的冲突键可能静默覆盖一场拍卖

- **攻击**：`TB-03` 用 `UNIQUE(cusip, auction_date)` + `ON CONFLICT DO UPDATE`。历史数据里这确实唯一（实测归一化后 **4011 组**，三元组也是 4011 组），但 `F-26` 的样本显示新端点同时存在 `securityTerm=4-Week` 与 `originalSecurityTerm=17-Week`，说明存在 reopening / 转换场景。一旦上游出现同 CUSIP 同日两场（不同期限或类型），第二次写入会**覆盖第一行**，发行量被少算，且 `runs.status='ok'`，无人察觉。
- **证据**：`F-17`（1733 CUSIP / 4011 行）、`F-26`。
- **实测补充**：归一化后 `distinct(cusip,date)=4011`、`distinct(cusip,date,term)=4011` → **当前数据无冲突，属预防性风险，不是现存 bug**。
- **补丁 P-03**：唯一键改为 `UNIQUE(cusip, auction_date, security_term)`；upsert 时若 `offering_amount_usd` 与既有值不同，把差异写进 `runs.detail`（变更审计）；`AC-03` 增加断言 `COUNT(DISTINCT cusip||'|'||auction_date||'|'||COALESCE(security_term,'')) = COUNT(*)`。

### P-04 单位换算 ×1e9 缺「判定规则 + 中止条件」

- **攻击**：`TB-03.3` 对历史 `OfferingAmount` 一律乘 1e9。若某行本来已是美元绝对值，会放大 10⁹ 倍且图表毫无察觉。spec 没写判定依据，也没写越界怎么办。
- **实测补充**：全表 `min=0.025, max=95.0`，`>1000` 的行数 **0** → 当前数据可安全乘 1e9。
- **补丁 P-04**：把判定写成硬规则「历史列 `max < 1000` 才判定为十亿美元，否则视为已是 USD 不换算」；迁移脚本先执行 `assert max<1000`，不满足**中止并报告**；`AC-03` 增加总量断言 `SUM(offering_amount_usd) = 原 SUM(OfferingAmount) × 1e9`（在去重后的 4011 行上比对）。

### P-05 `ALTER TABLE runs ADD COLUMN` 不可重复执行

- **攻击**：`TB-03.2` 用 `ALTER TABLE ... ADD COLUMN` 给已上线的 `runs` 加列。SQLite 的 `ALTER TABLE ADD COLUMN` 不支持 `IF NOT EXISTS`，脚本重跑直接报错；而 `C-6` 说明本机无法用本地 D1 试跑，错误只会在远端暴露。
- **补丁 P-05**：改为版本化迁移：新建 `schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT)`，每个迁移脚本先查版本再执行，保证幂等；`schema.sql` 中 `runs` 的 CREATE 保留兼容旧结构，新增列由 v1 迁移负责。`AC-01` 增加「连续执行两次迁移脚本均返回 0」。

### P-06 `raw_json` 会被 `SELECT *` 拖进分析查询

- **攻击**：`TB-03` 加了 `raw_json` 保真，但 `TB-02.3` 只说「返回轻量行」，`AC-02` 也没禁止 `SELECT *`。实现者写 `SELECT * FROM auctions WHERE ...` 是完全合规的照抄，结果 200 KB 变十几 MB，直接撞 `C-1`。
- **补丁 P-06**：`TB-02` 增加硬规定「所有列表/分析查询必须显式列白名单，禁止 `SELECT *`；`raw_json` 仅由单条详情接口按需读取」；本期若不提供详情接口，则 `raw_json` 只在迁移时写入、永不读取。`AC-07`：`git grep -n "SELECT \*" src/` 无结果。

### P-07 静态口令 + 删除接口 + 尚未建立的 Git 忽略规则

- **攻击**：`TB-02.6` 保留 `DELETE /api/auctions/:id`，靠单一静态 `MANUAL_KEY` 保护。实测项目**当前不是 git 仓库**（`git rev-parse` 返回 fatal），现有 `.gitignore` 只忽略 `node_modules/ .wrangler/ dist/ .env .dev.vars *.log .DS_Store`——**没有 `.manual-key.txt`、没有 `*.db`、没有 `data/`**，而 `.manual-key.txt` 已真实存在于根目录。一旦按 `TB-01` 执行 `git init`，口令与 2 MB 迁移库会被一起提交。
- **证据**：本次 `git status` 实测；`F-30`（.manual-key.txt 已生成）。
- **补丁 P-07**：
  1. `AC-01` 修正：项目当前**不是** git 仓库，`git status --ignored` 无法执行；验收改为「`.gitignore` 内容断言」，且 `git init` 前必须先补齐忽略项。
  2. `.gitignore` 增加 `.manual-key.txt`、`*.db`、`data/`、`*.exe`、`myenv/`、`scripts/migration.sql`（含数据）。
  3. 轮换 `MANUAL_KEY`（`wrangler secret put`），旧 key 作废。
  4. `DELETE` 改为**软删除**（`deleted_at` 列 + 所有查询默认过滤）或按 `OPEN-03` 直接不做；`TB-02.6` 相应改写。

---

## 3. P2 · 中等项

| 编号 | 攻击 | 补丁 |
|---|---|---|
| P-08 | `AC-06` 写「`git grep ... public/` 无中文」，但字典 `public/i18n/zh-CN.json` 就在 `public/` 下且必然含「堆积图」→ **该验收永远无法通过** | grep 范围改为 `public/*.js public/*.html`，排除 `i18n/` |
| P-09 | `TB-06` 明确保留 `hello 强哥`（用户明示需求），却与 `AC-06`「无中文硬编码」冲突 | 把该串登记为 i18n 字典条目（专名，不翻译），既满足用户指令又满足字典化；`AC-06` 加「字典含该 key」 |
| P-10 | `C-7` 声明会话连不上 `workers.dev`，但 `AC-02`/`AC-04` 全是 HTTP 行为断言 → 自相矛盾且无法执行 | 验收分层：`UNIT`（纯函数，`node --test` 本地可跑：注入白名单、归一化、去重、派生、MA）与 `LIVE`（用户浏览器最小 smoke）。把 SQL 注入、单位、日期、ISO 周全部下沉为纯函数断言 |
| P-11 | `TB-08` 说通知未配置则「记日志」，免费版 Workers Logs 只留 3 天且无告警；`/api/health.stale` 是**被动**的，不打开页面就没人知道 | 明确写入「`stale` 不构成监控」；`OPEN-02` 不能默认「暂不配置」，须由用户明确接受无人值守风险，或配 Telegram（免费、零域名，且目标用户在海外） |
| P-12 | `TB-02.3` 上限 5000 行 + `TB-05` 前端算 MA，与 `C-1` 的 10 ms CPU 仍可能冲突；默认「最近 5 年」约 2000 行 | 默认上限改为 **2000**，硬上限 5000 需分页；`AC-04b` 一并覆盖该接口的 CPU 与响应体 |
| P-13 | `TB-05` 让 `term_months` 现算，但没写日期缺失时的回退 | 定义回退链：现算 → 历史 `久期(月数整数)` → 解析 `security_term` → `0` + `dirty` 标记。实测全表现算与历史列**差异 >1 月的行数 = 0**、日期不可解析 = 0，故属防御性；`AC-03` 增加「无 NULL / 无负值 / 与历史列相关系数 > 0.99」 |
| P-14 | `OPEN-04` 选 Chart.js，但混合图 + 时间轴需 `chartjs-adapter-date-fns` 额外依赖，与「零构建、CDN」目标冲突 | 明确「不使用时间轴，用等距类目轴 + 日期键排序后格式化显示」，零额外依赖；若确需时间轴则显式列入依赖清单 |

---

## 4. 审查者自我纠错（连自己的断言一起审）

| 编号 | 本次会话早前的断言 | 复验结果 | 更正 |
|---|---|---|---|
| C-01 | 「旧 `search` 端点已彻底死掉（HTTP 500）」 | 500 只由 `dateFieldName=auctionDate` 触发；换 `competitiveAuctionCloseDate` 或不带该参数均返回 200 | **端点没下线**，是旧查询字段名被拒绝。`01` 的 `F-23` 已按精确事实记录；对话中的表述以此更正 |
| C-02 | 「中文周/月标签作 X 轴是字典序，跨年会乱序」 | 实测 `YYYY年第WW周` / `YYYY年第MM月` 为补零格式，**字典序 == 时间序**，不会乱序 | `01` 的 `DF-10` 措辞不准确（该文件 FROZEN 不修改，以本条为准）。**真实缺陷是 12 行 ISO-year 错配**：如 `2014-12-29` 被标为 `2014年第01周`（ISO 应为 `2015年第01周`），导致 12 月底与 1 月初的「第 01 周」被透视表**折叠进同一分组**，是聚合错误而非排序错误 |
| C-03 | 「77 列里有 10 个中文派生字段」 | 实际是 **8 个中文派生列 + 2 个英文后加列**（`TINTCUSIP1DueDate` / `TINTCUSIP2DueDate`） | `01` 的 `F-15` 已按实测记录；对话表述以此更正 |

> C-02 的修正反而**加强**了 `TB-05` 删除中文派生列的理由：不只是 i18n，还有真实的跨年周聚合错误。

---

## 5. 对 `02-to-be.md` 的净变更清单（应用后为 DRAFT v2）

| 章节 | 变更 |
|---|---|
| §0.2 / TB-08 | 补 CPU 预算列为强制项；`C-1` 与 TB-04 不得再矛盾 |
| §0.3 / TB-04 | `pagesize 250 → 20`，常量化，管理态 `?window=` 补跑；新增 `AC-04b` |
| TB-02.3 | 默认上限 5000 → 2000；显式列白名单、禁 `SELECT *`；新增 `dataThrough` |
| TB-02.6 | DELETE 改软删除或删除该接口（依 OPEN-03） |
| TB-03.2 | 唯一键加 `security_term`；`runs` 改版本化迁移；新增 `AC-07` |
| TB-03.3 | 单位判定 + assert；`term_months` 回退链；变更审计 |
| TB-05 | 补 ISO 周折叠错误为删除中文列的第二条理由 |
| TB-06 | `hello 强哥` 字典化；Chart.js 用等距类目轴 |
| TB-08 | 明确 `stale` 非监控；通知策略不得默认「无」 |
| TB-09 / AC-01 | 修正「已是 git 仓库」的错误前提；补 `.gitignore` 项与 key 轮换 |
| AC-02 / AC-04 / AC-06 | 验收分层 UNIT / LIVE；修正两处自相矛盾的 grep 断言 |
| §10 | `OPEN-01` 升级为 DOR-1；`OPEN-02` 需用户明确接受风险；`OPEN-03` 与软删除决议合并 |

---

## 6. 修订后状态与实现准入（Definition of Ready）

**状态：`CONDITIONAL PASS`**。补丁全部应用、`02` 升到 v2 后，spec 可进入实现。**但在动代码之前，以下 4 条必须收敛：**

| 编号 | 必须收敛的事 | 为什么不能替用户决定 |
|---|---|---|
| DOR-1 | **19 个月缺口怎么补**（全量离线补 / 只补最近 / 明确不补并改默认区间） | 影响默认视图是否可用，且涉及一次性大响应处理；选「补」需先实测 FiscalData 或 `search` 分段参数 |
| DOR-2 | **通知渠道**（Telegram / 邮件 / 明确接受无人值守） | 「暂不配置」意味着 cron 连续失败无人知晓，这是风险接受，不是技术默认值 |
| DOR-3 | **删除功能去留**（软删除 / 本期不做） | 公开站点是否保留写接口的取舍，属产品决策 |
| DOR-4 | **是否现在初始化 Git 仓库** | 当前不是 git 仓库；`git init` 前必须先补 `.gitignore` 并轮换 `MANUAL_KEY`，否则口令入库 |

**范围澄清**：本阶段「不写实现」指不产出 `.ts` / `.js` / `.html` / 可执行 `.sql`。`docs/spec/*.md` 是用户要求的交付物，不受此限。

---

## 7. 三阶段收口

| 阶段 | 产出 | 状态 |
|---|---|---|
| Code → Spec | `01-as-is.md`：9 组 `AS-xx`、31 条 `F-xx`、15 项 `DF-xx` | FROZEN |
| Spec → Spec | `02-to-be.md`：9 组 `TB-xx`、9 条 `AC-xx`、4 项 `OPEN-xx` | DRAFT v1，待应用补丁升 v2 |
| Adversarial Review | 本文件：2 P0 / 5 P1 / 7 P2 / 3 自我纠错 / 4 DOR | CONDITIONAL PASS |

## 8. DOR 收敛与补丁落地（2026-11-07 追加）

用户回复「听你推荐」，授权代为拍板。四条决议及理由见 `02-to-be.md` §0.1b，此处只记录**审查视角的复核**：

| DOR | 决议 | 审查复核 |
|---|---|---|
| DOR-1 | 离线按月补 19 个月缺口 | **通过**。实现前补做上游实测，确认 `search` 分段有效（`F-32`），并发现 `dateFieldName` 不可省略（`F-33`）——若省略会偏移约 6 天，属会静默污染数据的坑，已写进 `02` §9.2 硬规定 |
| DOR-2 | Resend 邮件到账号注册邮箱 | **通过**。修正了 v1「暂不配置」的默认，回应 P-11：告警接收者是国内的强哥本人，Telegram 不可达；`onboarding@resend.dev` 免域名且只能发注册邮箱，与自用告警场景恰好吻合 |
| DOR-3 | 删除功能整体取消 | **通过**。比 P-07 建议的「软删除」更彻底：公开上游数据无人工删除需求，取消接口后静态 key 的爆炸半径只剩 `/api/run` |
| DOR-4 | 暂不 `git init`，先补 `.gitignore` 并轮换 key | **通过**。实测项目确实不是 git 仓库，风险是「未来初始化时」才触发，预防性修复足够，无需现在引入 git 概念 |

**补丁实施的两点说明**：
1. P-05 采用了**偏离审查建议的更优解**：不给 `runs` 加列，改用既有 `detail TEXT` 存 JSON。这样 `schema.sql` 全是 `CREATE TABLE IF NOT EXISTS`，天然幂等，连 `schema_migrations` 都不需要。已记录进 `02` §3.1 R-3f 与 §10 偏离说明。
2. P-01 的 `DAILY_WINDOW=20` 增加管理态 `?window=` 逃生口，避免「漏跑超过一周却无法补」的新故障模式。

**最终状态**：`01` FROZEN → `02` **APPROVED v2** → `03` **CLOSED（全部补丁已应用）**。准入条件 DOR-1～4 全部满足，可进入实现。

## 9. 实施验收记录（2026-11-07 追加）

| 验收层 | 结果 |
|---|---|
| UNIT | ✅ `npm test` 22/22（归一化、字段双读、单位判定、ISO 周、MA、SQL 白名单、CPU 窗口常量） |
| BUILD | ✅ `tsc --noEmit`；`deploy --dry-run` 20.45 KiB / gzip 6.01 KiB，D1 绑定正确 |
| DATA | ✅ `npm run db:verify` **ALL PASS**：4698 行（4011 legacy + 687 backfill）、`dataThrough=2026-11-05`、落后 2 天、`duplicate_keys=0`、`sample_amount_usd=22000000000` |
| DEPLOY | ✅ 版本 `c9681811-07af-4da6-bac7-fea29956ba7e`，5 个静态资源，Cron `5 1 * * *` 已注册，启动 2 ms |
| LIVE | ⏳ **未完成**：会话网络对 `workers.dev` 直连返回 000、独立通道也失败（C-7），页面渲染与 AC-04b 的 CPU 实 tail 必须由用户浏览器/次日 cron 确认 |

**实施中发现并修掉的 4 个问题**（均不影响规格契约，属实现层）：
1. `Number(null) === 0` 被当成合法 `term_months` 回退值，导致 `security_term` 解析永远走不到 → 已修 + 单测覆盖。
2. `wrangler d1 execute --file` 单条 INSERT 塞 100 行带 `raw_json` 触发 `SQLITE_TOOBIG` → `BATCH_SIZE` 降到 10，单条上限 54 KB。
3. D1 对 `UNION ALL` 的 compound term 数限制比标准 SQLite 严 → 验收 SQL 改为单条标量子查询。
4. `--file` 模式只回摘要、拿不到 SELECT 数值 → `scripts/verify.mjs` 改走 `--command --json` 并做真实断言；Windows 上直接执行 `wrangler/bin/wrangler.js` 以避开 `npx.cmd` 的 EINVAL。

**规格偏离（已回改 02）**：历史行 `raw_json` 写 NULL，理由见 `02` §3.1 R-3a 的 v2.1 补充——原始 77 列完整保存在 `usdebt.db`（SHA-256 固定），无需在 D1 复制约 8 MB。

**未完成的两项，明确不冒充通过**：
- **DOR-2 告警未生效**：`NOTIFY_EMAIL` 已设，但 `RESEND_API_KEY` 需用户到 resend.com 自行注册获取（无法代注册）。代码与备用 webhook 通道均已就位。
- **AC-04b CPU 实测**：需 `wrangler tail` 观察次日 cron 或用户手动触发 `/api/run`；会话网络无法调用该地址。

> **下一步**：由用户完成 LIVE 验收与 Resend key 配置。
