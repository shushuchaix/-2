# 全来源测试前置矩阵

日期：2026-10-10。性质：只读预检；不是来源实测结果，也不是九项任务的实施或评审。只读取公开目录与代码，不访问真实来源，不读取原始简历、登录材料或个人运行数据。报告不包含检索文本、个人路径、会话引用或凭据。

## 1. 范围与判定原则

逐项覆盖生产目录中的 provider/site，另外列出 registry 中无站点的可选服务。目录状态、静态能力声明、真实采集结果分开记录：`ready` 仅是过去的证据，`candidate` 不是已经接通；字符串 `unverified` 不应按 truthy 解释成能力成功。

共同前提：沿用现有活动的目标版本、权限、累计 ledger 和请求客户端；版本启用、来源开关、来源选择、冷却状态与登录可用性由执行时的服务读取。本文未读取这些私人运行状态，因此不承诺任何站点当前可用。

`hasRecentSourceProof` 要求：过去 30 天内的成功时间、正文核验记录、可接受的来源状态，时间不能超前超过 5 分钟。静态预检按目录内证据计算，未合并任何私人 health 数据。选站还会受 `source_not_selected`、`disabled`、`backoff`、`probe_required`、`site_limit` 影响。

## 2. 状态不是一条互斥成功链

建议每站记录 **执行状态** 与 **阶段计数** 两组字段，不把“parsed”或“body”当最终有效岗位。

| 字段 | 可以成立的证据 | 禁止混用 |
| --- | --- | --- |
| `skip` | 未执行请求；明确原因如未选中、模板缺失、缺种子、预算不足、可选服务未开通 | 不能算空结果或线上失败 |
| `blocked` | 登录、权限、验证码、风控、冷却、传输错误，或静态确认的适配器前提缺失；记录 `blockOrigin=static/runtime` | 不能算 empty；不自动反复重试风控 |
| `failed` | 已执行但契约、解析、身份、正文或附件阶段报错；留错误码与诊断编号 | 解析出错时不能写正常 empty |
| `empty` | 列表契约或明确空列表节点核验成功，原始列表为零，且无阻断/解析问题 | HTTP 200、JS 占位、过滤后为零、缺种子均不足以成立 |
| `parsed` | 契约校验通过的记录数量；另列 raw、invalid、filtered、duplicate | “20条解析记录”不等于20条岗位，也不等于仍在招 |
| `body` | `assessRecruitmentEvidence.bodyVerified` 为 true 的岗位/公告数，正文范围和身份支持该记录 | 正文长度30、页面兜底文字、附件未解析不能单独当完整岗位正文 |
| `application` | 分开记录 declared/available/login_required/invalid/unknown；available 需现有规则确认入口及近期表单证据 | 非空 URL、主页按钮、通用邮箱或一次200响应不足以成立 |
| `valid` | 同版本评价资格 pass，正文已核验，招聘开放，投递入口 available，无证据冲突，版本内去重后仍为新记录 | 模型高分、来源 ready、相关单位名称均不替代这些条件 |

`parsed=0` 但 `raw>0` 应记录“过滤或拒绝后的零接受量”，保留原因；如业务需要 `status=empty`，必须再附 `emptyKind=filtered`，不能冒充正常原始空列表。公告、招聘活动、搜索线索和具体职位分别计数。

现有投递规则要求核验时间在过去72小时内，识别登录、验证码、404/410等状态；没有截止证据的岗位通常为 opening unknown。邮箱报名样本应记录邮箱声明与其来源，当前规则未确认邮箱为 application available 时仍保持 unknown，不能为制造 valid 而放宽判定。

## 3. 各 provider 的实际测试前提

下表列代码契约。数量与逐站静态状态由文末快照生成；“公开”不是本轮线上连通性结论。

