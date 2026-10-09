# 招聘扩源实效改进与 Boss 接入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已选择当前会话执行，沿用 executing-plans，不重新询问执行方式。

**Goal:** 将已核实的 Boss 网页读取契约接入逐版本工作台，提高现有渠道正文与投递证据覆盖，并建立可复核的质量统计和最小提示词治理。

**Architecture:** 复用现有 Electron 会话、受控出站、持久根活动和证据领域服务；新增固定 Boss JSON 操作，不调用全局 SDK。三个模块可独立验证：Boss 受控采集（任务1–4）、来源与质量（任务5–7）、提示词契约（任务8），在任务9统一实测与交付。

**Tech Stack:** Node20 ESM、Electron、React/TypeScript、shadcn、现有 JSON 工作区、内置 Scrapling/Chromium/OCR；Agent-Reach/MCP仅作为开发核验工具，不成为个人绝对路径发行依赖。

**Spec:** `docs/superpowers/specs/2026-10-10-source-effectiveness-and-boss-design.md`，用户2026-10-10已通过。

## Global Constraints

- 每个目标版本使用独立 Boss 窗口和登录材料，首次自行登录；不得复用外部全局 contexts[0]、session.enc 或日常浏览器。
- 同一根活动累计网络/详情/附件/模型预算不重置；DeepSeek v4.1 模型费用最多10元。继续使用项目已配置的模型身份和价格快照，实验不得单独再建10元额度。
- 资格缺证据保留未知，AI高分不能覆盖不符或缺证据；全版本去重逐版本处理；回收与永久删除覆盖子集。
- Boss 搜索仅固定 POST 表单，JD仅固定 GET；账户/环境风险立即停止该会话，不自动刷新、认证、重试、换窗口或后端。
- securityId/lid仅当前读取内存使用，不写日志、备份或长期游标；日志无凭据、参数值、正文、简历和私人路径。
- 详情连续自动补抓最多3次；服务器等待不可手动绕过；平台招聘观察不超过72小时才标已核验。
- 平台code0不证明招聘中；communication不等于apply。现有推荐门槛保持正文、开放、投递、资格分别通过且无冲突。
- UI改动使用已有shadcn组件和UI UX Pro Max指导；不重做九页导航。只读来源探针不能发送简历、联系或申请。
- 保留当前托管工作树和桌面路径；更新原PR1，不自行合并，不关机。实际平台受限时交付可复查原因，不称线上成功。

## Review Focus

1. 相同平台两版本同时读、归档后迟到结果：任务2–4测试只影响所属版本，旧epoch拒绝写入。
2. 页面主环境丢失、beforeSend缺失、XHR变成Fetch：任务1–2拒绝未知协议，不重发或扩大路径许可。
3. HTTP200空正文、截止字段只在正文、跨岗位共用日期：任务5测试不重复消耗，不误核验过期入口，不串条件。
4. Boss只有立即沟通、账号所在地或过时active：任务1/6保留投递和工作城市未知，72小时过期观察失效。
5. 黄金集回放全绿但模型未调用、费用中途耗尽：任务8–9分别报告契约/真实模型指标，停止后保留余额和历史消耗。

## 文件与接口边界

复用 `Scope={packageId,targetRevisionId}`、`ActivityRef={scope,activityId}`、`CommitToken={epoch,expectedRevision,sliceRunId}`。不新增全局个人岗位库或第二套预算模型。

新增纯协议文件 `src/sources/boss/protocol.mjs` 负责请求和业务响应；`src/sources/boss/records.mjs` 负责岗位与安全白名单映射；`electron/collection/boss-page.mjs` 仅生成固定页内Ajax代码和解析受限输出。浏览器生命周期继续属于 `browser.mjs`，持久会话继续属于 `sessions.mjs`。

质量投影新增 `src/domain/collection-quality.mjs`；提示词新增 `src/llm/prompt-registry.mjs`。沿用原字段校验、资格门槛、缓存和eval工具，不引入平行通用爬虫或评测服务。

验证命令中的 `$taskNode` 在PowerShell设为项目 `.cache/node20-runtime/node-v20.20.2-win-x64/node.exe` 的绝对路径。回归使用合成资料与网络guard；sandbox出现已知atomic rename/Vite EPERM时按当前授权使用提权测试，不读真实资料。

