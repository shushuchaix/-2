# 真实首批样本：证据缺口只读审计

日期：2026-10-10。审计时点为源码正在继续改造期间；以下行号指初次审计时的工作树。初次审计未修改产品代码；之后授权的修复与验收另列于末节。

## 范围与结论

输入仅为[首批实测报告](2026-10-10-actual-source-validation.md)、[脱敏矩阵](2026-10-10-source-validation-matrix.json)和生产源码。复现使用内存中的合成单位、岗位、响应及画像；真实网络调用、模型调用、日常工作区读取均为 **0**。

213条新增记录中，14条具有当前门槛认可的正文证据，199条未达到该门槛。每站最多一份详情，16次详情中14次形成正文证据、两次失败；其余197条没有被此次详情抽样选中。因此不能把199条未核实正文都解释为采集器故障，也不能把213条记录称为可投递岗位。

除采样限制外，确认了会阻碍后续补全的状态及映射缺口。现有“正文、在招、投递、资格四项同时通过”的推荐门槛应保持。不能因正文非空、来源为高校、模型抽取成功，直接视为完整岗位或合格校园招聘。

未计算综合DQS：当前材料缺少行级来源事实、真实时效及资格失败原因分布；用聚合计数打一个综合质量分会掩盖这些限制。

## 实测统计应如何解释

| 现象 | 已确认解释 | 不可据此下的结论 |
| --- | --- | --- |
| body 14 / 213 | 正文核实率6.57%；当前抽样只选16条详情 | 199条原站均没有正文 |
| application 0 | 首批诊断工具没有调用生产 record-enrichment；大学、91job另有入口映射缺口 | 原站全部没有投递入口或验证器全部失败 |
| qualification pass 0 / unknown 137 / fail 76 | 未知占64.32%，不符占35.68%；公告、缺正文、岗位类型缺证均可产生未知 | 76次不符都错误，或实际没有符合用户条件的岗位 |
| pendingBodies 0 | 队列仅识别 bodyStatus/retryEligible，不能覆盖本批缺标记记录 | 所有正文已经抓完，或没有待补全工作 |
| 来源 blocked 78 | 28预算、47模板、1独立登录、2外部费用；没有实际执行的来源仍未验收 | NCSS、公众号、微博、Boss等线上已经通过 |

76次不符的逐项原因不在公开矩阵内。本次未读取私人评价记录，故不推断其具体学历、届别、证书或岗位类型原因。后续可增加脱敏的 `qualificationReasonCounts`，仅保存条件类型与状态计数。

## 已复现问题

### E01：长API正文跳过补抓，却没有正文证据和待补队列

**置信度：合成复现确认；真实受影响条数未测。优先级P1。**

91job 的 [parse](../../src/sources/adapters/university-91job.mjs)（第75、88–91行）保留 `zwms`，但列表记录没有 `detailStatus/bodyStatus` 或已核实的 description sourceEvidence。[baseRecord](../../src/sources/adapters/shared.mjs)（第108–147行）也不提供这些状态。[生产 execute](../../src/application/collection-service.mjs)（第1243–1248行）仅以文字长度、retryEligible、bodyStatus 判断是否补详情；长于30字符的无状态列表正文跳过详情。[queueContentDraft](../../src/sources/content-queue.mjs)（第95–98行）也不会将其排入 pendingBodies。

复现结果：一个身份、学校代码和业务返回正确、带长 `zwms` 的合成91job列表记录，经 normalize 后 `bodyVerified=false`，生产补抓谓词为false，pendingBodies为0。不是把列表正文判为无效，而是没有一条路径完成它的证据核实。

**最小改进方向：**补抓资格采用统一的证据状态；对具备详情能力的来源，将尚未核实的记录排入所属活动的补正文队列。若决定接受某个API字段为完整正文，需先验证该接口字段语义并保存明确来源证据，不能用“超过30字”替代核验。`capabilities.body=false`的发现线索应保留发现状态，避免永久无效重试。

### E02：缺少 bodyStatus 的列表记录在诊断入库后失去补抓任务

**置信度：合成复现确认。优先级P1。**

