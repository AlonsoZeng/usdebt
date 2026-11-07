# 01 · Code → Spec（As-Is 规格）

> **阶段**：Code → Spec｜**状态**：FROZEN（只读，不得修改）
> **对象**：`github.com/AlonsoZeng/usdebt`（去年模型生成，无 README）+ 已上线的 `daily-tracker` 骨架
> **纪律**：本文件只回答「现有系统**实际**做了什么」。**不评价、不设计、不提改进**。所有改进意见属于 `02-to-be.md`，所有质疑属于 `03-adversarial-review.md`。
> **证据等级**：`[SRC]` 源码直读｜`[DB]` 数据库实测｜`[NET]` 上游 HTTP 实测（2026-11-07）｜`[DOC]` 官方文档/第三方资料

---

## 0. 阅读约定

- 条目编号 `AS-xx` 与 `02-to-be.md` 的 `TB-xx` **一一对应**，用于逐条核对变更。
- 缺陷编号 `DF-xx` 是缺陷登记，不在此处给修复方案。
- 事实编号 `F-xx` 是可复验的原子事实，`02` / `03` 引用它们，不再重复论证。

### 已核实事实清单（F）

| 编号 | 事实 | 证据 |
|---|---|---|
| F-01 | 仓库根目录无 README、无 `requirements.txt`、无 `.gitignore`；`.gitattributes` 仅 `* text=auto` | `[SRC]` 目录列举 |
| F-02 | 根目录含 `chromedriver.exe`(16,975,360 B)、`LICENSE.chromedriver`(412,180 B)、`yield_curve_data.xlsx`(22,635 B)、`WTREGEN.csv`(10,921 B)、`cdyieldcurve.py`(2,575 B)、`server/` | `[SRC]` |
| F-03 | `server/` 含 `app.py`(27,876 B)、`mydatabase.db`(2,019,328 B)、`myenv/`（虚拟环境目录）、`templates/`（4 个 HTML） | `[SRC]` |
| F-04 | `app.py` 为单文件 Flask，`app.run(debug=True)` 位于文件末尾 | `[SRC]` |
| F-05 | 路由共 6 个：`/` GET、`/update-data` POST、`/graphdata` GET/POST、`/compare` GET/POST、`/get_data` POST、`/delete-record/<int:record_id>` POST | `[SRC]` |
| F-06 | 仓库中不存在 `/fetchmonthlydata` 路由 | `[SRC]` 全文件搜索 |
| F-07 | `fetchmonthlydata.html` POST 到 `/fetchmonthlydata`，期望响应是可 `map(item => item.date / item.total)` 的数组；`/get_data` 实际返回 `{days, current_year:{year,values}, last_year:{...}}` | `[SRC]` |
| F-08 | `/update-data` 硬编码 `start_year = end_year = 2025` | `[SRC]` |
| F-09 | `/update-data` 请求 `search?...&dateFieldName=auctionDate&format=jsonp&callback=jQuery36005594183916060127_1711782451828&pagesize=500&recordendindex=20`；用固定长度切片剥 JSONP；正则 `"e4":"(.*?)"` 抠文件名；拼 `/xml/` 前缀 | `[SRC]` |
| F-10 | 建表语句 `CREATE TABLE IF NOT EXISTS mytable (url TEXT PRIMARY KEY)`；先插 url，再 `SELECT rowid,url WHERE CUSIP IS NULL` 逐条抓 XML，`parse_xml` 平铺 tag 为 dict，按列名动态 UPDATE；最后 `process_date_fields` 全表重算派生列 | `[SRC]` |
| F-11 | `/get_data` 把 `request.json['purpose']` 直接 f-string 拼进 SQL 两处：`SELECT {purpose}, OfferingAmount ... WHERE strftime('%Y', {purpose}) = ?` | `[SRC]` |
| F-12 | `/graphdata` 的 `x_field` 来自 `request.form`，用于 `pivot_table(index=x_field)`；`fetch_data(order_by=...)` 可拼 SQL（当前调用方均传默认值）；`/compare` 的 `date_field` 来自表单用于 pandas 列索引 | `[SRC]` |
| F-13 | `index.html:372` 为 `onclick="confirmDelete('{{ index + 1 }}')"`；后端把 `record_id - 1` 当作 `fetch_data()`（默认 `ORDER BY url DESC` 全表）的 `iloc` 行号，取 `all_data.columns[0]`（即 `url`）作「主键」执行 `DELETE ... WHERE url = ?` | `[SRC]` |
| F-14 | `mytable` **4014 行 × 77 列**；`AuctionDate` 跨度 `2014-01-06` ～ `2025-04-10` | `[DB]` |
| F-15 | 77 列 = 上游原生 67 列（idx 0–66）+ 后加 10 列（idx 67–76）：`到期星期`、`到期月份`、`久期`、`久期(月数整数)`、`拍卖星期`、`拍卖月份`、`发行星期`、`发行月份`（8 个中文列）+ `TINTCUSIP1DueDate`、`TINTCUSIP2DueDate`（2 个英文列） | `[DB]` PRAGMA |
| F-16 | 日期格式混用：`AuctionDate` / `IssueDate` / `MaturityDate` 各 3994 行为 `YYYY-MM-DD 00:00:00`、20 行为 `YYYY-MM-DD`；`AnnouncementDate` 全 4014 行为 `YYYY-MM-DD` | `[DB]` |
| F-17 | `count(distinct CUSIP) = 1733`（增发债同码多场）；`count(distinct url) = 4011`（3 组重复）；`(CUSIP, AuctionDate)` 按**原始字符串**分组 4014 组无冲突 | `[DB]` |
| F-18 | 3 组重复 url 的成对行：CUSIP、`SecurityType`、`SecurityTermWeekYear`、`OfferingAmount` 全同，仅 `AuctionDate` 一个为 `2025-02-19`、另一个为 `2025-02-19 00:00:00` → **日期归一化后这 3 组会冲突，真实唯一记录为 4011 条** | `[DB]` |
| F-19 | `OfferingAmount` 范围 `0.025` ～ `95.0`、均值 `40.89`（单位：十亿美元）；同表 `MatureSecurityAmount` / `NetLongPositionReport` 等为美元绝对值（如 `78,243,000,000`）→ 同表单位混用 | `[DB]` |
| F-20 | 派生规则实测：`久期 = (MaturityDate - IssueDate).days`；`久期(月数整数) = round(days / 30.41667)`；星期 = `f"{date.year}年第{date.isocalendar()[1]:02d}周"`；月份 = `f"{date.year}年第{month:02d}月"` | `[SRC]` + `[DB]` 抽样复算一致 |
| F-21 | 脏值：`SecurityTermWeekYear` 存在 `'0-WEEK'`、`'1317\nWEEK'`（含换行符）；`OfferingAmount = 0.025` 至少 8 行；`OfferingAmount` / `SecurityType` / 全部派生列非空 | `[DB]` |
| F-22 | 年份行数：2014:269 / 2015:272 / 2016:266 / 2017:277 / 2018:284 / 2019:325 / 2020:500 / 2021:445 / 2022:384 / 2023:428 / 2024:440 / 2025:124（截至 4 月） | `[DB]` |
| F-23 | `/TA_WS/securities/search` 带 `dateFieldName=auctionDate` → **HTTP 500**；换 `competitiveAuctionCloseDate` 或不带该参数 → HTTP 200 | `[NET]` |
| F-24 | 无参数 `search?format=json` 传输 12,635,480 B 后 curl 以 exit 56 中断（64.3 s），JSON 不完整 | `[NET]` |
| F-25 | `/TA_WS/securities/auctioned?format=json&pagesize=N` → 200，返回**最新 N 条**（`pagesize=500`/`5000` 均只返回 250 条，硬上限 250）；`startDate`/`endDate`/`page`/`pagenum`/`offset`/`start` 参数**全部无效** | `[NET]` |
| F-26 | 新端点每条 **187 字段**，含 `competitiveAuctionCloseDate`(ISO datetime)、`cusip`、`securityType`=`Bill`、`securityTerm`=`4-Week`、`offeringAmount`=`"115000000000"`（**美元绝对值**）、`issueDate`、`maturityDate`、`treasuryOfferingAnnouncementXmlFileName`、`bidToCoverRatio`、`highRate`、各类 bidder 分类等；无 `auctionDate`、无 `xmlFilenameAnnouncement` | `[NET]` |
| F-27 | `auctioned` 的 250 条窗口日期范围 `2025-05-08` ～ `2026-11-05`；`/TA_WS/securities/announced?format=json&pagesize=2` → 200，返回未来拍卖 `2026-11-09` | `[NET]` |
| F-28 | `/xml/A_20250403_2.xml` → 200，`AuctionData` 根节点，53 个非空 tag，**不含拍卖结果类字段**（highRate / bidToCover 等） | `[NET]` |
| F-29 | 官方 2026-10 改版重命名：`auctionDate→competitiveAuctionCloseDate`、`totalAccepted→grandTotalParAwarded`、`xmlFilenameAnnouncement→treasuryOfferingAnnouncementXmlFileName` 等；官方 auction-query 页标注「Additional data fields ... October 2026」 | `[DOC]` |
| F-30 | 现有 `daily-tracker`：单 Worker 分发 `public/` + `/api/{health,metrics,run}` + cron `5 1 * * *`；D1 `daily_tracker`（`80d7ee7d-a4d3-4e91-a7d9-3d056f07a13c`，洛杉矶）；表 `metrics(source,day,value,raw)` + `runs`；已部署 `daily-tracker.alonsozeng.workers.dev`；`MANUAL_KEY` 已设；`fetchUpstream()` 返回 `[]`；通知未配置 | `[SRC]` + 会话记录 |
| F-31 | 本机 workerd 栈溢出崩溃，`wrangler dev` / 本地 D1 不可用；开发循环为 `改代码 → wrangler deploy → 刷新`；会话代理不放行 `workers.dev`，HTTP 自测须用户在浏览器完成 | 会话记录 |

