# 实际简历全 98 来源 harness 接口核对

日期：2026-10-10。本文是只读代码研究与执行设计，未创建真实根活动，未读取简历正文、配置文件、凭据文件、会话文件或个人工作区，未发网络/模型请求。前提数据来自同日两份脱敏 preflight 报告及主任务给定的预算约束。

## 1. 固定身份与总额度

- 真实 scope：`packageId=34d0247a-d8ff-4409-bb81-44490ebea75f`，`targetRevisionId=t-9d8103c2-7793-4e4e-b821-20fa06b1d401@1`。
- 自有副本：`copy-34d0247a-d8ff-4409-bb81-44490ebea75f@1`。执行时由服务内部核对副本归属、revisionId、contentHash、active/enabled；使用 target 的 owned `profileSnapshot`，不恢复已回收的 provenance 源版本。
- 合成根 `collection-b10c2e43-bd27-4df8-b350-90c92a2cc234` 必须保留原 scope、副本和账本。其 89/180 请求、33/80 详情不转移、不清零。
- 唯一真实新根的硬上限应为 `maxRequests:91`、`maxDetails:47`、`maxCostCny:6.13`。模型旧费用上界 ¥3.869184 已含不确定费用；`3.869184 + 6.13 = 9.999184`，保守留出 ¥0.000816。`6.130816` 不符合现有采集额度的两位小数验证，不能直接作为 cap。
- 这不是跨根账本合并：现有 ledger 没有“承接另一个根的使用量”API。新根只设置剩余额度，同时保存脱敏 baseline 引用供总预算审计。全部列表探针、详情、附件、投递读取、公开 goldens、公开公告模型拆分共用这一真实根；完成后不得用第二根继续。
- 执行前重新读取用量摘要；若 baseline 已增长，计算更小的剩余 cap。不得因 pending/uncertain 尚未结算而恢复额度，不把 `knownPhysicalRequests` 当 `usedRequests`。

## 2. 已有接口与需要补齐的一处入口

| 入口 | 现有行为 | harness 用法 |
| --- | --- | --- |
| `createApplicationContext({cfg,dataDir,dependencies})` | 打开锁定 repository，bootstrap、恢复、附件清理、回收清理与 scheduler 初始化；还会 `collectionService.recover()` | 使用 Electron 主进程已持有的 context。不要再从 Node CLI 对个人数据目录初始化第二个 context |
| `collectionService.start({scope,options,credentials})` | `planFor` → create root → **立即 resume** | 不适合零请求准备：随后 `pause` 存在先发请求的竞争窗口 |
| `createCollectionRoot({...})` | 纯领域构造；`collectionProgress.status` 默认 paused，ledger 为空，副本由 target snapshot 复制 | 可作为新的受保护 `prepareDiagnosticRoot`/`startPaused` 服务内部构造器；当前没有对应 app API |
| `pause(ref)` / `wait(ref)` | 停止 task；等待活动 promise 完成后返回 root | 每站串行诊断前确保普通采集已停；不 cancel 根，因为 cancelled 根不可诊断 |
| `withDiagnosticContext({ref,requestId},callback)` | 已暂停根建立 diagnosticOnly slice，持有 collect lease；结束后恢复原状态；已 collecting 时转 `withActivityContext`；terminal 拒绝 | 每站一个稳定唯一 requestId，所有真实请求通过 callback 中的 request/readService/modelBudget |
| `withActivityContext(ref,callback)` | 仅活动 collecting 且存在 apiContext 时可用；跟踪 pending callback | harness 只在自己 diagnostic slice 内间接复用，避免和普通采集并发导致单站差额混算 |
| `ledger.snapshot(ref)` | pending 与 uncertain 预约均计入上界；详情 credit 按唯一资源预约计数 | 每站/每阶段前后快照作实际 delta；根 snapshot 是权威，不创建 source/model 独立 budget |
| `readProviderPage(provider,input)` | collectPage/collect 统一调用；记录契约校验、游标循环校验、parserVersion/pageKey | 首页面 `cursor:null`、一个公开 query、`pageLimit:1`；保留 stats/issues，不能只看返回 records 长度 |
| `commitCollectionPage({ref,token,unitId,page,operationLease})` | 校验根/lease/token/单位，版本内 ingest、去重、更新 root 新岗位及 child 计数；返回 revision | 只适用于根计划已登记的 unit；每次提交后将 ctx.token.expectedRevision 更新到返回 revision，避免下一页冲突 |
| `evaluationService.evaluate({...})` | schema3 runtime 使用 target 自有副本；rules 本地评价，ai/auto 会发送画像 | 固定 rules，传 scope/runId/operationLease/collectionGuard。不能通过普通 `/jobs/evaluations` 的 AI API收费测试，它新建 model budget |