大学列表 [toJob](../../src/sources/university.mjs)（第773行）会给 `detailStatus=incomplete`，却没有 bodyStatus；91job列表两种状态均可缺失。首批工具调用 [commitCollectionPage](../../tools/source-validation.mjs)（当前第677行）后，生产提交只执行入库及 queueContentDraft，不自动完成正文或投递核验。

最小复现：`{description:null, detailStatus:'incomplete'}` 入队数量0；只增加 `bodyStatus:'incomplete'` 后数量1。这解释本批 pendingBodies=0 的机制。生产正常 execute 在详情抛错时会设置 bodyStatus/retryEligible，因此不能把这一现象概括成所有正常采集均无队列。

**最小改进方向：**在来源标准化或提交边界集中生成明确证据状态，保持现有风险、认证、失败次数、冷却时间与版本归属。诊断抽样外的记录仍应诚实地显示“未核实/未安排”，而不是“无待办”。

### E03：legacy 成功详情继承旧失败标记，重试无法完成

**置信度：合成复现确认。优先级P1。**

[legacy.fetchDetail](../../src/sources/adapters/legacy.mjs)（第225–233行）将旧记录和新详情直接展开；未像 [shared.fetchDetail](../../src/sources/adapters/shared.mjs)（第424–435行）清除过时 bodyStatus/retryEligible/detailStatus/retryAt/nextDueAt。大学成功详情只更新 detailStatus。

合成响应正文与详情均成功时，返回仍是：

```json
{"detailStatus":"complete","bodyStatus":"incomplete","retryEligible":true}
```

[重试成功提交](../../src/application/collection-service.mjs)（第1145行）要求 `!retryEligible && bodyStatus==='complete'`，因此该记录不会完成成功重试，仍留在pendingBodies。同一矛盾记录又会因 [body门槛](../../src/domain/recruitment-evidence.mjs)（第481–482行）采用 detailStatus/bodyStatus 的“或”关系而被视为 bodyVerified，导致展示与任务状态不一致。

**最小改进方向：**成功详情使用干净输入和一致的成功状态；验证器在显式不完整/限制状态存在时不要接受矛盾的 complete。不能仅删除失败标记而不重新判断实际返回正文、截断和歧义。

### E04：大学详情丢失显式公开投递链接，91job也缺入口抽取

**置信度：大学路径合成复现确认；91job静态调用链确认。优先级P1。**

[大学 fetchDetail](../../src/sources/university.mjs)（第981–991行）将HTML交给正文解析与toJob；HTML中的真实href没有进入applyUrl/sourceEvidence。91job 的HTML格式 `zwms/zpggxq` 则先经 [description](../../src/sources/adapters/university-91job.mjs)（第5–24行）变为纯文本；未调用现有 [extractApplicationLinks](../../src/sources/adapters/shared.mjs)（第6–66行）。baseRecord默认applyUrl为null。

大学合成HTML含 `<a href="/apply/one">在线报名</a>`，详情成功后 `applyUrl=null`。这是“明确入口被丢失”，不是要求从普通详情URL、邮箱、登录按钮或沟通功能推断投递链接。

**最小改进方向：**在丢弃HTML前复用现有公开入口提取器，保留URL与定位证据；多个入口、登录/验证码链接、凭据参数继续保持未知。后续只读检查仍须使用所属活动原预算，不绕过认证和风险停止。

### E05：正文截断后仍标完整，尾部条件与时效可能丢失

**置信度：合成复现确认；真实14条是否截断未测。优先级P1。**

[大学 parseJobDetail](../../src/sources/university.mjs)（第639、644行）截至3000字符；[parseNoticeDetail](../../src/sources/university.mjs)（第739–744行）截至4000字符，之后toJob仅因description非空标complete（第773行），没有保留bodyIncomplete/截断范围。

合成长公告中明确报名截止日期位于尾部；解析结果4001字符（含省略号），截止日期丢失，却 `bodyVerified=true`、`bodyIncomplete=false`。即使公告拆岗分块能够保留长文本尾部，已经在适配层丢掉的尾部无法恢复。

**最小改进方向：**保留有界的完整招聘正文供证据及分块流程使用，summary单独截断；如确需截断，应记录不完整和省略范围并进入可恢复补全流程。不能用模型生成被丢掉的条件。

