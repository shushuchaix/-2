# 来源与招聘附件完整代码审核

日期：2026-10-10。收尾快照：09:23（UTC+08:00）；Git HEAD `06a4b1e`。工作树允许并行实施，SHA256 表标识实际审核内容；HEAD 本身不代表未提交源码版本。

## 范围与方法

本报告负责 `src/sources/` 和 `src/attachments/`。50 个文件完整读取：46 个 MJS、4 个 JSON；合计 12,790 行，其中代码 8,751 行、JSON 4,039 行。大 MJS 分连续行段读取，JSON 解析后分连续条目压缩输出，全部字段读完。首次目录快照为 48 个文件。报告写入后的 SHA256 校验发现主实施改动 registry.mjs、catalog/platforms.json 并新增 adapters/boss.mjs、boss/cities.mjs；已完整读取这 4 个变动文件并更新覆盖表。收尾 50 文件没有未读文件；后续并行变动需要另行复核。全项目其余部分由主审计报告汇总。

使用 learn-codebase 的完整阅读要求、systematic-debugging 的单因果离线复现方法，以及 data-quality-auditor 的字段来源/未知值审查思路。没有给源码伪造数据质量分数。

全部复现使用合成文本、内存 request mock 或 child_process spawn mock；仅执行本地 Node20，网络调用 0、真实岗位采集 0、简历读取 0、账号/凭据访问 0、付费模型调用 0。未修改产品源文件。下述问题是该 SHA256 快照的发现，不等于已修复，也不能用于声称线上来源可用。

## 结论

影响采集质量的主要问题集中在适配器契约，而非单纯来源数量：

1. 旧高校/晨云/就业桥适配层把内部详情额度设为零，导致没有任何岗位输出却报完成。
2. 高校公告子岗位标题仍使用公告标题，多个真实子岗位失去独立身份。
3. 社交列表 HTTP/业务失败可被当作正常空页。
4. 附件发现、链接提取与数量限制会漏掉有价值的招聘证据。
5. 旧详情适配器漏计详情预算，部分解析/运行失败被吞成正常完成。

目录 JSON 初始共 96 个站点；并行实施新增 Boss 后为 97 个站点：30 个 ready、67 个 candidate，siteId 无重复。40 个条目的 capability 值是字符串 `unverified`；应显式按验证状态判断，不能把 JavaScript truthy 当成能力已通过。ready 以及历史 probeEvidence 仅为已有目录资料，本次没有线上复查。

## 已复现问题

### S01 / P1：三类旧来源稳定零输出，仍报告完成

位置：`src/sources/adapters/legacy.mjs:82`，`src/sources/university.mjs:893`，`src/sources/chenyun.mjs:412`，`src/sources/jiuyeqiao.mjs:305`。

根因：统一 legacy.collect 参数固定 `maxDetail: 0`。university、chenyun、jiuyeqiao 均只在内部挑选详情后往 jobs 数组写记录，而这些模块没有导出 fetchDetail；因此设置零无法产出供协调器继续处理的列表记录。

合成高校列表含一个可解析公告；直接 university.collect({maxDetail:1}) 输出公告及两条职位表记录，共 3 条。相同 mock 经过 createLegacyProvider('university').collect 后输出：

```json
{"records":0,"issues":[],"coverage":[{"status":"complete","truncated":true}]}
```

目录有 8 个 university 条目、1 个 chenyun、1 个 jiuyeqiao 会经过这类契约。没有真实网络验证这些站点。

最小改进方向：为三类模块拆出只读列表记录与独立详情操作，让协调器决定预算与持久队列；临时兼容方案也必须真实记账、输出可继续的记录，不能用固定零额度“禁用详情”同时清空所有候选。验收：列表有有效条目时至少保存 discovery 记录；详情额度零时延期而非伪报成功空源。

### S02 / P1：公告子岗位名称被公告标题覆盖，身份相撞

位置：`src/sources/university.mjs:745`、`src/sources/university.mjs:912`。

根因：toJob 优先 base.title，仅在 base.title 不可用时选 detail.title。子岗位循环传入 detail.title=p.name，仍沿用同一个公告 base；ID 又由学校、最终标题、城市构成。原始表行/岗位名未进入身份。

合成职位表含“消防工程师”和“机场安全工程师”，城市均为上海。本地解析 positions 得到两个不同名称，直接 collect 的两个子记录却为：

```json
{
  "titles":["示例工程公司校园招聘公告","示例工程公司校园招聘公告"],
  "ids":[
    "university:测试高校:示例工程公司校园招聘公告|上海",
    "university:测试高校:示例工程公司校园招聘公告|上海"
  ]
}
```

另有静态边界：parseNoticeDetail 的 NOISE 匹配 `投递简历$`，普通表行如果以“投递简历”按钮文本收尾，会整行跳过（690–729）；该变体尚未执行单独探针，不并入上述已复现结果。

最小改进方向：子岗位明确覆盖标题，保留公告权威标识加岗位行/位置 scope；采用列头映射区分岗位字段与操作栏，不让按钮文本否决整行。共用条件与岗位行条件分别保留证据，其他行的学历/专业不得串入本行。验收：同公告、同城市、不同岗位名称保留各自身份；复查同一行不重复增生。

### S03 / P1：微博/公众号错误响应变成“采集结束”

位置：`src/sources/adapters/weibo-public.mjs:101`，`src/sources/adapters/wechat-public.mjs:74`，`src/sources/adapters/shared.mjs:115`。

根因：社交列表只拒绝 401/403/429，其他 HTTP 失败继续解析。微博 JSON 业务失败没有独立契约检查，parseWeiboList 缺列表时默认为空。collectPage 据 hasMore=false 返回 done=true，协调器可能提交空页、推进游标并记成功时间。

离线结果：

```json
{
  "weiboHttp500":{"input":{"ok":0,"msg":"offline failure"},"records":0,"done":true,"issues":[]},
  "wechatHttp500":{"records":0,"done":true,"issues":[{"code":"account_history_limited","retryable":false}]}
}
```

公众号“历史有限”提示没有说明该次 HTTP500。真实平台业务契约需用可公开/授权的 fixture 单独核实，不能假定所有合法空列表都必须有岗位。