诊断 callback 提供：`{budget,modelBudget,request,signal,operationLease,collectionGuard,ref,token,readService}`；它不提供 attachmentService/modelClient，也不会自动 ingest、匹配或生成逐站统计。

最小补齐建议：在已持有 context 的 Electron 主进程内新增受 `guardDesktopSender` 保护的单次 harness 入口，内部新增 paused root 准备事务。准备事务应使用 `operationGate.acquire('collect',{scope,expectedWorkspaceRevision})`、`assertScope`、同一 repository.mutateWorkspace 和 `createCollectionRoot`，保存同一 campaign 的 opaque ref；重复请求返回既有 ref。`start` 的 requestId 只对 resume 去重，重复调用 start 仍可创建多根，因此不能用 start 的 requestId 防止新预算。

该入口只返回脱敏 projection，不返回 `service.get(ref)` 或 repository.read() 原对象，因为 root 含完整 target/profile snapshots。无需向 renderer 暴露 key、sessionRef、个人路径或 raw sourceConfig。

普通 planner 的 maxSites 上限是 50，并只选择近期正文 proof 的站点。98 行诊断矩阵不能声称是普通 planner 已采集 98 站。最小只读诊断可直接调用 `readProviderPage` 后 `evaluateRules`/`gateRecommendation`，在内存使用真实 owned profile，避免为候选站伪造 ready。若要得到“本版本 validNewUnique”，必须再用根/lease/token 校验后的 ingest，并且将诊断样本归属同根；可复用已登记 unit 的 commitCollectionPage，对其余站需要受同样 guard 的诊断 ingest helper。仅内存诊断应把 validNewUnique 记为 null，而非冒充已入库新岗位。

## 3. 隐私与凭据路径

`electron/credentials.mjs` 的 `createCredentialService({dataDir,safeStorage})` 只支持 deepseek。`status('deepseek')` 返回 configured/encryptionAvailable 布尔值；`readForModel('deepseek')` 在主进程内部用 safeStorage 解密。安全前提是 `isEncryptionAvailable()` 为 true 且 storage backend 不是 basic_text。

现有 Electron 启动路径已经 `readForModel('deepseek')`，只把 key 放入 `cfg.deepseek.apiKey`；save/delete 的 guarded IPC 用 onKey 更新这份内存配置。harness 应复用此 cfg 和 context.modelFactory，不复制/导出 key，不在 shell、命令参数、环境变量、console、公共报告或模型输入中输出它。执行中仅检查 available/configured 的布尔前提。当前研究没有检查个人 key 是否配置。

`evaluation-service.mjs:251` 调用 `evaluationPrompt(p.profile,records)`，因此 ai/auto 不符合“真实简历只本地匹配”。根与本地匹配固定 rules；如确需模型，只对已核验的公开公告使用 `expandArticles(modelClient, {}, publicArticles, {concurrency:1,...})`。该函数的 `_profile` 未使用，prompt 仅由 article 构造；modelClient 必须由 `context.modelFactory({budget:ctx.modelBudget,signal:ctx.signal,modelConfig:cfg.deepseek,...})` 创建，并受根模型身份/价格锁约束。split 结果再做 literal/excerpt 校验及本地规则匹配。模型预算不要求必须消费；缺凭据/不支持价格/超额时保留 blocked 或未测状态。