| provider | 列表方式与一页含义 | 登录/配置前提 | 详情与结果边界 |
| --- | --- | --- | --- |
| `ncss` | 官方域名公开 AJAX，页参数 offset/limit；职位与公告依 recruitType 区分 | 无私有登录材料要求；候选接口必须核验 flag/list 契约 | 详情专用正文节点；标题占位不能算正文，报名地址还需单独核验 |
| `university-91job` | 公共 JSON POST；每学校 tenant 一页；job/notice 是不同接口 | 五位学校代码、正确学校归属及允许域名；无学生账号要求 | 核对详情 ID/学校；列表含正文时也要按实际证据状态判断，不能凭非空文字提升完整度 |
| `official-announcements` | 受限于已配置 listUrl/linkRule/bodyRule 的公开公告栏目 | 缺模板先 skip；DOM、域名和栏目范围均需验证 | 公告可能有多个岗位，岗位表在附件；未验证分页只可当前列表一页；录用/成绩公示需分类 |
| `tencent` | 官方社招 Query API，一页20项 | 无登录要求；商业码与 Posts 结构核验 | 社招类型已知；LastUpdateTime不是发布时间；真实岗位详情与投递需核验 |
| `smartrecruiters` | 企业公开 board，一页 offset/limit | verified tenant；目前 BoschGroup 目录值存在 | 列表/详情 company identifier 与 ID 需一致；返回 applyUrl 不等于入口可用 |
| `greenhouse` | `content=true` 返回整个 board，一次响应；本地筛选 | verified board tenant；目前 canonical 目录值存在 | API 无本项目城市筛选；返回全集不是多页覆盖；公布日期与更新日期分开 |
| `yingjiesheng` | 截止日期榜当前 HTML 表格，一页 | 公开页面，无私有登录前提；当前为 candidate | 返回 company_campaign；缺表应 parse_error，不是empty；活动正文仍需拆岗位 |
| `zhaopin` | 旧适配器公开列表一页 | 公开访问可能受限；当前 candidate | 有单条详情函数；必须用同根详情 credit 与请求上下文，不能脱离ledger补抓 |
| `shixiseng` | 旧适配器列表一页；文字可能需字体映射 | 公开访问可能受限；当前 candidate | 字体学习可产生额外详情请求，一页不等于一次HTTP；正文和标题解码分别报告 |
| `nowcoder` | 旧适配器固定公开岗位页面 | 当前 candidate；一页探针关闭额外日程抓取 | 届别/正文按记录证据，不能将普通日程线索作为岗位；不支持持久分页 |
| `university` | 8所才立方目录站，旧适配器按站 origin | 当前均candidate；公开列表契约仍需验证 | 本次读到 legacy 传 maxDetail=0，而模块只在详情循环输出jobs；应静态标注 adapter_body_contract 阻断，不能将空输出认定真实无岗位 |
| `chenyun` | 1所学校晨云公开列表，旧适配器 | candidate；站点不支持服务端文本筛选，排序在本地 | 同样受 maxDetail=0 输出路径限制；无可恢复分页契约 |
| `jiuyeqiao` | 全国岗位列表一页，旧适配器 | candidate；公开接口仍需核验 | 同样受 maxDetail=0 输出路径限制；空接受量可能由适配器造成 |
| `searchapi` | 搜索服务单次查询结果 | 搜索服务配置/可用性必须由执行服务给布尔前提；不查看Key | 只是线索，不保证正文或职位事实；搜索费用不能默认算进模型10元上限 |
| `wechat` | 明确公开文章种子，或指定账号可达历史页；不提供站内搜索 | articleUrls/accountIds 的可用性由服务确认；无种子为 public_seeds_required。公开文章可先匿名读，遇限制再等待该版本独立登录 | readService 必需；海报/附件解析、发布主体、公告期与岗位拆分都单独验收；历史列表并非全量覆盖 |
| `weibo` | 明确正文种子，或指定账号 getIndex 一页 | 公开种子/账号标识及 readService；登录可选回退，限流/挑战等待处理 | 短文/长文/浏览器回退可能多请求；非招聘内容过滤；不把旧目录 authorization_required 当成当前必需登录 |
| `douyin` | 当前只有外部搜索发现契约 | 搜索服务配置；正文授权能力没有实现 | fetchDetail 固定 restricted；只能测试发现 parsed，不能宣称抖音原文 body/application/valid |
| `boss` | 受控只读 browser worker 的 search 一页 | 该目标版本独立会话、readBoss 服务、scope/ref/token/租约齐全；本预检不检查账号材料 | 缺登录为boss_login_required；风控停止整个Boss活动组。详情含临时引用，可能需要重读原页；当前provider未实现投递动作 |
| `wechat-authorized` | 可选官方授权服务占位 | 默认停用、官方发布读取权限未核实；目录无站点 | collect/fetchDetail主动报 publication_permission_unverified；skip optional_unconfigured，不进行收费服务试探 |
| `weibo-official` | 可选官方API服务占位 | 默认停用、服务/额度未核实；目录无站点 | collect/fetchDetail主动报service_unconfigured；skip optional_unconfigured |