最小改进方向：先检查 HTTP 成功，再核对已验证业务与列表结构；明确区分合法空列表、登录/挑战、HTTP不可用、契约变更。失败不推进分页、不设置最近成功；保存请求状态与错误编号。验收覆盖 500 JSON、200 业务失败、200 HTML 错页、合法空列表。

### S04 / P2：附件为主体的短公告，在发现附件前被拒绝

位置：`src/sources/adapters/official-announcements.mjs:180`。

根因：body 文本长度不足 30 即抛 parse_error；附件链接到 186 行才发现。正式招聘公告只有“详见附件/岗位表”的场景会完全失去表格证据入口。

离线输入 `<main>详见附件<a href="/jobs.pdf">岗位表</a></main>` 返回 `parse_error: Notice body insufficient`。控制输入仅增加足够正文，同一个 PDF 被检出 1 个附件。

最小改进方向：先发现合法附件；短正文+招聘附件作为待解析记录保留，正文完整性继续标记 incomplete。附件解析后再进行可推荐性/证据门槛判断，不能把短文本直接冒充完整 JD。验收：文字很少但岗位表有效的公告进入附件队列；既无正文也无附件的空壳仍失败。

### S05 / P2：微博 JSON 正文中的 href-only 文件/投递链接丢失

位置：`src/sources/social-content.mjs:131`、`src/sources/social-content.mjs:153`，`src/sources/adapters/weibo-public.mjs:39`、`src/sources/adapters/weibo-public.mjs:188`。

根因：post.text 先变纯文本；linksAndImages 只从 html 参数里的 .weibo-text 读取。API JSON 路径没有这个 DOM，所以 anchor href 不进入 externalLinks；纯文本 URL 正则只能发现显示在文字里的 URL。适配器 attachments 目前又仅收 images。

离线 post.text 为 `招聘岗位：<a href="https://example.com/jobs.xlsx">岗位表</a>` 时：

```json
{"description":"招聘岗位：岗位表","externalLinks":[]}
```

最小改进方向：HTML 转纯文本前解析 post.text 的链接/图片；文件类型 href 进入附件清单，普通链接保留为证据候选。链接出站仍由现有 URL 验证与申请证据规则控制，不根据链接文本推断招聘事实。验收 API JSON、HTML页面、longText、仅可见URL四种形态都保留原始链接出处。

### S06 / P2：超过 40 个附件的清单被静默截断

位置：`src/attachments/service.mjs:282`。

根因：只循环 .slice(0,40)，返回时又用这 40 项替换原 record.attachments；剩余项既不保留也不提示，跨运行无法补处理。

离线输入 41 个合法合成 PDF 链接；request mock 返回 404（真实请求 0）；输出仅 40 个附件，最后是 /39.pdf，/40.pdf 消失，没有数量延期提示。

最小改进方向：保留完整 manifest，把本次未处理项设 pending/deferred 并记录 attachment_limit 计数；按队列预算分批处理。验收 41 项输入依然有 41 项输出，其中未处理项可跨运行继续；不改变单次安全额度。

### S07 / P2：legacy fetchDetail 没有消耗详情预算

位置：`src/sources/adapters/legacy.mjs:209`。对照 `src/sources/adapters/shared.mjs:354`。

根因：shared provider.fetchDetail 调用 ctx.budget.claimDetail；legacy.fetchDetail 没有。主 collection-service 调用处也没有外层详情记账，因此默认 maxDetails 或版本详情额度对这些详情失效。HTTP requests 总预算依旧存在，不是无限网络访问。

离线 Zhaopin fetchDetail 使用合成 JD；mock budget.claimDetail 一旦调用就抛限额错误。结果仍成功返回 85 字符 description，claimCount=0。

最小改进方向：统一详情记账责任，按同一 source/site/id resourceKey 收取或复用详情积分；不得多处重复收取。验收额度零时没有请求；达到上限记录可恢复延期；重复资源按 ledger 约定处理。

### S08 / P2：牛客损坏内嵌 JSON 被吞成成功空页

位置：`src/sources/nowcoder.mjs:77`、`src/sources/nowcoder.mjs:229`、`src/sources/nowcoder.mjs:310`。

重要边界：完全没有 __INITIAL_STATE__ 标记时，getWithRetry 已抛 parse_error；该边界无需重复修复。

根因：有标记但 JSON.parse 失败，parseState 返回 null；fetchCampusJobs 返回 jobs=[] 和 note，collect 仅记录日志不放 errors。legacy 最终成功完成。

离线 `<script>window.__INITIAL_STATE__ = {not valid};</script>`：

```json
{"raw":{"jobs":[],"note":"未找到内嵌数据"},"adapter":{"records":0,"issues":[],"coverageStatus":"complete"}}
```

最小改进方向：解析失败/缺预期列表字段给出 typed parse_error，合法空数组保留为真实空页；契约失败不设置健康成功。验收缺标记、损坏JSON、缺jobListData、合法空数组分别分类。

### S09 / P2：缺失牛客 ID 变成字面量 undefined 权威身份

位置：`src/sources/nowcoder.mjs:151`、`src/sources/nowcoder.mjs:182`，`src/sources/adapters/legacy.mjs:135`。

根因：只检查 jobName，不检查 j.id；String(undefined) 变成非空“undefined”。legacy 随后以非空 sourceRecordId 把它标为 authority，形成错误身份及详情地址。

离线 normalizeNowcoderJob({jobName:'消防工程师'}) 输出：

```json
{"id":"nowcoder:undefined","sourceRecordId":"undefined","url":"https://www.nowcoder.com/jobs/detail/undefined"}
```

该探针没有证明后续去重一定误合并；明确发现是无效 ID 被提升为权威身份。

最小改进方向：来源契约要求合法 ID；不满足时拒绝该行并记解析计数，或只能产生无权威ID的 discovery 记录，不能造详情URL。验收 undefined/null/空白/有效数字串。

### S10 / P2：DOC 转换器一次临时探测失败污染后续调用

位置：`src/attachments/doc-converter.mjs:45`、`src/attachments/doc-converter.mjs:56`。