---

## 1. 系统边界与运行形态 `AS-01`

- 单机 **Flask 应用**，进程常驻，`python app.py` 启动，监听本机 5000（默认）。`[SRC]`
- 数据库为**进程旁的文件** `server/mydatabase.db`，`sqlite3.connect()` 直连，每请求开关连接。`[SRC]`
- 服务端用 pandas 做透视/重采样，用 Plotly 生成**整页 HTML**（`fig.to_html(full_html=True)`）后由 Jinja 模板返回。`[SRC]`
- 前端通过 Bootstrap/jQuery/Chart.js CDN，无构建步骤。`[SRC]`
- 无鉴权、无用户概念、无部署配置、无环境变量、无日志落盘。`[SRC]`
- 非目标（同仓库但**不在本次复刻范围**，用户已确认）：`cdyieldcurve.py`（中债收益率曲线）、`WTREGEN.csv`（FRED TGA 周均值，代码中无引用）、`yield_curve_data.xlsx`、`chromedriver.exe`、`LICENSE.chromedriver`。`[SRC]`

> 附：已上线的 `daily-tracker` 是另一套形态（Cloudflare Worker + D1 + Cron），见 `AS-09`。本次重构的落点是它，不是 Flask。

## 2. 功能清单 `AS-02`

| # | 路由 | 方法 | 行为 | 证据 |
|---|---|---|---|---|
| AS-02.1 | `/` | GET | 分页明细表（`page`、`per_page` 默认 20），按 `url DESC` 排序，输出 `data.to_html()` 整表 | `[SRC]` |
| AS-02.2 | `/update-data` | POST | 两步抓数：① 查新 XML 地址并去重入库 ② 逐条抓 XML 回填 + 全表重算派生列；把 `stdout` 捕获进 JSON `details` 返回 | `[SRC]` |
| AS-02.3 | `/graphdata` | GET/POST | **核心**。X 轴默认 `发行星期`，按 `久期(月数整数)` 堆叠 `OfferingAmount`；叠加 MA5/10/20/60/120；支持最近 N 年（默认 5）/ 自定义日期区间 / 切换 X 轴列；日期过滤固定用 `AnnouncementDate` | `[SRC]` |
| AS-02.4 | `/compare` | GET/POST | 默认「上周 vs 上上周」（按周一～周五），按久期桶堆叠对比两组发行量；`date_field` 由表单指定 | `[SRC]` |
| AS-02.5 | `/get_data` | POST | 指定 `{purpose, year, month}` → 该月按日 `resample('D').sum()` + 去年同月，返回 `{days, current_year, last_year}` | `[SRC]` |
| AS-02.6 | `/delete-record/<id>` | POST | 见 `AS-06` / `DF-05` | `[SRC]` |
| AS-02.7 | `fetchmonthlydata.html` | — | 无对应路由的独立模板，见 `DF-04` | `[SRC]` |