旧适配器详情函数当前没有统一在 `legacy.fetchDetail` 内 claimDetail。执行探针要核查外层是否已经预约；需要时用同一 `context.budget.claimDetail` 预约后才调用，避免80详情上限成为无法审计的显示值。重复同资源预约由ledger去重，不通过新建预算补足。

## 4. 在现有活动上分配180请求、80详情、累计10元

### 4.1 前置条件

1. 读取现有根活动的 **用量摘要**，以 `remainingRequests = 180 - usedRequests`、`remainingDetails = 80 - usedDetails`、`remainingModelCny = 10 - costUpperBoundCny` 为剩余额度；pending/uncertain预约保守计入。本文未读取实际用量，以下是总上限内的分配建议，不是新增额度。
2. 用现有 `withActivityContext`，或暂停主采集后用 `withDiagnosticContext`。诊断slice仍绑定同根ledger、scope、token和租约。不要直接运行 `probe-sources-v2.mjs`：它当前为每站另建6请求/2详情预算，会绕开本次累计预算约束。
3. 根活动已经completed/cancelled时，当前服务不允许再建诊断slice；记 blocked(collection_terminal)，不能为继续测试另建活动并获得新额度。常规planner maxSites上限50，且只有最近正文proof的站点能被选择；诊断矩阵可列全目录，但不能把诊断覆盖当作常规计划已经采集98站。
4. 若使用重新规划，保留同根累计用量及兼容单元进度，不清ledger，不绕过候选来源、账号风险、模板或权限检查。

### 4.2 建议顺序和额度

| 阶段 | 累计账本请求分配上限（在180内） | 目的 |
| --- | ---: | --- |
| 零请求预检 | 0 | 为全部目录站点及两个可选服务建结果行，明确模板/种子/配置/登录/已知适配器缺口 |
| 首页面：provider优先，再站点轮询 | 90 | 首轮每个具备前提的provider一个站点，第二轮补其余91job学校和公告站；每站只一个查询组、pageLimit1，避免某个平台先耗尽全部额度 |
| 同批记录的详情 | 60 | 每个有parsed但无已核验正文的站点最多选一条优先补正文；首轮不把列表全部记录立即补详情 |
| 投递及必要附件证据 | 20 | 优先开放、正文完整、资格待核验/符合的记录；附件需能补充缺失岗位条件，不下载报名资料模板凑覆盖 |
| 受控恢复与保留额度 | 10 | 明确瞬时传输问题最多一次恢复；账号风险/验证码/权限缺失不在此自动重试 |
| 总计 | 180 | DNS、重定向、浏览器资源、搜索和重试均以实际ledger计费，不以“页面数”代替请求数 |