## 原方案修复基线（进入本计划前已实施）

`collection-service.mjs`、`shared.mjs`、`content-queue.mjs` 已修复投递环路、不可重试入队、补抓旧失败标志和队列饥饿；审阅边界补投递前正文截止/冲突准备和空详情错误提示。`collection-quality-recovery.test.mjs` 5项通过；完整后端744/744、React76/76。此处不重复实施。

---

### Task 1: Boss固定协议、字段映射与路由许可

**Files:** Create `src/sources/boss/protocol.mjs`, `src/sources/boss/records.mjs`; modify `electron/collection/network-policy.mjs`; test `tests/unit/boss-protocol.test.mjs`, `tests/unit/collection-browser-policy.test.mjs`.

**Interfaces:** `buildBossOperation({kind,query,city,page,pageSize,securityId,lid}) -> {kind,method,url,parameters}`；`parseBossResponse({kind,status,payload,checkedAt}) -> {status,records?,hasMore?,detail?,code?}`；`mapBossJob(raw,{site,checkedAt}) -> {record,readRef?}`。`kind`仅`boss.search|boss.detail`。`readRef`是临时`{securityId,lid}`，单独返回，record无该字段。

- [ ] **Step 1 — RED测试：** 搜索固定POST、scene=1、pageSize默认15/最大30、page整数1–20；拒绝未知字段/方法/主机/路径。JD GET仅securityId/lid且长度限制。code0合法结构可解析；code37区分已核实认证语义，风险/未知响应阻塞。身份用公开岗位ID/详情URL，映射不包含安全标识；账号城市不能生成工作城市。communication对应application unknown，active超过72小时不可verified。
- [ ] **Step 2 — 验证RED：** `& $taskNode tools/test-v2.mjs --file tests/unit/boss-protocol.test.mjs`；预期失败于缺少接口或相应断言，而非环境错误。
- [ ] **Step 3 — 实现：** 固定search/joblist.json和job/card.json；`platformPolicy('boss')`仅登记经公开页面核对的必要精确主机/资源路径。Boss的所有wapi请求不论xhr、fetch、image都只准当前操作对应读取路径；仅人工认证必要接口另列，仍拒绝联系/投递写入。现有wechat/weibo方法许可不扩大。平台状态记录独立platformEvidence，不修改现有推荐门槛。
- [ ] **Step 4 — GREEN：** 上述测试及`collection-browser-policy.test.mjs`通过；HTTP200与code0都不能跳过结构验证。
- [ ] **Step 5 — 提交：** `feat: add constrained Boss read protocol`，仅本任务文件。

### Task 2: 受控JSON浏览器读取、计量和取消

**Files:** Create `electron/collection/boss-page.mjs`; modify `electron/collection/browser.mjs`, `src/application/content-read-service.mjs`; test `tests/integration/boss-browser.test.mjs`, `tests/helpers/collection-browser-fixture.mjs`.

**Interfaces:** `browser.readBoss({ref,token,operationLease,signal,sessionRef,operation}) -> {status,payload,checkedAt,usage}`；`readService.readBoss(input)`只委托此方法，没有HTTP/匿名后端降级。复用任务1固定operation；每次调用全局并发≤2、同session串行。

- [ ] **Step 1 — RED测试：** 两版本不同partition；远程无Node/bridge/preload；原页主环境Ajax使用自身beforeSend；缺钩子明确不可用。初始导航/每个资源/搜索/JD/重定向发送前均有账本预约，预算0不得发请求，未知消耗保留上界。取消调用abort、停止许可、销毁/排空窗口；迟到响应不返回可写结果。上下文销毁只失败一次，无隐含重发。
- [ ] **Step 2 — RED命令：** `& $taskNode tools/test-v2.mjs --file tests/integration/boss-browser.test.mjs`。
- [ ] **Step 3 — 实现：** 页内仅执行固定模板和已校验参数，保存操作专属abort句柄。读取业务JSON最大6MiB、单次45秒；沿用20MiB网络字节预约和2并发。原代理/webRequest在每次真实发送前许可，provider不再另计同一物理请求；JD详情额在provider调用前计一次。任何失败均清理监听、资源与permit。
- [ ] **Step 4 — GREEN：** 专项与`collection-egress.test.mjs`通过；观察实际发送数≤已预约上界，零预算/取消后发送数不增加。
- [ ] **Step 5 — 提交：** `feat: read Boss JSON through owned collection browser`。