## 3. 数据模型 `AS-03`

- 单表 `mytable`，**无显式主键约束**（`CREATE TABLE IF NOT EXISTS (url TEXT PRIMARY KEY)` 仅在表不存在时生效；已存在的库是 `rowid` 表）。`[SRC]`
- 77 列构成见 `F-15`。字段命名分三套风格：`PascalCase`（上游 XML tag）、`中文`（派生）、`全大写英文`（TINTCUSIP*）。`[DB]`
- 数据类型：日期列声明 `TIMESTAMP` 但实际存字符串；金额列 `REAL`；其余 `TEXT`。`[DB]`
- 关键列：`url`、`CUSIP`、`SecurityType`、`SecurityTermWeekYear`、`AnnouncementDate`、`AuctionDate`、`IssueDate`、`MaturityDate`、`OfferingAmount`、`久期(月数整数)`。`[DB]`
- 无索引、无外键、无 `created_at` / `updated_at`、无数据来源标记。`[DB]`

## 4. 数据链路 `AS-04`

```
[POST /update-data]
  ① GET search?...dateFieldName=auctionDate&format=jsonp&callback=<固定串>
        → 剥 JSONP（按 callback 长度硬切）→ 正则 "e4":"..." → 拼 /xml/ 前缀
        → CREATE TABLE IF NOT EXISTS mytable(url TEXT PRIMARY KEY)
        → 与现有 url 列表做集合差 → 逐条 INSERT 仅 url 的占位行
  ② SELECT rowid,url WHERE CUSIP IS NULL
        → 每条 GET /xml/<file>（3 次重试，间隔 2s，timeout 30s）
        → ET.fromstring 平铺所有 tag → 按列名交集动态 UPDATE ... WHERE rowid = ?
  ③ SELECT 全表 → 逐行 pd.to_datetime → 重算 8 个中文派生列 → UPDATE
```
`[SRC]`