80是**详情credit上限**，不是必须补足80个详情。预算账本请求分配也不是物理HTTP次数承诺：某站一次页面可能包含DNS、重定向、字体学习、长文或浏览器资源。实际分配可调整阶段份额，但不得超过同根剩余总额。遇额度不足，后续站点写skip(budget_exhausted)及未测阶段；不能用已覆盖provider数替代逐站测试量。

优先保证不同provider的列表契约，再保证同provider不同tenant身份，再补正文/投递/附件。少量解析记录但证据齐全优于大量标题。对于同域91job，应共享域名调度器、串行或低并发，首轮maxRetries=0；有明确Retry-After的站点保留冷却，不能立即多次续测。

首页面只调用一条查询单元；报告只存 `queryIndex` 等位置元数据，不存文本或完整查询URL。搜索与抖音发现如外部费用没有独立、已授权的封顶契约，先skip(external_cost_unverified)。模型10元上限只约束已有模型累计账本，不能代替另一个服务的费用授权。

### 4.3 模型阶段

公开契约、DOM、ID/tenant、正文、日期、链接和附件用途检查优先用规则。仅对需要岗位拆分或复杂资格判断、且正文证据已取得的去重样本使用既有模型合同；沿用根活动固定模型身份及核实过的价格，不在本轮切换模型或重置费用。最多选择少量每provider代表样本，模型错误与规则回退分开计数；资格unknown、正文unknown、投递unknown仍保持unknown。

申请链接只作受控读取核验，不填表、不上传资料、不提交、不联系招聘方。用户简历匹配由已有版本服务内部完成；测试报告只输出pass/fail/unknown、脱敏原因码和样本数量，不输出简历、姓名、联系方式、证书原文或个人路径。

## 5. 建议执行报告字段

每个目录站点固定一行，字段：`sourceId/siteId/preflightClass/status/skipReason/blockOrigin/errorCode/diagnosticId/listAttempted/listContractVerified/rawCount/parsedCount/filteredCount/invalidCount/bodyVerifiedCount/applicationDeclaredCount/applicationAvailableCount/qualificationPassCount/validNewUniqueCount/requestDelta/detailCreditDelta/costUpperBoundDelta/checkedAt`。

另保留分层原因计数：过期、历史阶段、开放期未知、资格不符、资格未知、正文不足、附件未解析、投递登录、投递失效、投递未知、身份冲突、重复。详情或投递阶段没有执行时使用 `null/not_tested`，不要填0让用户误以为已经验证失败。

根活动总账本是额度权威。暂停常规采集后串行诊断，更容易按前后快照准确归属requestDelta；若与常规采集并发，仅总额度可靠，应以预约身份归属，不能将整个活动的差额归给单站。未确定请求是否发出的预约继续计入unknown上界。

## 6. 既有公开样本的使用边界

此前 `2026-10-10-public-source-seeds-research.md` 提供贵州实际DOM、纯文本报名地址、同级岗位表锚点，以及严格资格、投递缺失、日期冲突、历史公告等样本。它们可作结构/负例参考，不能当成本轮实时采集成功、当前在招或当前模型匹配通过的证据。贵州新目录候选应在同根探针中重新验收，不直接复用旧 GET 的 ready 结论。

## 7. 静态快照与逐站清单

下节由当前公开目录生成；A/P/L/K/S/D/B/T均为**测试前提分类**，不是本轮真实结果。代码正在被主任务修改，执行前只需复核发生变化的来源契约，不将此快照变成永久结论。

<!-- PUBLIC_CATALOG_MATRIX -->

### 7.1 快照统计

快照时间：2026-10-10T01:48:31.400Z。目录 **98站 / 18 provider**，registry共20个provider（另外两个为无站点的可选授权服务）。