### Task 3: 登录归属、持久风险闩锁与清理

**Files:** Modify `electron/collection/sessions.mjs`, `electron/collection/browser.mjs`, `electron/collection/ipc.mjs`, `electron/preload.cjs`, `ui/src/lib/desktop.ts`, `ui/src/lib/types.ts`; test `tests/integration/boss-session-risk.test.mjs`, `tests/unit/collection-ipc.test.mjs`, `tests/integration/collection-session-cleanup.test.mjs`.

**Interfaces:** 扩展`create/get/saveMaterial/readMaterial/setState/clear`平台boss；新增`setRisk({scope,sessionRef,code,checkedAt})`、`clearRisk({scope,sessionRef,verification})`、`getStatus({scope,sessionRef}) -> {state,riskBlocked,code?,checkedAt?}`。`riskBlocked`与认证state独立。UI仅发送scope/sessionRef/固定操作，不获得登录材料。

- [ ] **Step 1 — RED测试：** 风险跨重启仍阻止所有本会话列表/JD；其他版本不受影响；普通resume和认证刷新不解除风险。错误scope清理/解除失败；安全存储不可用只能内存登录。版本回收/删除/恢复备份和72小时清理撤销引用，旧会话不复活；普通GET状态不读取或输出凭据。
- [ ] **Step 2 — RED命令：** `& $taskNode tools/test-v2.mjs --file tests/integration/boss-session-risk.test.mjs`。
- [ ] **Step 3 — 实现：** 持久白名单风险元数据与加密材料分开保存；沿用现有非persist partition，只在同版本运行期复用，重启从该版本加密材料恢复，不能跨版本共享。只读探针成功仅证明协议；用户明确解除动作+同会话新探针才清闩锁。所有权撤销与closePackage/stop排空继续用原生命周期。
- [ ] **Step 4 — GREEN：** 新专项、IPC和session-cleanup通过；真实cookie/token及个人工具路径未出现在返回值/日志/备份中。
- [ ] **Step 5 — 提交：** `feat: isolate Boss login and persist risk stops`。

### Task 4: Boss provider、累计探针与来源操作

**Files:** Create `src/sources/adapters/boss.mjs`; modify `src/sources/registry.mjs`, `src/sources/catalog/platforms.json`, `src/sources/planning.mjs`, `src/application/collection-service.mjs`, `electron/collection/ipc.mjs`, `ui/src/features/sources/SourcesPage.tsx`; test `tests/integration/boss-collection.test.mjs`, `tests/ui/social-sessions.test.tsx`.

**Interfaces:** provider沿用`collectPage(ctx)`、`fetchDetail(record,ctx)`、`probe(ctx)`；临时readRef放版本/会话/活动epoch内存Map，公开身份作为键。新增内部`withDiagnosticContext({ref,requestId},callback)`复用原账本/lease/token/取消；暂停活动可启动独立诊断片段，运行活动沿用`withActivityContext`。仅可信IPC的固定Boss探针、任务8开发工具可调用，不公开通用callback/脚本接口。

- [ ] **Step 1 — RED测试：** 两页原子提交及重启续页不重置预算；分页游标无query文本以外私人数据、无安全标识；重启详情先重取临时引用并计费。风险使同session所有单元waiting_for_auth/risk_blocked，自动刷新跳过；普通continue不解除。暂停时探针保留同根预算并可取消；completed/cancelled活动不被探针复活。
- [ ] **Step 2 — RED命令：** `& $taskNode tools/test-v2.mjs --file tests/integration/boss-collection.test.mjs`；UI用`tools/test-ui.mjs --file tests/ui/social-sessions.test.tsx`。
- [ ] **Step 3 — 实现：** providerId/siteId为boss，目录初始candidate，能力未线上核实不标ready。record仅保存数字discoveryPage；重启补抓通过pending的原unit/query重新读取该页，取得同公开岗位ID的临时readRef并计费，若该页已无该岗位返回read_ref_missing/需人工复核，不自动遍历多页追踪。采用任务1–3接口；source page按当前版本显示未登录/已核验/认证过期/风险阻塞，提供独立登录、探针、清除材料、明确解除按钮。需要人工首次登录时保留任务状态，不阻塞其他来源；每个成功/失败操作有反馈。
- [ ] **Step 4 — GREEN：** 上述专项以及原activity/ledger/lifecycle通过，探针消耗与采集消耗同根累加；账号窗口存在不能当登录验证通过。
- [ ] **Step 5 — 提交：** `feat: collect Boss pages in version-owned activities`。