- 去重键是 `url`（`F-17` 证明它并不唯一）。`[SRC]`+`[DB]`
- 日期字段异常时回退 `1900-01-01`，派生列照算不误。`[SRC]`
- 抓取范围由硬编码年份决定（`F-08`）。`[SRC]`

## 5. 派生计算 `AS-05`

| 输出 | 计算 | 载体 | 证据 |
|---|---|---|---|
| `久期` | `(MaturityDate - IssueDate).days` | 服务端 Python，落库 | `[SRC]` |
| `久期(月数整数)` | `round(days / 30.41667)` | 服务端 Python，落库 | `[SRC]` |
| `*星期` | `f"{date.year}年第{ISO week:02d}周"` | 服务端 Python，落库为中文字符串 | `[SRC]` |
| `*月份` | `f"{date.year}年第{month:02d}月"` | 服务端 Python，落库为中文字符串 | `[SRC]` |
| 透视表 | `pivot_table(index=x_field, columns=久期(月数整数), values=OfferingAmount, aggfunc=sum, fill_value=0)` | 服务端 pandas | `[SRC]` |
| 均线 | `rolling(window∈{5,10,20,60,120}, min_periods=1).mean()` | 服务端 pandas | `[SRC]` |
| 日度汇总 | `resample('D').sum()` | 服务端 pandas | `[SRC]` |

## 6. 前端渲染 `AS-06`

- 4 个 Jinja 模板：`index.html`(22,760 B)、`graph.html`(25,096 B)、`compare.html`(9,462 B)、`fetchmonthlydata.html`(4,542 B)。`[SRC]`
- 交互均为**整页表单提交或整页跳转**，仅 `/get_data` 与删除是 `fetch()` 局部调用。`[SRC]`
- 明细表的删除按钮传 `{{ index + 1 }}`（当前页序号），见 `F-13`。`[SRC]`
- 图表为 Plotly 生成的完整 HTML 字符串注入模板。`[SRC]`
- 界面文案全中文（「债券数据分析平台」「堆积图」等），字段名与轴标签直接复用数据库中文列名。`[SRC]`

## 7. 缺陷登记 `AS-07`（只登记，不给方案）