|分类|数量|测试前提|
|---|---:|---|
|A|30|已有近期正文proof；仍需首页面|
|P|6|无近期正文proof；先做契约探针|
|L|10|maxDetail=0输出缺口；先确认修复|
|K|1|搜索配置及费用契约未核查|
|S|2|公开种子/readService未核查|
|D|1|仅搜索发现；正文不可测|
|B|1|该版本登录/readBoss未核查|
|T|47|缺listUrl/linkRule/bodyRule|

A表示过去的静态proof可满足选站前提，仍不等于本次采集成功。P中的6站具有适配契约/模板，但近期正文proof不足。L中的10站存在已确认输出路径缺口。T是47个身份目录候选，不能用主页探测代替招聘适配测试。K/S/D/B的配置与登录前提均未读取，不能提前写为当前缺失或当前已登录。

|provider|站点|ready|candidate|目录近期正文proof|分类|
|---|---:|---:|---:|---:|---|
|boss|1|0|1|0|B:1|
|chenyun|1|0|1|0|L:1|
|douyin|1|0|1|0|D:1|
|greenhouse|1|1|0|1|A:1|
|jiuyeqiao|1|0|1|0|L:1|
|ncss|1|1|0|1|A:1|
|nowcoder|1|0|1|0|P:1|
|official-announcements|54|6|48|6|T:47, P:1, A:6|
|searchapi|1|0|1|0|K:1|
|shixiseng|1|0|1|0|P:1|
|smartrecruiters|1|1|0|1|A:1|
|tencent|1|1|0|1|A:1|
|university|8|0|8|0|L:8|
|university-91job|21|20|1|20|A:20, P:1|
|wechat|1|0|1|0|S:1|
|weibo|1|0|1|0|S:1|
|yingjiesheng|1|0|1|0|P:1|
|zhaopin|1|0|1|0|P:1|

### 7.2 每站清单