根因：verified ||= run(... --version) 保存 Promise；首次 spawn 错误/取消会永久保存 rejected Promise。后续 convert 复用同一失败 Promise，不再探测，即使外部状态恢复。

离线 mock child_process.spawn，第一次产生暂时 ENOENT，且 close 触发清理；两次 convert 总共只 spawn 1 次，两个错误相同。使用 process.execPath 仅满足本地路径 stat，本探针没有启动真实转换进程、创建临时文件或声称配置了 LibreOffice。

最小改进方向：失败时清除探测 Promise，成功结果才持久缓存；并发探测仍复用正在进行的 Promise。取消不能让健康度永久变坏。验收失败后下一次重新探测，成功并发只探测一次，取消与超时资源清理独立验证。

## 静态风险与改进建议（没有本次运行复现）

### R01：混合 PDF 的少量文字阻止 OCR

`src/attachments/pdf.mjs:32` 仅在该页 text items 为零时 OCR。存在文本页眉但岗位表本体为扫描图的 PDF 会跳过 OCR；少量文字块不能证明表格内容已完整抽取。建议按页文字覆盖与栅格区域识别候选，保留需OCR的状态与坐标，建立页眉+扫描表、纯文本、纯扫描三类样本验证。不要把技术论文基准分数当本项目准确率。

### R02：刷新/爬取时间误作发布日期

`src/sources/searchapi.mjs:72` 将 dateLastCrawled 兜底为 date；`src/sources/nowcoder.mjs:200` 使用 refreshTime；`src/sources/shixiseng.mjs:188` 使用 refresh。这些映射应有 publishedAt/updatedAt/observedAt 区分，缺发布日期保留 unknown。不能靠刷新时间独自证明仍在招。此处未查平台最新字段语义，来源契约需官方/真实样本核对后再调整。

### R03：错误元数据必须继续脱敏

searchapi 抛错包含上游响应摘要，searchAll 又拼入 query；多个旧 collect 把异常降为字符串。主诊断基础设施虽有白名单，业务 sourceIssue.message 仍需核查最终保存/导出路径。推荐维持 typed code、status、requestId、parserCount、nextDueAt 与 errorId，避免把上游正文、关键词或凭据反射保存。该发现仅是风险入口，本次没有读取真实私密诊断或证明已泄漏。

### R04：旧正文兜底缺少岗位范围证据

Zhaopin 详情最终兜底整个页面前 2000 字；实习僧前 2500 字；就业桥无明显岗位模块时前 1500 字。这些长度足够的导航/错误页不能自动等于完整 JD。建议适配器同时给 selector、bodyStatus、truncation、来源字段证据；推荐门槛只接受岗位模块内容，无法定位时保留 incomplete 与解析错误。该问题需要主领域 evidence 状态流联查，不在本报告武断声称推荐错误已发生。

## 已具备且值得保留的结构

- collection-page 限制游标深度/大小/字段，生成稳定 pageKey 并检测分页循环。
- shared provider 已从两页硬限制发展为最多 20 页；分页深度由契约/游标/预算共同限制，不能仅提高规划常量。
- source-quality 根据正文、时效、健康状态给质量信息；discovery 只创建 candidate，不凭 URL 发现自动标 ready。
- 附件解析具有 ZIP 条目/解压/像素/页数约束，字段带页码或单元格证据；缺失字段可保持未知。
- cleanup 在创建资产前登记，限制路径、符号链接和活动归属；失败清理保留意图。继续将会话/临时资产置于目标版本包的生命周期内。
- 社交内容区分雇主招聘、求职帖、新闻和未知；公众号主体不直接当作岗位公司/城市事实。

## 与参考工程结合的判断

这些是适配本项目后的建议，参考软件不构成答案：