**provider context 也需公开投影。** 普通 collector 会接收 root 的 profileRevision 与 targetSnapshot，legacy 更会从中提取 profile、毕业年份、城市等参数；harness 调用 provider 时不得透传真实对象。只传固定公开 query（消防或机场）、空城市及公开 jobTypes/限额投影；不传 profileRevision，不取目标姓名、学校、毕业年、证书或私人偏好生成查询。真实 profile 只留在同一进程的本地 rules 匹配阶段。

公开词 allowlist 与 pageLimit 在 request/provider 调用前再次断言，搜索 query URL 不进入公共输出。Boss 如使用已有独立会话，只在内部传正确 scope/ref/token/lease 与该 scope 的 sessionRef；缺会话或风险保持 blocked，不触发登录、clearRisk 或恢复动作。现有 boss-probe IPC 的 fallback 会取 target.roles/cities，不应直接作为本轮固定公开词入口。

## 4. 98 行、请求公平性与详情结算

先从生产公开目录生成恰好 98 条 `sourceId/siteId` 行，另外两项无站点 optionalService 单独列；执行前校验目录指纹/总数，若代码变动则重建矩阵，不用旧快照硬写当前完成数。先做零请求前提分类：template、provider 契约、公开种子、readService、source enabled/selected、cooldown、会话 scope、搜索外部费用契约等。只在内部读取前提，公共行仅保留布尔状态和原因码。

按 provider 第一轮各一个具备前提的站点，再轮询 91job tenant/公告站。每站先一页、一个 query；暂不补该站所有详情。逐站串行、maxRetries=0；DNS、重定向、字体请求、browser 资源、长文和附件都通过同根 request/worker ledger，不能按“页面=一次请求”预扣后绕开客户端。请求 cap 91 并不保证足够对 98 站都联网，无法执行的站仍保留明确行。

建议请求阶段软配额：列表/公开 golden 获取 62，详情/必要附件 18，投递受控读取 8，已确认瞬时失败恢复 3，共 91。这是公平调度用的软分配，硬权限仍是同根 reserve；阶段剩余额度可以在同根内重新分配，不能新建预算。47 是详情 credit 硬上限而非必须补足数量。若 DNS/多请求 provider 提前耗额，剩余行明确 `skipReason=budget_exhausted` 并列未测阶段。

详情最多一条代表记录。外层要先确认当前 provider 是否内建 claimDetail；截至本次最后代码读取，`legacy.fetchDetail` 已在 219-221 行 claim，预检旧文档关于此缺口已过时。统一外层 claim 时必须用同一 `sourceId/siteId/(sourceRecordId || url)` key，否则双扣。credit 重复由 ledger 的资源 hash 去重；request 每个实际尝试仍分别预约。最终代码复核还发现 university、chenyun、jiuyeqiao 已新增 `maxDetail===0` 列表记录输出分支，因此旧 preflight 的 L:10 不能继续作为当前静态阻断结论。应重分类为列表契约待实测；新输出分支存在也不能证明线上成功，列表异常/过滤后零接受量仍不能写正常 empty。

sourceService.probeScopedSource({ref}) 可以在 diagnostic slice 内共享根，但当前自动取最多两条详情，非 Boss query 为空，并将若干无 records 的结果写 empty；不满足这次一个固定公开词、一个详情及严格 empty 证据要求。最小 harness 直接调用 readProviderPage 与当前 provider.fetchDetail，自行记录完整分阶段状态。

附件服务若需使用，应由同一 ledger 建立，复用 context 的 cleanup、OCR、converter 与 conditional cache；诊断 apiContext 不包含这些依赖。不得调用普通 importService，它当前创建 6 请求/2 详情独立 budget。投递只走 `prepareApplicationCheck`、`ctx.request`、`assessApplicationResponse`；不填表、不上传、不提交。普通 jobVerificationService 可在活动 context 下核验，但可能再次抓详情，需预算调度和同资源 credit 验证。