| 编号 | 缺陷 | 用户是否点名 | 证据 |
|---|---|---|---|
| DF-01 | `start_year = end_year = 2025` 硬编码，2026 年无法抓新数据 | ✅ 六个问题之一 | F-08 / F-22 |
| DF-02 | 上游 2026-10 改版：`dateFieldName=auctionDate` 直接 500；JSONP 固定长度切片 + 正则 `"e4"` 依赖响应内部格式 | ✅ 六个问题之一 | F-09 / F-23 / F-29 |
| DF-03 | `/get_data` 的 `purpose` 直拼 SQL（注入）；`app.run(debug=True)` 公网即 RCE | ✅ 六个问题之一 | F-11 / F-04 |
| DF-04 | `fetchmonthlydata.html` 是孤儿页：无路由、且响应契约与 `/get_data` 不兼容 | ✅ 六个问题之一 | F-06 / F-07 |
| DF-05 | 删除按「当前页行号」定位，且以非唯一 `url` 作删除条件（可一次删多行、可删错页） | ✅ 六个问题之一 | F-13 / F-17 |
| DF-06 | 二进制与虚拟环境入库：`chromedriver.exe` 16.9 MB、2 MB db、412 KB LICENSE、`myenv/`；无 `.gitignore`、无依赖清单 | ✅ 六个问题之一 | F-01 / F-02 / F-03 |
| DF-07 | 主键缺失：无唯一约束；`url` 有 3 组重复；按字符串 `(CUSIP, AuctionDate)` 的「唯一」是日期格式不一致造成的假象 | 新增 | F-17 / F-18 |
| DF-08 | 日期格式混用（3994 行带 `00:00:00` / 20 行不带），字符串比较与 `strftime` 行为不一致 | 新增 | F-16 |
| DF-09 | 单位混用：`OfferingAmount` 为十亿美元、其余金额为美元绝对值 | 新增 | F-19 |
| DF-10 | 中文派生列用 calendar year 配 ISO week（跨年周错配）；以 `"2025年第04月"` 字符串作 X 轴，排序为字典序而非时间序 | 新增 | F-20 |
| DF-11 | 脏值未处理：`'0-WEEK'`、`'1317\nWEEK'`、`OfferingAmount=0.025` | 新增 | F-21 |
| DF-12 | 77 列宽表全量落库、无来源标记、无审计字段；新增字段需改表 + 全表重算 | 新增 | F-15 / F-10 |
| DF-13 | 无可观测性：无成功/失败记录、无告警；`stdout` 被捕获进 HTTP 响应 | 新增 | F-04 / F-10 |
| DF-14 | 界面与数据模型深度耦合中文，无法多语言化 | 新增 | F-15 / AS-06 |
| DF-15 | 历史数据止于 2025-04-10，与当前日期之间存在约 19 个月缺口 | 新增 | F-14 / F-27 |

## 8. 环境与上游现状 `AS-08`

- **仍可用**：`/xml/<file>`（200，53 tag）、`auctioned?format=json&pagesize=N`（200，187 字段，硬上限 250）、`announced?format=json`（200，未来拍卖）、`search?format=json` 不带失效参数（200，但 >12.6 MB / 64 s 未传完）。`[NET]` F-23~F-28
- **不可用**：`search?...&dateFieldName=auctionDate`（500）。`[NET]`
- **无效参数**：`auctioned` 的 `startDate`/`endDate`/`page`/`pagenum`/`offset`/`start`；`pagesize > 250` 被截断。`[NET]`
- **字段/单位/枚举不一致**：新端点 `Bill`/`4-Week`/美元绝对值/`ISO datetime` vs 历史库 `BILL`/`4-WEEK`/十亿美元/混合字符串。`[NET]`+`[DB]`

## 9. 现有落点（daily-tracker）`AS-09`

- 单 Worker 同时分发 `public/` 静态资源与 `/api/*`；静态资源由边缘直出，不消耗 Worker 额度。`[SRC]` F-30
- `metrics(source, day, value, raw)` 一维模型 + `runs` 运行记录；`runOnce()` 可被 cron 与 `POST /api/run` 共同调用；写库 `ON CONFLICT DO UPDATE` 幂等；失败推通知；`fetchUpstream()` 是空占位。`[SRC]`
- 免费额度上下文：Workers 10 万请求/天、**CPU 10 ms/次**、内存 128 MB；D1 单库 500 MB / 5 GB 总量、读 500 万行/天、写 10 万行/天；Cron 最小 1 分钟、免费 5 个。会话记录
- 本机 `wrangler dev` 不可用，验证靠 `wrangler deploy --dry-run` / `tsc --noEmit` / 远端 `d1 execute` / 用户浏览器。`[SRC]` F-31

---

## 10. As-Is 阶段结论

1. 可复刻的业务内核是 **`AS-02.3` 堆积图 + 均线**，其余表格/对比/月内页是周边。
2. 现有抓数链路（`AS-04`）在 2026-11-07 **已经跑不通**，且新端点提供 187 字段，旧「逐条抓 XML」路径在信息量上已被超越。
3. 历史数据不是「4014 行干净的宽表」，而是 **4011 条唯一记录 + 3 条重复 + 若干格式/单位/枚举不一致**（`F-16`~`F-21`），这决定了迁移不能是「原样导入」。
4. 六个点名缺陷（DF-01~06）已全部登记；另有 9 项新发现（DF-07~15），其中 DF-07 / DF-09 / DF-15 会影响数据正确性，不可延后。

**下一阶段**：`02-to-be.md` 将按 `AS-01`～`AS-09` 的同序编号，逐条给出目标规格、变更决议与可验证的验收条件。