### E06：91job专业与失效字段没有进入领域证据

**置信度：合成复现和静态调用链确认；真实字段语义仍须核验。优先级P1/P2。**

91job将 `xqzy`、`zwsxrq` 保存到extra（第90–91行）。[专业条件提取](../../src/domain/recruitment-evidence.mjs)（第292–305行）只读顶层major及文字条件；[时效门槛](../../src/domain/recruitment-evidence.mjs)（第511行）只读deadlineAt/deadline，不读extra.sourceExpiry。

合成例设置需求专业“消防工程”，正文没有重复该字段，画像专业“化学工程”：majorChecks=0，qualification可为pass；sourceExpiry有日期但deadlineAt为null。此例是专业条件遗漏，不能据此断言首批出现过错误推荐，实际推荐计数仍为0。

**最小改进方向：**先核验字段是否明确、完整、必需条件及日期语义，保留原值、接口字段和身份核验来源证据。确认的专业条件需进入证据条件；编码、多选、专业大类、非必需要求或歧义仍保留未知。`zwsxrq`可作为来源失效信号，不能未经核验直接等价为报名截止时间，更不能凭未来的失效日期推断仍在招。

## 正确保守行为与未确认部分

- 91job记录默认jobType为unknown。合成情况下目标要求campus会产生资格unknown；不能因信息来自高校而将所有职位改为campus，需正文或明确接口字段证明接受目标届别/岗位类型。
- 招聘公告在未拆出独立岗位前，资格unknown是合理行为；真正的岗位必须保留本岗位条件及共用条件的对应关系。
- [collection-quality](../../src/domain/collection-quality.mjs)依照目标版本事实和本版本画像评价投影，不从其他版本借评价；本次未发现需要放宽此隔离机制的依据。
- [推荐门槛](../../src/domain/recruitment-evidence.mjs)要求资格pass、正文核实、当前在招、投递有效、无证据冲突。首批有效数为0符合当前证据，不能回写为成功。
- 报告没有行级原文或脱敏条件错误计数，不足以确定14条正文的实际招聘有效性、76个fail的具体原因或真实漏失专业数量；这些需后续原预算内或经授权追加实测。

## 建议实施顺序与验收

1. 统一正文证据状态，修复长API正文跳过补抓、legacy成功状态及缺状态队列；以真实使用路径的合成集先确认RED，再修复。
2. 保留完整有界正文、明确入口及结构化字段证据；遇到歧义继续unknown。
3. 让诊断工具在同根账本、lease、token、cancel信号下复用生产 enrichment。每站抽样数、未抽样数、未安排原因与外部阻断分别报告。
4. 新实测采用平台间轮换与相关详情抽样，保留第一批原成绩。未经实际调用的NCSS/社交/Boss来源单独标未验证。

必要的回归应覆盖：长列表body未核实后能补全；失败到成功不继承失败；显式incomplete不能被complete覆盖；长文尾部条件保留；明确入口、模糊入口、登录、captcha分别处理；结构化专业冲突不会pass；来源失效与报名截止不混淆；跨版本无数据或评价借用；取消与预算耗尽后无新请求/迟到写入。

## 复现记录

临时ignored脚本：`.cache/evidence-gap-audit/reproduce.mjs`。仅从生产函数接收合成内存响应，不调用真实fetch，未修改任何产品数据。

```text
Node v20.20.2；exit 0
真实网络 0；模型 0；日常工作区读取 0
长API正文：bodyVerified false / 补抓谓词 false / pendingBodies 0
detailStatus-only：pendingBodies 0；增加bodyStatus=incomplete后为1
legacy成功详情：complete + incomplete + retryEligible true；成功提交谓词false
矛盾状态：body门槛接受 true
显式大学报名anchor：applyUrl null
长公告：4001字符；尾部deadline丢失；bodyVerified true
结构化专业：majorChecks 0；合成不匹配画像qualification pass
来源失效：extra有值；deadlineAt null
目标校园类型：jobType unknown；qualification unknown
```

复现中的预测谓词直接取自对应生产判断；它不等于完整桌面或线上实测。完整产品回归、真实来源重测和成品验证由主任务实施阶段完成。