1. 持久详情队列与页原子提交：先保存可恢复列表，按版本包与活动账本领取详情任务；借鉴 [Crawlee 请求存储](https://crawlee.dev/js/docs/guides/request-storage) 的 pending/handled 概念，但保留本项目版本隔离。
2. 域名节流反馈与重试到期：调度器执行者必须收到实际响应反馈，失败冷却不能占满所有全局槽；参考 [Crawlee 并发控制](https://crawlee.dev/js/docs/guides/scaling-crawlers)、[Scrapy AutoThrottle](https://docs.scrapy.org/en/latest/topics/autothrottle.html)。
3. 爬虫恢复状态必须易审计：游标、去重键、失败次数与截止时间持久保存；参考 [Scrapy JOBDIR](https://docs.scrapy.org/en/latest/topics/jobs.html)。不要把 cookie/token 放入这些公共队列字段。
4. 浏览器与解析 worker 分工：本项目协调器仍拥有预算和进度；Scrapling 可作为受控读取执行器，不能再维护第二套无版本归属的主队列。参考 [Scrapling v0.4 spider 文档](https://scrapling.readthedocs.io/en/v0.4/spiders/advanced.html)；本次没有确认当前安装运行时等同文档版本的全部功能。
5. 授权/风险 hook 与普通观测 hook 分开：普通诊断可失败软化，预算、版本归属、风险停止应传播异常，阻止下一种传输回退。Boss 公开 SDK 的不同 transport 分支已有静态对照，不能把某一分支问题泛化到所有接口。

上述官网文档已通过网页工具读取；REA 对旧 ASAR 的分析请求未在等待窗口返回结果并被终止，没有证据ID。因此本报告没有宣称已完成 REA 包反推或源码/产物整体对照。

## 完整读取覆盖表

新增 Boss 源文件仅做完整静态读取；没有重复接口试探、读取会话材料或执行 Boss 网络调用。

表内全部路径相对本工作树；SHA256 为已阅读文件快照，字节数未包括行号输出。JSON 为配置本身行数，内容读取时只压缩展示，不删字段。

| 路径 | 行数 | 字节数 | SHA256 |
|---|---:|---:|---|
| src/attachments/cleanup.mjs | 158 | 4969 | `25fa3fe9e22ab043e0f76ae40d39d68f7da2a367f5cf6cacfa150982992f3d95` |
| src/attachments/doc-converter.mjs | 105 | 3265 | `28c47a75cdb87ac629863073bf039a194f921194bbecc0d6749a78a76c76f04d` |
| src/attachments/docx.mjs | 60 | 2037 | `b570273381f68664828c4a9bda9d0583bd060443c6520fd99138dc9826985b3e` |
| src/attachments/ocr.mjs | 139 | 4669 | `4d474bdf3d38467e6da679132e6da94d48b89ca5c6c7508a106937afe5b28a93` |
| src/attachments/pdf.mjs | 69 | 2373 | `1d675573f33639f240e44b8ecf92896c59c439f8ab06ae8f4de67a55af1fb366` |
| src/attachments/service.mjs | 316 | 9239 | `5f264d71719bbf858e4449b915be4454168bc7e85c11f8041de04eeb829c070a` |
| src/attachments/spreadsheet.mjs | 50 | 1598 | `13da638fe1e18270bdd84cfb670b9f1eee327c63753a7950d8158c4457f8a8ca` |
| src/sources/adapters/boss.mjs | 68 | 4167 | `8ab0cc53b008f9f83fca90ef760606ebf440498ec04db0c9f6d01d3ba01b90bb` |
| src/sources/adapters/greenhouse.mjs | 112 | 3436 | `6dde58676202e46e39aaf56f34f3284ea34a69c149c64b3e9ef75d39b9af20dc` |
| src/sources/adapters/legacy.mjs | 251 | 8431 | `4de888c482b4c9c7d1255a574c9c196ff3846dc58eca84cb65bf503722cbdebd` |
| src/sources/adapters/ncss.mjs | 182 | 5724 | `86dd005e026093d1c39e04e201ff4e07712a48b215955c60ef89c1e3303abd0f` |
| src/sources/adapters/official-announcements.mjs | 218 | 7034 | `a5990217871eb792bc5749e54b4f05b13c2686ada5e0c5945231d27701c61928` |
| src/sources/adapters/shared.mjs | 474 | 15288 | `830232bfa55e6d1853cb74fa2c6bfaa22319b7c07e97320dc3a675c34f7e1df1` |
| src/sources/adapters/smartrecruiters.mjs | 115 | 3861 | `a9146cb1398f93b4df186899b9b5b53ebfe9578c9dc34d205cd223ab44773d5f` |
| src/sources/adapters/social-discovery.mjs | 137 | 3872 | `17fe3d0d896e5abf108bcf4e835ae4adeb46b63ddec38876316d5bb200519559` |
| src/sources/adapters/tencent.mjs | 99 | 2839 | `5ff10c771f9460c9fe8360c1d6c1d8993a175274fc2ea4f67d9a0adc5bf33380` |
| src/sources/adapters/university-91job.mjs | 221 | 6378 | `051f208ecb20556c6288d8774608623489767ee293ec7aded530dd4829b37797` |
| src/sources/adapters/wechat-authorized.mjs | 35 | 904 | `4bac0bc5726f4c9c57ea82bb266194be87090ec9f8c9250b6a52d2849f152052` |
| src/sources/adapters/wechat-public.mjs | 152 | 4739 | `76fae7bb5ae5df7ff6d4dd98b0910f7bf3318b2866d39f404769fdd9f88ab7da` |
| src/sources/adapters/weibo-official.mjs | 34 | 827 | `8c3173500db63ac96fc21fecc27034599782f6cfbdb291df69e1a3903dca7060` |
| src/sources/adapters/weibo-public.mjs | 217 | 6883 | `d73c6ced0e440a57673998e3c500b9b4ed2b0c3cda71aba774daf916ef12fa3a` |
| src/sources/adapters/yingjiesheng.mjs | 94 | 2841 | `ff80fc5b7688342f7e14b8ecdf0575630c5d6dcc12c1be5939978cecb1b16966` |
| src/sources/boss/cities.mjs | 20 | 1438 | `bb1080f7ebe5677adbd7c64c9948a51eb8a5a77b13470d7b229577f3645cbf0e` |
| src/sources/boss/protocol.mjs | 113 | 3697 | `f4414fa7b90d1a69a1baafe226eb11e0e4d6229a51bc0381f5d47f12d1a03aa8` |
| src/sources/boss/records.mjs | 88 | 2688 | `d217c5c9287c460f7c528338c89d793a0c26581a4e5ec8d064d5f68dca275f23` |
| src/sources/catalog.mjs | 70 | 2190 | `d12b3175d1354c1b0fc6bb538c296510573eeb68f83bb147887708247d18d052` |
| src/sources/catalog/employers.json | 1875 | 60639 | `1a8f0f9a5bd6a86ea7bd4279fc30ed1b6c57b9473e0a14d424bac896dfbc6c6c` |
| src/sources/catalog/platforms.json | 311 | 8680 | `be980e352763192008a72cb5f082dda9a7d1341541e41e9e8c1801b5e4aa8067` |
| src/sources/catalog/public-notices.json | 350 | 11538 | `baace9008fcb3901fd071cd62cae377bffe1277b240658cf2923a2dfe6e7ebf1` |
| src/sources/catalog/universities.json | 1503 | 45622 | `1522589e6c8999944a8204cc3fc1657f52a9862436fad3cfa2c543a7ffe4d8a0` |
| src/sources/chenyun.mjs | 437 | 14955 | `2e1bf7c0d7fb72241cb0b6737eb858d3173a34dd06c67e25532fae2c18789436` |
| src/sources/collection-page.mjs | 120 | 4052 | `7ee3c69f80b60693a9ad1852fab17f82f55eba492c473fce53530de8231a69e4` |
| src/sources/common.mjs | 39 | 1813 | `6172638de6389a4a7b3210ac5513e2c93583a5845d0a9cda07b322a66bf4efae` |
| src/sources/content-queue.mjs | 112 | 3711 | `ef4853dda9b997ca5f10a4b44e7c7ee0081147858a85d153bb563546019942eb` |
| src/sources/discovery.mjs | 149 | 4793 | `c4c48f2b60a084a8848a4220c690d721cbb7e0b4330f1a2e26401b29984b577b` |
| src/sources/fontmap.mjs | 112 | 3480 | `e1e1bf648c01bab1c4baf06c9219683c6503708c97fd697435533122ec1cb09f` |
| src/sources/index.mjs | 357 | 11652 | `58fd6cb03b74f6e6c993206a1e57d10ab7e8c2fd72edc3688f9d24c75e92627a` |
| src/sources/jiuyeqiao.mjs | 323 | 11687 | `18680f537d27fbc57c58a32e9cfe04fca8b0ac5959635d9addcad71ab9787511` |
| src/sources/nowcoder.mjs | 347 | 10529 | `84d96759ce453d5310fd7c0a65556a66932d11085a90397fb57f5a25e110d33d` |
| src/sources/planning.mjs | 314 | 10259 | `9429e116ea1477f44e8af8fbf976ec38213f6bfc61323c6d2be71255f983d5a9` |
| src/sources/registry.mjs | 56 | 1902 | `217be8c5e4de8c29ff7a91fad869605846295cbd715b34adf302e433d490fdda` |
| src/sources/request-context.mjs | 33 | 1145 | `0be86f8f432b39172bb2bb619a79d5634c4f699fd9d9f8b877d768ed3e6f00cf` |
| src/sources/searchapi.mjs | 214 | 6197 | `2e9d01f6d24cd89039425c23ec1fb34ec029973b7e5401bda5115ac16d544e9c` |
| src/sources/shixiseng.mjs | 553 | 17428 | `fcdf70ee7e2af8aa8e34b2ea3e0f359107659e16f8cd09399c370553758f5cf9` |
| src/sources/social-content.mjs | 238 | 7771 | `1bfe5dd2628105e71412ff09391569cbd95140ed84e00d44d06e31bb8915085c` |
| src/sources/social-intent.mjs | 30 | 1008 | `bb45c53e8f7e5cc7a5a233ce38ce9e1fe8c49e4a8c7c87d508d6cbf25627ea0a` |
| src/sources/source-quality.mjs | 104 | 3089 | `d2a696bdde961800111fa635314fb9cf008b787744a4dccc21ece155cc688afd` |
| src/sources/university.mjs | 950 | 30798 | `c3b0bd9b127a8ce6e355a06b2484574051098314d90013164ae71f818bb2ad06` |
| src/sources/wechat.mjs | 387 | 12558 | `de102fc0cddea4b2343a00f26678cd2245ae3fd32ccbf6344c715131ffab6637` |
| src/sources/zhaopin.mjs | 279 | 8345 | `bf9700203b9fc727c625bc99384e54be83d629773770fbc71cdf0f53e0dffd42` |

## 验证与交接

执行工具：`.cache/node20-runtime/node-v20.20.2-win-x64/node.exe --input-type=module -`；通过 PowerShell here-string 输入本报告所列合成场景，使用 assert 检查问题仍能复现。未添加产品测试文件、未提交 Git、未修复上述源码。

主实现应先针对 S01/S02/S03 建立不依赖网络的回归，再修复采集契约；然后处理附件与预算边界。全来源实测、真实简历测试、付费限额与新 EXE 验证属于主任务后续验收，本子审计没有执行，也没有把“读取全文件”写成“所有问题已解决”。并行工作后新增或改动的来源文件需要重新全读并更新覆盖快照。

## 最小 TDD 交接补充（2026-10-10，测试建议，未实施或运行）

本节重新读取相关公开源码及测试入口后提出回归用例，不改变上面的全读快照。所有输入使用合成 HTML/JSON、保留域名 example.org 和临时文件；网络只注入 `context.request`，保留 `tests/helpers/network-guard.mjs`。通过 `collector` 返回预造岗位会绕过 S01/S02/S08/S09，不能证明真实 legacy 采集链已修复。测试作者需要先观察实际失败点，再实施最小修复；本节没有声称任何新测试 RED/GREEN。

### S01：列表输出与 maxDetail=0（三个参数化案例）

- 放置：`tests/integration/legacy-sources.test.mjs`；直接调用 `createLegacyProvider(id).collect(ctx)`，不传 collector。
- 公共调用链：legacy.collect → university/chenyun/jiuyeqiao.collect → sourceFetch → 注入 request → 列表 parser → jobs/normalizeRecord。当前三类都只在内部详情循环 push jobs。
- 最小列表：university 为 `<li><a href="/job/view/id/1">合成岗位甲</a>职位信息</li>`；chenyun 为 `<li><a class="post-title" href="/index/index/employjobdetail.html?id=1">合成岗位甲</a></li>`；jiuyeqiao 为 `<ul class="ul-main-list"><li><a href="/zhiwei/1.html"><div class="list-job">合成岗位甲</div></a></li></ul>`。ctx 一站、一个合成查询、pageLimit=1，返回 HTTP200。
- request 按列表 URL 返回 fixture；任何详情 URL 立即抛 `unexpected_detail_request`。university 的两个 type 列表返回同一条，用于验证同链接只留一条。
- 断言：默认列表阶段 records=1，保留 title/url/siteId，正文保持未知或 incomplete；详情请求=0；listed>0 时不得以 complete+records=0 伪装真实空列表。另 module.collect({maxDetail:0,delayMs:0}) 可作为底层契约回归。
- 若实施选择受预算限制的内联详情而非列表/详情分离，要改为断言零详情预算仍保存列表；不能仅把 maxDetail 从0改成正数后宣称已覆盖此问题。

### S02：大学公告两个子岗位及身份稳定

- 放置：同一 legacy 测试文件；`withSourceContext({request}, () => university.collect({keywords:["合成"],hosts:[{host:"https://school.example.org",name:"合成学校"}],maxHosts:1,maxDetail:1,delayMs:0}))`。绕开 S01 的零详情限制来单独暴露身份问题。
- 列表用 `/campus/view/id/1`，标题“合成公司招聘公告”；详情 `<title>合成公司招聘公告</title>` 加两行表格：`01 | 合成岗位甲 | 北京市 | 本科`、`02 | 合成岗位乙 | 北京市 | 本科`。第一用例不要加“投递简历”，避免先被 NOISE 正则过滤。
- 调用链：parseNoticeDetail.positions → collect 子循环 → toJob(item,...,{title:p.name},"招聘公告-职位表") → normalizeRecord → resolveJobIdentity/classifyJobDuplicate。
- 断言：extra.kind 为“招聘公告-职位表”的两条，titles 恰为甲/乙，id 不相等；规范化后 identity.key 不相等、关系 distinct。公告原记录仍保留公告标题及原 URL。将两行次序交换再采一次，甲/乙的各自 identity.key 不变。
- 独立第二用例在有效岗位行末添加 `<td><a href="/apply/1">投递简历</a></td>`：parseNoticeDetail.positions 仍有两条；页脚“电话：合成占位”行仍被排除。此用例暴露当前 NOISE 的行尾误杀，不能和标题用例合并。

### S03：社交列表的 HTTP、JSON、业务失败分别传播

- 放置：`tests/integration/social-body-collection.test.mjs`，参数化 wechatProvider/weiboProvider；站点分别为 wechat/weibo，config 使用合成 accountIds（微博数字、公众号合法 __biz），articleUrls 为空，调用 collectPage({site,context})。
- HTTP500 fixture：公众号 text=`<main>临时服务异常</main>`；微博 text=`{"ok":1,"data":{"cards":[]}}`。断言 collectPage 拒绝且 error.status=500，request=1、maxRetries=0；调用 collect 的外层控制用例断言 coverage.status=failed、issues 非空，不能 reported complete/empty。
- HTTP200 普通坏 JSON：微博 text=`{"data":`，断言 code=parse_error，不应把语法错误解释成 challenge_required。业务失败 text=`{"ok":0,"msg":"服务异常"}`，断言明确业务失败 issue/拒绝（建议 code=parse_error），不能 done=true+issues=[]。
- 正向空列表控制：`{"ok":1,"data":{"cards":[],"cardlistInfo":{}}}` → records=0、raw=0、done=true、issues=[]。401/403 → login_required；429 → rate_limited，保留 nextDueAt，均只调用一次 request。
- 公众号无可见文章的账号首页只能报告 account_history_limited；该平台目前没有已核验的历史空列表契约，不能照搬微博的“真实空列表”结论。

### S04：短公告附岗位表，独立于缺失正文

- 放置：`tests/integration/notice-sources.test.mjs`，复用现有 ctx/template；调用 announcements.fetchDetail(record,ctx)，HTTP200 body=`<div id="body">详见附件<a href="/roles.pdf">岗位表</a></div>`。
- 链：shared.fetchDetail → official detail → noticeDocument → bodyRule → attachments → shortBody → 返回不完整证据。断言附件 URL 保留、detailStatus/bodyStatus=incomplete、attachmentBodyPending=true、retryEligible=true，不抛 parse_error、不标 complete。
- 控制：移除附件后拒绝 detail_insufficient；缺失 #body 仍拒绝 parse_error。新读取源码已有附件先提取及 shortBody 分支，此用例是回归保护；未运行，不能宣称仍 RED。

### S05：微博 JSON 内 HTML href 不丢失，并进入附件链

- 放置：social-body 测试分两个行为。parser 用 post={id:"123",text:`公司招聘合成岗位。<a href="https://jobs.example.org/roles.pdf">岗位表</a><a href="https://jobs.example.org/apply">报名入口</a>`}，url=`https://m.weibo.cn/detail/123`；仅 href 有 URL，锚文本没有 URL。
- 链一：parseWeiboContent → DOM linksAndImages（应处理 post/longText 的原 HTML）→ externalLinks。断言两条 URL 和 label 均保留、description 只有可见文字；无须联网追踪报名地址。
- 链二：weiboProvider.collectPage 的 cards[].mblog 放上述 post，随后 fetchDetail 使用此记录 → attachments → attachmentService.enrich。断言列表/详情的 externalLinks 不丢失，attachments 仅包含 roles.pdf（不是报名入口），来源说明与原帖 URL 可追溯。注意列表 recordFor 当前不保留 post；request mock 需按 URL 分支，getIndex 返回 `{ok:1,data:{cards:[{mblog:post}],cardlistInfo:{}}}`，statuses/show 返回 `{ok:1,data:post}`，长文 statuses/extend 返回 `{ok:1,data:{longTextContent:fullHtml}}`，不能让详情端点重复返回列表 envelope。
- 独立长文控制：isLongText=true、longTextContent 含相同 href，验证长文取代 preview 后链接仍保留；无长文仍 incomplete。

### S06：41项完整清单、额度延期和重新打开

- 放置：`tests/unit/recruitment-attachments.test.mjs`。createAttachmentService({ledger,cleanup,request}) 的 record.attachments 为41个唯一 `https://jobs.example.org/a/0.pdf` 到 `40.pdf`；HTTP返回404，避免依赖任何文档解析；清理接口仅合成 attemptId。
- 链：collection-service.enrichRecord → attachmentService.enrich → extract → ledger.reserve(attachment_credit) → request/缓存 → 保留 extraction。第一最小用例断言返回仍有41条、原顺序不变，实际首批 request 最多40，未尝试项 pending/deferred 且有延期原因；目前 `.slice(0,40)` 会把最后一项直接丢掉。
- 独立预算中断用例：真实 ledger maxAttachments=2，3条附件，前两项返回404；第3项 credit reserve 拒绝。断言已处理两项与第3待处理项均能保存在工作记录，异常带回 partial record 或协调层提交 partial；不能只 throw 导致整个附件清单与已提取结果丢失。
- 集成控制放 `tests/integration/collection-ledger.test.mjs`：same ref/activity，关闭并重新打开 repository，换合法 slice token；usedAttachments 仍为2，第3待处理 URL仍在，追加尝试不得发生 HTTP、额度不得回到0。不存在额度的第41项不能因续采自动变成成功。
- 每次40项切片与活动累计 maxAttachments 是两层规则。当前 validateCollectionLimits 拒绝 maxAttachments=41；要处理第41项需要未来明确授权的新活动/预算策略，本回归不改变已批准累计预算。

### S07：legacy 详情必须先占用真实积分

- 放置：legacy 测试中的参数化 zhaopin/shixiseng；record 含合成 url/sourceRecordId/siteId/sourceId，request 返回 `<main>岗位职责：合成设备维护。任职要求：本科。</main>`。
- 链：collection-service 正常详情/正文重试 → legacy.fetchDetail → module.fetchDetail → sourceFetch。当前 legacy 没有 claimDetail；collection-service 上述路径也没有外层 claim。
- 最小阻断用例：budget.claimDetail 直接拒绝 code=source_budget_exhausted，断言 legacy.fetchDetail 拒绝、request=0。真实 ledger 控制：maxDetails=1，第一个 key 调用成功；同 key 再次调用 usedDetails=1（可有请求额度开销）；第二个不同 key 拒绝且无新增 request。
- key 应为 `sourceId/siteId/sourceRecordId`；测试快照看 ledger.usedDetails，不看 claimDetail 调用次数。run-service 已在外层 claim，同 key 再占用由 ledger 幂等，不能把两层调用误判为两积分。

### S08：牛客内嵌 JSON 损坏不等于空岗位

- 放置：legacy 测试；注入 HTTP200 HTML=`<script>window.__INITIAL_STATE__ = {broken:};</script>`，直接 createLegacyProvider("nowcoder").collect(ctx)（默认 includeSchedule=false）。
- 链：nowcoder.getWithRetry → parseState(JSON.parse) → fetchCampusJobs → collect.errors → legacy.sourceIssue/coverage。断言 records=0、issues 含 parse_error、coverage failed、一次 request；不得 errors=[]+complete。
- 两个分离控制：无 marker → parse_error；合法 `<script>window.__INITIAL_STATE__ = {"app":{"jobListData":[]}};</script>` → 正常空列表。不要以单纯 records=0 判断解析是否成功。

### S09：牛客缺 ID 的记录不产生权威 undefined/null

- 放置：现有 normalizeNowcoderJob parser 用例，输入 {jobName:"合成岗位甲"}，以及 id=null/空串。断言 null 或明确 invalid_record，不能返回 sourceRecordId="undefined"/"null" 或 `/detail/undefined`。
- 端到端最小 control：SSR jobListData 两条（缺 ID 一条、id:"123" 一条），legacy.collect 后只保留123；raw=2、invalid 有计数或问题，合法一条仍 sourceRecordIdKind=authority。规范化之前拒绝坏 ID，不靠去重删除碰巧同 ID 的记录。raw=2 应先在 fetchCampusJobs 返回合同验证；当前 legacy.stats.raw 被重算为 records.length，要在适配器层断言 raw=2 需同时明确修复该统计传递，不能假定当前已有透传。

### S10：DOC 版本探针失败后可恢复，成功探针再缓存

- 放置：recruitment-attachments 测试独立 converter 用例。createDocConverter({executable,cleanup}) 使用临时绝对路径占位文件，满足 fs.stat.isFile；用 node:test 的 mock.method(node:child_process,"spawn",fake) 后 syncBuiltinESMExports，结束时还原并再次 sync，不启动真实 Office。
- fake child 使用 EventEmitter/stdout/kill。第一次 `--version` close(1)；第二次 `--version` stdout 输出 LibreOffice 再 close(0)；转换调用在 `--outdir` 下写入现有 makeDocx 生成的 input.docx 再 close(0)。每次 convert 用独立 attemptId，cleanup 用实际临时清理组件。
- 链：parseAttachmentBytes(.doc OLE头) → converter.convert → verified/run(--version) → headless convert → parseDocx。最小断言第一次 convert 拒绝 doc_conversion_failed；同一 converter 第二次重新执行探针并返回合法 DOCX bytes，总spawn=3；第三次不再探针，另一次转换后总spawn=4。
- 当前 `verified ||= run(...)` 把 rejected Promise 永久缓存。建议仅缓存成功验证，失败清除正在验证的 Promise；多个同轮调用仍共享一次探针。取消/超时不能留永远拒绝的缓存；不要求无间隔重试真实缺失的工具。

执行顺序建议：S01输出契约 → S02身份 → S07积分；S03/S08/S09错误契约可独立；S04/S05附件发现 → S06清单延期 → S10可恢复工具。来源适配器共享文件的修改由主实现串行安排，本子任务没有修改产品或新增测试。

## 后续修复闭环（2026-10-10 追加）

本节记录原审计之后的复现与修复。前文 09:23 静态快照、50 文件覆盖表、SHA256、原探针输出及当时的“未复现”边界全部保留；它们描述历史源码，不作为当前修复版的哈希或测试成绩。以下修复均使用本地合成材料，不使用私人简历、账号或付费模型，也不证明所有线上来源通过。

### R01：混合 PDF 已实际复现并修复

真实合成 PDF 含原生文字页眉与实际绘制的扫描岗位表。旧路径只读取页眉，OCR 未调用，附件却被标为 extracted；联查现有正文补全流程，页眉可能使正文被标为完整。单独的投递证据仍会阻止首轮推荐，因此不能把该复现扩大为任何真实岗位已经误推荐。

[PDF 提取](../../src/attachments/pdf.mjs) 现在依据 PDF.js 绘制操作与坐标变换识别图像区域，包括表单和重复图像，沿既有本地 OCR 路径补识别。原生文字保留原置信度，OCR 坐标转换到 PDF 坐标后按位置及规范文字去重；原生页眉的 OCR 回声不能证明图像内容已读。无 OCR、低置信、坐标不明或图像区域没有可信新增识别证据时保留 pending，纯文字 PDF 不调用 OCR。

[附件服务](../../src/attachments/service.mjs) 升级为 `recruitment-attachments-2`：旧 PDF 解析缓存失效，旧 extracted 结果先清除并降级正文；请求失败或额度耗尽不会继续使用旧完整证据。新提取成功后由现有正文补全流程恢复状态并清除过时提示，非 PDF 已提取证据保留原有行为。[领域正文门槛](../../src/domain/recruitment-evidence.mjs) 同时阻止尚未重新提取的 `recruitment-attachments-1` PDF 沿用完整正文。这是解析版本失效与保守复核，不代表所有历史附件已经重新采集。

[混合 PDF 回归](../../tests/unit/recruitment-pdf-mixed.test.mjs) 包含真实 PDF、真实本地 OCR、双图漏一块、位置去重、纯文字控制、旧缓存、失败及预算中断、成功恢复和非 PDF 兼容。实际本地 OCR 读出了合成扫描表的学历和专业文字。首轮附件、账本及诊断正文补全四文件窄回归 **39/39** 通过；这不是全部附件的准确率测量，也不是下述独立复核后的最新结果。

限制：成功运行 OCR 或没有新增文字均不能独自证明图像无招聘条件。装饰 logo、复杂裁剪或未识别图像可能保守待核验；每个图像出现可信定位文字也不能保证逐单元格完整、准确。

独立复核随后发现两处同范围阻塞，并分别取得真实 RED：含平移的透明 Form 同时经过 beginGroup 与 FormBegin，旧计算双应用矩阵，将可见图像误裁出页面并跳过 OCR；旧 PDF 若处于 pending/rejected，刷新失败只更新了解析版本却保留旧完整正文。修复让 group 只保存内容矩阵，FormBegin 应用一次；任何已有的过时 PDF extraction 状态在刷新前均降级，失败继续 pending。普通与透明 Form 控制、新增 pending/rejected 两例以及原回归共 **43/43** 通过，语法与差异检查通过。同一独立审阅者重放原两个纯内存输入并核对冻结 SHA：两类 Form 均执行一次 OCR、保留正确图像坐标；旧 pending/rejected PDF 失败前后正文均未核实。限定 R01 范围未发现剩余阻塞。

### R03：瞬时来源探针响应改为白名单投影

后续核对发现，全局及版本范围来源探针的瞬时响应可能直接返回带原 message 的 sourceIssue。该 message 可携带上游摘要或查询内容；原持久诊断及导出路径已有脱敏保护，**没有历史持久泄漏证据**，不能将本次风险入口描述为已证实的历史泄漏。

[来源服务](../../src/application/source-service.mjs) 对两类探针统一返回白名单问题元数据：认可的 code、由调用范围确定的 sourceId/siteId、布尔 retryable 和格式有效的 diagnosticId。自由 message、原始响应及未知字段不返回；未知错误代码映射为安全代码。[探针隐私回归](../../tests/integration/source-probe-privacy.test.mjs) **2/2** 通过，分别检查全局 HTTP 响应与版本范围响应，并确认合成敏感标记不进入工作区或诊断。

### R04：岗位范围正文与旧事实门槛已修复

后续离线联查确认，智联、实习僧和就业桥的导航页或整页长度兜底可产生错误完整正文。修复仅接受对应平台原生岗位字段或明确的岗位模块，保留完整岗位正文；公司介绍、其他岗位及导航文字不再充当当前 JD，未定位岗位正文时保持 incomplete。[legacy 适配层](../../src/sources/adapters/legacy.mjs) 将新事实标为 `legacy-adapter-3`，保留岗位身份与列表投递入口。

[旧事实正文门槛](../../src/domain/recruitment-evidence.mjs) 对上述三源 `legacy-adapter-1/2` 的已持久正文要求重新核验，不能因旧 complete 标记继续推荐；新范围解析和人工核验的正向控制仍保留。[legacy 正文回归](../../tests/integration/legacy-body-evidence.test.mjs) 新增 **12/12** 通过；来源、大学、正文、附件及旧门槛关联专项合计 **63/63**，由来源实施专项报告确认。[正文状态回归](../../tests/unit/recruitment-body-state.test.mjs) 单列 **9/9**，包括三源旧事实与旧 PDF 门槛。

### R02：日期元数据与旧输出标签已修复

后续合成入口核查确认，刷新或抓取字段被写入旧 publishTime，且原字段信息可能丢失。时效门槛仍要求独立的截止日期及其他招聘证据；刷新时间没有单独绕过推荐条件。

新采集仅将明确 datePublished 当发布证据，刷新/抓取元数据保留来源原字段名和值，不同步扩大全局日期映射。[日期元数据回归](../../tests/integration/source-date-metadata.test.mjs)真实 RED 后 **8/8**；关联 **51/51**、原搜索工具 **39/39**。CSV/Markdown 不把已确认来源的旧刷新日期标为发布，Bocha 需要明确合法原发布日期；其他来源和原始 JSON 快照保持。[导出日期回归](../../tests/unit/export-source-dates.test.mjs)真实 RED 后 **11/11**，原导出契约改前改后 **28/28**。历史原始事实未迁移；refresh 的完整平台语义仍未猜测。

### 追加验证的适用范围

39/39 是附件四文件首轮窄回归，43/43 是追加两项独立复核修复后的同组结果；63/63 是来源实施关联专项；9/9 是领域正文状态；2/2 是来源探针隐私。主代理另确认探针、就绪状态、发现、诊断及正文关联组 **23/23**。这些组存在重叠，不能相加作为新的全项目总数。

以上生产修改使此前成品源码哈希验证成为历史基线。全部源码冻结后的统一门禁由主代理取得 **983/983 业务、80/80 React，18套件通过、0失败、7明确跳过**；TypeScript、PowerShell解析和差异检查通过。最终重建、全部运行源码哈希及实际三 DPR 检查由主代理统一执行并写入交付记录；本报告不替代真实平台的小样本采集与证据质量测量。

### 最后状态修复与成品证据

最后续采结论修复增加4项UI回归，完整离线更新为983/983业务、84/84UI，18通过/0失败/7明确跳过。主代理新增EXE断言首轮误调用未定义exec，真实DPR1退出1；改用现有js后桌面隔离6/6、独立只读复核通过，再次重包133.2秒且退出0。最终包独立核验10434文件、3JS、1CSS、52依赖、207份第一方源码精确哈希、OCR32；实际DPR1/1.25/1.5各85/85、原生进程均退出0，外发/下载0、CSP与渲染器错误为空，续采旧取消文字消失。具体交付与未完成项见[专项交付记录](2026-10-10-independent-upgrade-delivery.md)；这些成绩不证明所有线上来源或每个OCR单元格已经正确。