### Task 5: 现有正文、投递入口与可恢复补抓

**Files:** Modify `src/sources/adapters/ncss.mjs`, `src/sources/adapters/official-announcements.mjs`, `src/sources/adapters/shared.mjs`, `src/sources/catalog/public-notices.json`, `src/application/collection-service.mjs`, `src/application/collection-refresh.mjs`, `src/application/job-verification-service.mjs`, `src/sources/content-queue.mjs`, `src/domain/recruitment-evidence.mjs`; create `tests/fixtures/recruitment-details/`公开精简HTML样本及`tests/integration/source-evidence-completion.test.mjs`; extend`tests/integration/ncss-notice-detail.test.mjs`。

**Interfaces:** `extractApplicationLinks(html,{baseUrl,record}) -> {applyUrl,sourceEvidence}`归入`src/sources/adapters/shared.mjs`，仅提取明确申请/报名语义的公共URL；验证码/登录/导航不是可用投递证明。新增纯函数`prepareApplicationCheck(record,now) -> {evidence,shouldRequest,applyUrl}`于`src/domain/recruitment-evidence.mjs`，对克隆记录准备截止/冲突，复用原门槛。内部`enrichRecord`用于列表、重试和公告展开，人工核验服务复用该纯函数；不引入跨服务循环依赖或第二套推荐判定。

- [ ] **Step 1 — RED测试：** NCSS真实结构精简样本恢复正文和明确报名URL，发布时间不当截止。贵州公告样本需选中正文，拟聘公示保持历史。公告拆出的合法岗位实际发只读入口核验；跨岗位截止/资格仍拒绝。人工核验先准备正文截止/冲突，再决定请求。自动正文到期即使列表完成仍会被调度，3次失败停止，第4次自动请求0；手动显式重检仍尊重服务器等待和原预算。
- [ ] **Step 2 — RED命令：** `& $taskNode tools/test-v2.mjs --file tests/integration/source-evidence-completion.test.mjs`。
- [ ] **Step 3 — 实现：** 从对应官网原页保存去掉个人信息的最小结构fixture与公开出处；不能按猜测添加选择器。展开岗位依次经过原准备/核验，再批量原子入库。pendingBodies新增`automaticAttempts`，自动失败增加、成功清零；旧attempts仅作总尝试显示，未知旧自动次数从0起。max3后状态needs_review，refresh只看可重试、到期且未风险阻塞项；错误详情保留安全issue，不重复写正文观察。
- [ ] **Step 4 — GREEN：** 专项与原article-evidence/body-recovery/Retry-After相关测试通过；缺正文、登录页或历史数据不进入已核实推荐。
- [ ] **Step 5 — 提交：** `fix: complete recruitment body and application evidence`。

### Task 6: 活动质量投影与清楚的状态界面

**Files:** Create `src/domain/collection-quality.mjs`; modify `src/application/collection-service.mjs`, `ui/src/features/workbench/CollectionProgress.tsx`, `ui/src/features/jobs/RecruitmentEvidence.tsx`, `ui/src/lib/types.ts`; test `tests/integration/collection-quality.test.mjs`, `tests/ui/collection-workbench.test.tsx`。

**Interfaces:** `projectCollectionQuality(workspace,{root,now}) -> {uniqueRecords,bodyVerified,open,applicationAvailable,qualificationPass,qualificationUnknown,qualificationFail,historicalOrExpired,suspectedDuplicates,validNewUnique,knownRequests,unknownRequestUpperBound,validPer100KnownRequests}`。同一版本事实选择与匹配评价沿用`selectVersionJobFact/selectMatchingEvaluation`；活动集合用root的newJobIds，不拿全局canonical替代。