goldens 与来源探针同 campaign/root。严格资格、正文缺失、截止日期冲突、历史公告、投递缺失、附件多岗位样本可先在本地公开 fixture 上核对；离线样本不伪称本轮联网成功。需要当前页面或模型拆分的 golden 必须复用 ctx.request/ctx.modelBudget，和其他探针竞争同一剩余 cap。不得为 fixture 替换实际 owned profile 或另建测试根。

## 5. 公共报告、判定与风险

每站字段建议沿用 preflight 的白名单：`sourceId,siteId,preflightClass,status,skipReason,blockOrigin,errorCode,diagnosticId,listAttempted,listContractVerified,rawCount,parsedCount,filteredCount,invalidCount,duplicateCount,bodyVerifiedCount,applicationDeclaredCount,applicationAvailableCount,qualificationPassCount,validNewUniqueCount,requestDelta,detailCreditDelta,costUpperBoundDelta,checkedAt`。增加 `list/body/application/qualification/attachment/model` 各阶段 `not_tested` 状态；未测计数用 null。每站即时追加本地脱敏 checkpoint，最终严格校验行数与 siteId 唯一性。公共报告只保留 opaque root/scope/sampleHash、数值、布尔、枚举与原因码。

不能直接 JSON.stringify provider result、evaluation、root、cfg、error.message、URL/cursor/sessionRefs。existing diagnostics 通过 cleanMetadata/diagnosticError 白名单清洗，适合记录关联 diagnosticId，但它会忽略未知逐站字段，因此完整 98 行矩阵需要独立白名单 report 文件。错误只输出安全 code/diagnosticId；不转存 legacy issue.message。

状态必须有阶段证据：无 template/seed/费用授权为 skip；明确权限/登录/风控/adapter 前提缺口为 blocked，标注 static/runtime；实际解析/身份/正文错误为 failed；只有已验证原始空列表才 empty。parsed、正文核验、开放期、申请可用性、本地资格与版本内去重分别计数。unknown 不提升为 pass/available/valid；抖音当前只发现，body/application/valid 不可声称已测；optional services 不进行收费试探。

当前最主要风险与补齐点：

1. 现有 start 立即 resume，需要无网络 paused 准备入口和同 campaign 原子幂等保护；否则不能安全建立唯一剩余额度根。
2. 普通 planner 既有 maxSites/proof 筛选不等于 98 来源诊断覆盖；本轮需明确诊断与正式 ingest/validNewUnique 的不同证据。
3. ai/auto 会发送真实画像，必须固定本地 rules，并将公开公告拆分独立接到同根 modelBudget。
4. 自动 probe/verify 可能多抓详情；直接诊断调度需以当前 provider 内建 credit 为准，避免双扣/漏扣。
5. 91 请求不足以保证全部有前提的站完整列表+正文+投递。报告必须逐站给 blocked/budget/not_tested，不以 provider 汇总冒充站点全成功。
6. 初始化、常规采集和后台 refresh 会影响状态/差额；执行使用现有 owner context，串行诊断且不恢复普通采集，收尾保留 paused 同根，后续仅续用剩余额度。

本研究动作计数：网络 0，模型 0，个人工作区读取 0，凭据数据读取 0，真实根创建 0。唯一写入为本文档。接口依据：`src/application/context.mjs`、`collection-service.mjs`、`collection-ledger.mjs`、`evaluation-service.mjs`、`source-service.mjs`、`job-verification-service.mjs`、`src/domain/collection.mjs`、`src/sources/collection-page.mjs`、`request-context.mjs`、`adapters/legacy.mjs`、`planning.mjs`、`src/match/article.mjs`、`electron/credentials.mjs`、`electron/main.mjs`、`electron/collection/ipc.mjs`、`src/server/collection-routes.mjs`、`public/js/validation-rules.js` 及两份同日 preflight。