## 后续来源修复与离线验收

范围限于三个来源文件及新增的 [university-evidence-completion.test.mjs](../../tests/integration/university-evidence-completion.test.mjs)。没有真实网络、模型或简历调用，第一批实测成绩保持原样。

- legacy详情用干净输入复查；成功返回统一complete/retryEligible=false，空正文明确抛detail_insufficient，保留原错误保护及预算预约。
- 大学与91job在HTML转换前复用公开投递入口提取器。唯一明确入口保留定位证据；多入口、占位、登录及凭据参数仍不选URL。
- 大学职位与公告保留受原请求字节上限约束的完整正文；summary仍短。大学parser升级legacy-adapter-3，区别于旧已截断事实。
- 91job文字需求专业形成有xqzy字段、原值、位置与稳定证据ID的条件。多专业可选项、明确不限、优先与编码/相关专业歧义分别处理；重取详情替换原该字段条件，不累计旧条件。
- 91job空详情不能沿用旧列表正文冒充成功。sourceExpiry仍保留原值；语义待官方或实际接口证据确认，没有将其强制映射为deadline，也没有据未来日期判在招。

实施期间观察到并报告一次中间写入括号SyntaxError，随后修正并重新通过语法检查。关联磁盘测试首次在系统Temp遭原子rename EPERM；换为workspace内独立TEMP后成功，未改原子写入产品逻辑、未弱化断言。

最终本专项及必要关联 **65/65** 通过：新增来源13、legacy9、NCSS/91job3、正文投递补全9、未核实正文采集2、诊断enrichment9、资格2、消防机场资格10、正文状态4、专业解析2、社交队列2。三个来源文件node --check及本专项git diff --check均exit 0。

主任务另行修复统一正文证据门槛、长摘要补详情与专业标签冒号，这些变更不由本来源专项修改；必要关联测试覆盖了其兼容性。完整项目gate、最终EXE与真实第二批来源验收仍由主任务完成，65项离线检查不代表这些项目已通过。

## 全量门禁发现的回归与追加专业映射修复

主任务随后运行完整离线门禁，报告902项中898通过、4失败；4项均为91job职位/公告详情省略或留空投递字段后，旧列表applyUrl被新HTML提取结果null清除。原 [source-detail-retention.test.mjs](../../tests/integration/source-detail-retention.test.mjs) 的断言没有修改；本专项独立重跑复现9通过、4失败。

追加5项有实际行为失败的合成测试，修复前为13通过、5失败：既有入口保留、旧入口与新多入口冲突、大学头部专业条件丢失、专业字段40字符截断，以及编码/相关专业/括号限定被漏检查。

- 91job和大学无合法新投递候选时保留既有入口；新唯一候选更新入口，新多个明确候选继续applyUrl=null。占位、登录、非法或含凭据参数的地址不算新候选，不能用旧URL掩盖新正文的多入口歧义。
- 大学需求专业字段不再截为40字符前缀，完整原值进入条件证据。位置明确为HTML转文本后的page_text范围，测试逐字核对该范围等于字段原文；不能声称该位置位于不包含头部的description中。
- 提取小型纯映射模块 [major-evidence.mjs](../../src/sources/major-evidence.mjs)，供大学与91job复用；参数仅字段名称及来源位置元数据。保留91job原有专业证据ID及替换旧同字段条件的机制。明确OR、不限和优先条件按原语义处理，编码、相关专业或括号歧义保持unknown。
- sourceExpiry未改变语义，未据失效日期推断报名截止或当前在招；没有新增真实网络、模型、简历或日常数据访问。

最终必要关联离线检查 **84/84** 通过：入口保留13、新来源证据18、legacy9、NCSS/91job3、正文投递补全9、未核实正文采集2、诊断enrichment9、资格2、消防机场资格10、正文状态5、专业解析2、社交队列2。正文状态第5项为主任务新增的旧公告拆岗截断保护，本专项只验证兼容性。新增模块、三来源文件和本专项测试node --check均无错误，限定文件git diff --check通过。

本追加修复已经冻结，完整门禁、构建、界面验证及真实新批次成绩由主任务单独验收；84项检查不替代上述验收。