- [ ] **Step 1 — RED测试：** 两版本同岗位不同事实/评价各自统计；正文通过但投递未知不计有效；历史与待核验可重叠不相加；零分母比率null；未知请求上界单列。UI显示expired=已过期、invalid=入口失效；只有communication时投递待核验、平台观察单独展示，旧active过72小时待复核。
- [ ] **Step 2 — RED命令：** `& $taskNode tools/test-v2.mjs --file tests/integration/collection-quality.test.mjs`；`tools/test-ui.mjs --file tests/ui/collection-workbench.test.tsx`。
- [ ] **Step 3 — 实现：** 纯投影从事实重算，不持久占位DQS；活动API增加quality，不改变旧metrics字段语义。每个比率同时显示分子/分母，未测召回率/误合并率显示未测量。利用现有卡片/证据组件展示失败原因与平台观察，不改推荐门槛。
- [ ] **Step 4 — GREEN：** 专项与UI通过；TypeScript无错误；静态统计不触发网络或模型。
- [ ] **Step 5 — 提交：** `feat: show measured collection quality and evidence gaps`。

### Task 7: 来源发现与公众号/微博实测入口

**Files:** Modify `tools/discover-recruitment-sources.mjs`, `tools/pilot-recruitment-coverage.mjs`, `src/sources/discovery.mjs`（仅必要导入校验）；test `tests/integration/source-discovery.test.mjs`；新增 `docs/reports/2026-10-10-source-effectiveness-validation.md`。

**Interfaces:** 开发工具接受`--public-seeds <json>`，每项仅`institutionName,homepage,evidenceUrl,channel`；复用`discoverSourceCandidates({seed,request,signal,maxDepth:2,maxUrls:100})`。结果依旧candidate/verifiedAt:null，经现有正文探针才能启用。无需新的产品搜索API或自动同步用户级工具。

- [ ] **Step 1 — RED测试：** 私网/私人链接/凭据或签名参数拒绝；搜索摘要仅线索，归档非仍在招证据；已安装工具不将来源置ready。社交未登录、受限与完整正文结果分别报告，不用合成页面替代真实验收。
- [ ] **Step 2 — RED命令：** `& $taskNode tools/test-v2.mjs --file tests/integration/source-discovery.test.mjs`。
- [ ] **Step 3 — 实现：** Agent-Reach公开搜索/RSS供开发者提供公开机构/消防企业/机场入口，回原站核对，结果进入现有候选配置流程。公众号/微博沿用现有逐版本窗口、可信账号和链接队列；人工扫码可用时小样本验证列表/全文/附件，否则记录限制和待用户登录。Jina只作补充线索，不外发私密链接或画像。
- [ ] **Step 4 — GREEN：** fixture通过后用任务9的同一验收根活动公开样本实测；只对近期成功正文探针标已验证，未成功仍保持候选。
- [ ] **Step 5 — 提交：** `feat: import verified public recruitment discovery seeds`。

### Task 8: 最小提示词注册表、缓存版本与24例黄金集

**Files:** Create `src/llm/prompt-registry.mjs`, `evals/fixtures/prompt-goldens.json`, `tests/integration/prompt-goldens.test.mjs`; modify `src/llm/prompts.mjs`, `src/llm/validation.mjs`, `src/match/article.mjs`, `src/application/evaluation-service.mjs`, `src/application/collection-service.mjs`, `src/sources/content-queue.mjs`, `tools/eval-matching.mjs`。

**Interfaces:** `getPromptDefinition(promptId,{version}={}) -> {promptId,promptVersion,schemaVersion,parserVersion,parameters,state,previousVersion?}`；`renderPrompt(promptId,input,{version}={}) -> {system,user}`，ID仅matching/article，version只接受已登记版本，默认active。保留`evaluationPrompt(profile,records)`兼容出口。evaluationCacheKey新增schemaVersion；文章缓存键包含prompt/schema/parser/modelFingerprint/bodyHash。`runGoldenValidation({mode,fixtures,modelFactory,budget,signal})`放现有eval工具，用CLI入口guard保证测试导入不启动执行；live预算只取任务4同根诊断上下文，不自行创建ModelBudget。