|siteId|provider|公开机构/来源名|目录状态|前提类|补充结构前提|下一步|
|---|---|---|---|---|---|---|
|tencent|tencent|腾讯|ready|A|公开origin存在|已有近期正文proof；仍需首页面|
|bosch|smartrecruiters|博世|ready|A|tenant已配置|已有近期正文proof；仍需首页面|
|huawei|official-announcements|华为|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|xiaomi|official-announcements|小米|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|alibaba|official-announcements|阿里巴巴|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|bytedance|official-announcements|字节跳动|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|meituan|official-announcements|美团|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|boc|official-announcements|中国银行|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|siemens|official-announcements|西门子|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|pep|official-announcements|人民教育出版社|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|canonical|greenhouse|Canonical|ready|A|tenant已配置|已有近期正文proof；仍需首页面|
|official-d80ddfbc91795a1f|official-announcements|浙江省机场集团有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-0201d47ae30267a0|official-announcements|首都机场集团有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-6287138bc37ffc8f|official-announcements|上海机场（集团）有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-9aeb2a4e0945a569|official-announcements|安徽民航机场集团有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-6ac179a3da59fd41|official-announcements|西部机场集团有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-5cf1fdcffbefdbb8|official-announcements|深圳市机场（集团）有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-843b1604cafcb902|official-announcements|河北机场管理集团有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-98e523ac3d6df982|official-announcements|吉林省民航机场集团有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-a66eb97f865de2d4|official-announcements|黑龙江省机场管理集团有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-2ea9828ffe1d2682|official-announcements|杭州萧山国际机场有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-51cdee56f15fe265|official-announcements|宁波机场集团有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-1144ced905f90a21|official-announcements|温州机场集团有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-b7aabd80bf014855|official-announcements|北京首都国际机场股份有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-7ed2e288d479fe18|official-announcements|北京大兴国际机场|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-807db73ad3e455c7|official-announcements|天津滨海国际机场|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-54e22423ae1a84f6|official-announcements|广州白云国际机场股份有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-6b46f820a4230948|official-announcements|北京博维航空设施管理有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-44a18b57363f3e9b|official-announcements|首都机场集团设备运维管理有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-7a4fcb52ac0a6cf0|official-announcements|北京首都机场动力能源有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-d8753ce7e1144804|official-announcements|北京空港航空地面服务有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-958ccbf7b24ae0d3|official-announcements|中国中安消防安全工程有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-99682b3bd69abd1e|official-announcements|中安建设安装集团有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-8e5c42fc4339931d|official-announcements|上海盛安建设工程（集团）有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-7ac6546c836dc43a|official-announcements|威特龙消防安全集团股份公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-88d3a0778a93df9b|official-announcements|四川威特龙消防技术服务有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-00d8581315f61503|official-announcements|南京消防器材股份有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-d24d82679eb1f075|official-announcements|国安达股份有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-9b7b3076410fcacc|official-announcements|海湾安全技术有限公司（GST）|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-baf4120af7e0ab9a|official-announcements|青鸟消防|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-319f754152cd8c96|official-announcements|泰和安（中消云·泰和安集团）|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-4021f5c8714701d8|official-announcements|四川久远智能消防设备有限责任公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-31de7f85e7b969ae|official-announcements|北京利达华信电子股份有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-1a674871278e30fe|official-announcements|深圳市赋安安全系统有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-a64ede1720adf4fa|official-announcements|中集天达控股有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-67e793bd77fd95b3|official-announcements|中建安装集团有限公司|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|boss|boss|Boss直聘|candidate|B|需每版本独立登录及活动上下文|该版本登录/readBoss未核查|
|zhaopin|zhaopin|智联招聘|candidate|P|公开origin存在|无近期正文proof；先做契约探针|
|shixiseng|shixiseng|实习僧|candidate|P|公开origin存在|无近期正文proof；先做契约探针|
|nowcoder|nowcoder|牛客校招|candidate|P|公开origin存在|无近期正文proof；先做契约探针|
|jiuyeqiao|jiuyeqiao|就业桥|candidate|L|公开origin存在|maxDetail=0输出缺口；先确认修复|
|ncss|ncss|国家大学生就业服务平台|ready|A|公开origin存在|已有近期正文proof；仍需首页面|
|yingjiesheng|yingjiesheng|应届生截止日期榜|candidate|P|公开origin存在|无近期正文proof；先做契约探针|
|searchapi|searchapi|全网搜索|candidate|K|搜索服务配置/费用前提|搜索配置及费用契约未核查|
|wechat|wechat|微信公众号线索|candidate|S|需公开种子或指定账号；只核查布尔可用性|公开种子/readService未核查|
|weibo|weibo|微博招聘线索|candidate|S|需公开种子或指定账号；只核查布尔可用性|公开种子/readService未核查|
|douyin|douyin|抖音招聘线索|candidate|D|搜索服务配置/费用前提|仅搜索发现；正文不可测|
|official-guizhou-airport|official-announcements|贵州民航集团招聘公告|candidate|P|list/link/body模板已配置|无近期正文proof；先做契约探针|
|public-ict|official-announcements|中国科学院计算技术研究所|ready|A|list/link/body模板已配置|已有近期正文proof；仍需首页面|
|public-iscas|official-announcements|中国科学院软件研究所|ready|A|list/link/body模板已配置|已有近期正文proof；仍需首页面|
|public-iop|official-announcements|中国科学院物理研究所|ready|A|list/link/body模板已配置|已有近期正文proof；仍需首页面|
|public-gibh|official-announcements|中国科学院广州生物医药与健康研究院|ready|A|list/link/body模板已配置|已有近期正文proof；仍需首页面|
|public-las|official-announcements|中国科学院文献情报中心|ready|A|list/link/body模板已配置|已有近期正文proof；仍需首页面|
|public-ipe|official-announcements|中国科学院过程工程研究所|ready|A|list/link/body模板已配置|已有近期正文proof；仍需首页面|
|university-job.xidian.edu.cn|university|西安电子科技大学|candidate|L|公开origin存在|maxDetail=0输出缺口；先确认修复|
|university-job.neuq.edu.cn|university|东北大学秦皇岛分校|candidate|L|公开origin存在|maxDetail=0输出缺口；先确认修复|
|university-myjob.dlmu.edu.cn|university|大连海事大学|candidate|L|公开origin存在|maxDetail=0输出缺口；先确认修复|
|university-job.sdufe.edu.cn|university|山东财经大学|candidate|L|公开origin存在|maxDetail=0输出缺口；先确认修复|
|university-career.zjnu.edu.cn|university|浙江师范大学|candidate|L|公开origin存在|maxDetail=0输出缺口；先确认修复|
|university-jy.xmu.edu.cn|university|厦门大学|candidate|L|公开origin存在|maxDetail=0输出缺口；先确认修复|
|university-job.zzu.edu.cn|university|郑州大学|candidate|L|公开origin存在|maxDetail=0输出缺口；先确认修复|
|university-job.zjxu.edu.cn|university|嘉兴大学|candidate|L|公开origin存在|maxDetail=0输出缺口；先确认修复|
|chenyun-cafuc|chenyun|中国民用航空飞行学院|candidate|L|公开origin存在|maxDetail=0输出缺口；先确认修复|
|91job-seu|university-91job|东南大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-hhu|university-91job|河海大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-nuaa|university-91job|南京航空航天大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-njust|university-91job|南京理工大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-njau|university-91job|南京农业大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-njnu|university-91job|南京师范大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-njtech|university-91job|南京工业大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-njupt|university-91job|南京邮电大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-nuist|university-91job|南京信息工程大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-njfu|university-91job|南京林业大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-cpu|university-91job|中国药科大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-njmu|university-91job|南京医科大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-njucm|university-91job|南京中医药大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-njue|university-91job|南京财经大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-nau|university-91job|南京审计大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-suda|university-91job|苏州大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-cczu|university-91job|常州大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-jiangnan|university-91job|江南大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-ujs|university-91job|江苏大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|91job-yzu|university-91job|扬州大学|ready|A|五位学校tenant已配置|已有近期正文proof；仍需首页面|
|official-nju|official-announcements|南京大学|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-85f26b75dd32196a|official-announcements|中国人民警察大学|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-c738f71905918585|official-announcements|河南理工大学|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-92038145590ecfba|official-announcements|西安科技大学|candidate|T|采集模板不足|缺listUrl/linkRule/bodyRule|
|official-5e6e62b1f6776968|university-91job|中国矿业大学|candidate|P|五位学校tenant已配置|无近期正文proof；先做契约探针|

### 7.3 目录指纹

|公开配置文件|记录数|SHA256|
|---|---:|---|
|src/sources/catalog/employers.json|46|1a8f0f9a5bd6a86ea7bd4279fc30ed1b6c57b9473e0a14d424bac896dfbc6c6c|
|src/sources/catalog/platforms.json|11|8f9dce95846f98adedeb569827348bc1fdd32948107c3eb18b8034131eaabb01|
|src/sources/catalog/public-notices.json|7|748efc8c245d6198d1e2be206016658531b01b348c6703ed3e2c97718167797a|
|src/sources/catalog/universities.json|34|1522589e6c8999944a8204cc3fc1657f52a9862436fad3cfa2c543a7ffe4d8a0|

### 7.4 本次只读核查依据

公开目录四个JSON；src/sources/registry.mjs、planning.mjs、source-quality.mjs、collection-page.mjs；相关provider适配器；src/application/collection-service.mjs及collection-ledger.mjs；src/domain/recruitment-evidence.mjs；public/js/validation-rules.js；tools/probe-sources-v2.mjs。旧适配器输出路径同时对照此前source-attachment-audit报告及本次仍存在的maxDetail=0调用。没有执行collect/probe/fetchDetail或真实来源请求。