- [ ] **Step 1 — RED测试：** 24例分六组×4：匹配事实与资格、输出结构、证据与注入、文章正常多岗位、未知/非招聘、文章字段归属与注入。覆盖必需/优先/未知证书、城市/截止归属、投递/登录/验证码、截断正文、重复/漏ID/编造引文。至少4合法正例能产出岗位，危险负例不能被推荐。改变prompt/schema/model任一使对应旧缓存失效，原版可回退；隐私画像不进载荷；零余额transport调用0。
- [ ] **Step 2 — RED命令：** `& $taskNode tools/test-v2.mjs --file tests/integration/prompt-goldens.test.mjs`。
- [ ] **Step 3 — 实现：** 把现有两套固定提示词移入注册表并保持行为，不在搬迁时改变抽取策略。同步缓存读写/持久元数据所有分支，parser版本不冒充prompt版本。离线rawResponse回放只证明校验/降级；报告`mode:offline-contract`，模型质量设not_measured。真实模型另测结构100%、危险误推荐0、关键字段/分类≥95%、合法正例非零；余额不足立即保存incomplete，不新建额度补样本。
- [ ] **Step 4 — GREEN：** 24契约样例、原evaluation/model-evidence/privacy/budget相关测试通过。真实模型满足指标才标候选prompt已验证；未配置密钥或没余额如实列未测，不把离线24/24当模型准确率。
- [ ] **Step 5 — 提交：** `feat: version recruitment prompts and add golden contracts`。

### Task 9: 真实小样本、成品与原PR交付

**Files:** Modify `tools/pilot-recruitment-coverage.mjs`, `electron/self-test.mjs`, `tools/verify-package.mjs`（仅新增文件闭包检查）、`docs/reports/2026-10-10-source-effectiveness-validation.md`, `docs/IMPLEMENTATION-DECISIONS.md`。

**Interfaces:** 使用一个合成通用消防/机场目标的持久验收根活动ref；网络上限180、详情80、每查询2页、模型最高10元，原额度不足可减少样本不重开活动。Boss两页与至少1份JD；NCSS/官方正文各至少1份；社交有登录再验证。报告区分原根消耗/本次增量/未知上界以及个人符合数量与通用合成验证。

- [ ] **Step 1 — 自动化检查：** 成品合成自检加入双版本Boss固定JSON协议、会话撤销/风险/迟到写入；外网强制关闭。源码与最终ASAR三个新增Boss文件及相关服务逐文件SHA256一致。包中无用户级SDK绝对路径/凭据/真实资料，新增源码在生产闭包中。
- [ ] **Step 2 — 真实验收：** 用户在各版本专用窗口自行登录；小样本核对业务code/原站正文/公开ID及分页、暂停继续同账本，至少一轮实际取消。遇到风险立即停止，不换后端；未登录平台保持blocked。模型live黄金测试共享该根额度；原站对照样本不够时准确率/召回/误合并仍not_measured。
- [ ] **Step 3 — 统一离线与打包：** `& $taskNode tools/run-all-tests.mjs --skip-network`、`& $taskNode node_modules/typescript/bin/tsc -p ui/tsconfig.json --noEmit`、`& $taskNode tools/build-desktop.mjs`、`& $taskNode tools/verify-package.mjs`。必须0失败；外部网络套件跳过与独立包检查实际通过分开记录。
- [ ] **Step 4 — 实际EXE：** `& ./tools/verify-desktop-self-test.ps1 -ExePath './dist/简历岗位雷达-win32-x64/简历岗位雷达.exe' -Scales 1,1.25,1.5`。三独立DPI退出0，外网/渲染/CSP/自动下载0；查看窄窗口证据和来源状态截图。REA仅在成品/协议出现真实问题时做被动诊断，工具可见不等同运行时验证。
- [ ] **Step 5 — 审查与交付：** 一次限定本补充范围的独立代码审阅，修复具体问题并做对应RED→GREEN；不重复上一轮整分支审阅。原PR1更新并等待同一最终提交CI成功；发布可点击EXE/验证报告。目录整体保留，回收和恢复规则未通过不能交付。

## 自审记录与执行交接

设计1–3对应约束/基线与任务1–4；设计4–5对应协议、材料、风险与预算；设计6对应任务5/7；设计7对应任务5/6；设计8对应任务8；设计9对应任务4/6/9。Review Focus五项都有明确测试。接口名、状态与字段统一，新增诊断上下文只供固定内部操作；真实模型与合成回放不能互称成功。

用户已选择当前会话。计划审阅通过后按任务顺序实施；任务5–8可在稳定接口后独立推进，公共collection-service由主执行者统一接线，避免并行覆盖。每任务保存具体决策/偏离/验证；有平台登录或环境限制时完成不依赖它的工作，并明确未达标验收。
