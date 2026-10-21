# 招聘扩源、公众号微博采集与证据核验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the current session. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已选择当前会话执行；本计划经用户审阅后才开始产品实施。

**Goal:** 扩大消防、机场与企业消防工程的有效岗位覆盖，实际采集公众号/微博正文、长文、海报及附件，并提供可恢复进度、累计预算和可追溯的资格证据。

**Architecture:** 在现有 schema3、Node/Electron 和九页 shadcn 工作台中增量实施。持久根活动统一管理分页、调用前预约和取消；普通请求、专用授权浏览器及匿名 Scrapling worker 共用资源门槛，正文与附件经证据核验后进入本目标版本岗位库。

**Tech Stack:** Node.js >=20、Electron 44.5.1、React 19.3.0、现有 shadcn、pdfjs-dist、SheetJS CE、本地 OCR、Python/Scrapling。新增运行文件锁定版本、哈希和许可证，不依赖 Codex 用户目录。

**Spec:** `docs/superpowers/specs/2026-10-09-source-expansion-and-evidence-design.md`，用户已批准；实施时同时阅读此文件与设计。

## Global Constraints

- 每个目标保存独立简历副本；岗位、检索、评价、投递、游标、私有缓存及平台会话均按目标包隔离。全版本去重逐版本执行。
- 回收及72小时永久删除覆盖新增子数据；旧 worker 和迟到页面不得在取消、归档或删除后写回。清理失败保留独立清理依据。
- 根 run 的旧 `status` 固定 `completed`；活动状态读取 `collectionProgress.status`，根容器不重复计检索数和费用。
- 标准活动：24站、400网络请求、每查询4页、100详情补抓、6岗位词组；广覆盖：50/1000/10/300/12。每批最多10站。
- 可显式上调的资源硬上限：50站、2000请求、20页、600详情；已有显式额度不自动放大。暂停、续采、重启及重新规划均保留累计用量。
- 同一根活动模型费用不超过10元，使用当前已配置模型与现有价格校验；新批次不产生新额度。付费社交/搜索服务默认关闭，另行开通。
- 每活动最多40附件，单份20MiB、累计200MiB；浏览器每页最多60请求/20MiB，全局并发最多2；社交初始同域并发1、页面间隔3秒。
- 所有自动请求，包括失败、重试、跳转、静态资源、附件和304均计数。调用前持久预约，崩溃后未确定消耗保守占用。
- 每URL每轮最多一次增强升级；网络/5xx最多2次退避重试，429尊重 Retry-After，持续403暂停。登录、验证码及会话失效由用户在专用窗口完成。
- 采集不携带姓名、电话、完整简历；日志不含查询词、原URL参数、游标、正文、凭据、个人路径及 worker 原始 stderr。
- 应用关闭期间不采集，重开只恢复进度。周期刷新默认关闭，开启后沿用原根活动额度，不自动新建付费活动。
- 200、搜索摘要、昵称、长文标记及模型推断均不能单独证明正文完整、官方身份、招聘有效或资格符合。

## Review Focus

1. 调用已收费但页未提交就崩溃：重启仍占用预约，重放不重复岗位或计量。任务2、5。
2. 验证页返回200、长文只拿到开头：不计正文成功，不生成已核实推荐；完成登录后重新验正文。任务8、10。
3. 空页后仍有下一页、重复点击继续、归档期间迟到结果：游标正确推进且最多一批；旧 epoch 被拒绝。任务4、5。
4. 附件伪装类型、压缩炸弹、合并单元格及跨页续表：受控拒绝，条件定位不能串到另一岗位。任务7。
5. 发布日期/账号城市被误当截止日期/工作城市，证书优先被误当必需：保持证据语义和 unknown，不错误淘汰或推荐。任务10、12、13。

## 边界、文件组织与执行方式

本期各模块组成同一采集管线，按下列15个可独立测试的交付任务推进；不另建云端系统、不全量重构旧服务。任务1–5形成可恢复采集基础，6–11提供来源与读取能力，12–14形成可用质量与界面，15验证发行。

新增文件按职责划分：`src/domain/collection.mjs` 定义活动；`src/application/collection-{ledger,service}.mjs` 管预约与协调；`src/sources/collection-page.mjs` 定义分页；`src/attachments/` 管证据解析；`electron/collection/` 管专用浏览器；`src/infrastructure/collection/` 管跨进程协议和安全出站。现有应用服务只负责接线或调用，不把这些实现继续堆入 `run-service.mjs`。

公共类型（JSDoc 定义于任务1/4/7/8对应文件，UI在任务14镜像）：

- `Scope = {packageId:string,targetRevisionId:string}`，严格沿用现有 `businessScope`，不接受省略目标的写请求。
- `ActivityRef = {scope:Scope,activityId:string}`；`CommitToken = {epoch:number,expectedRevision:number,sliceRunId:string}`。
- `CollectionProgress = {status,epoch,revision,planHash,catalogHash,queryHash,parserVersion,activeSliceRunId,units,limits,ledger,metrics}`；`activityId` 就是根 `runId`。
- `CollectionUnit = {unitId,sourceId,siteId,queryIndex,cursor,nextDueAt,committedPages,committedPageKeys,status,lastErrorCode}`；查询内容和 cursor 仅存业务包，`unitId` 为随机内部ID，页key列表随有限页上限保存。
- `CollectionLimits` 的字段为 `maxSites/maxRequests/maxPagesPerQuery/maxDetails/maxQueryGroups/maxAttachments/maxAttachmentBytes/maxTotalAttachmentBytes/maxPageRequests/maxPageBytes/maxCostCny`，分别绑定 Global Constraints 数值，1MiB=1048576字节。
- `UsageSnapshot = {usedRequests,usedDetails,usedAttachments,usedBytes,byKind,modelSpendCny,reservedCostCny,unresolvedCostCny,maxCostCny}`；已结算花费与未结算预约合计不得超过10元，unresolved是reserved子集而非再次相加。旧budget.snapshot字段由任务2适配保留。
- `PageResult = {records:SourceRecord[],nextCursor:object|null,done:boolean,pageKey:string,evidence:object[],issues:object[]}`，只读一次逻辑页；空 `records` 不等于 `done`。
- `ReadResult = {status,html:string|null,text:string|null,images:object[],links:object[],sourceEvidence:object[],bodyStatus,diagnosticId}`，`bodyStatus` 枚举 `complete/incomplete/login_required/challenge_required/session_expired/restricted/unavailable`。
- `AttachmentResult = {status:'extracted'|'pending'|'rejected',text,rows,fieldEvidence,issues}`；证据位置含正文片段或页/工作表/单元格/图像框。
- `QualificationResult = {status:'pass'|'unknown'|'fail',conditions:object[],gaps:string[]}`；最终推荐再检查正文、时效和投递证据。

**统一命令环境：** 以下命令在当前 worktree 的 PowerShell 执行；先设置 `$taskNode = (Resolve-Path '.cache/node20-runtime/node-v20.20.2-win-x64/node.exe').Path`、`$taskNpm = (Resolve-Path '.cache/node20-runtime/node-v20.20.2-win-x64/npm.cmd').Path`，把该 Node 所在目录加入本进程 PATH。单文件测试使用 `& $taskNode tools/test-v2.mjs --file <path>`，确保加载隔离目录及网络防护；不直接用裸 `node --test`。下表列出每任务红灯/绿灯的精确测试入口，每个文件单独运行，预期红灯退出非0且失败点对应新行为，绿灯全部退出0。

| 任务 | 红灯/绿灯入口（依次执行）                                                                                                                                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `& $taskNode tools/test-v2.mjs --file tests/unit/collection-contract.test.mjs`；`& $taskNode tools/test-v2.mjs --file tests/integration/collection-backup.test.mjs`                                                                                                                                                              |
| 2    | `& $taskNode tools/test-v2.mjs --file tests/unit/collection-limits.test.mjs`；`& $taskNode tools/test-v2.mjs --file tests/integration/collection-ledger.test.mjs`                                                                                                                                                                |
| 3    | `& $taskNode tools/test-v2.mjs --file tests/unit/http-bytes.test.mjs`；`& $taskNode tools/test-v2.mjs --file tests/integration/collection-conditional-cache.test.mjs`                                                                                                                                                            |
| 4    | `& $taskNode tools/test-v2.mjs --file tests/unit/collection-page.test.mjs`；`& $taskNode tools/test-v2.mjs --file tests/integration/ncss-announcement-pagination.test.mjs`                                                                                                                                                       |
| 5    | `& $taskNode tools/test-v2.mjs --file tests/integration/collection-activity.test.mjs`；`& $taskNode tools/test-v2.mjs --file tests/integration/collection-lifecycle.test.mjs`                                                                                                                                                    |
| 6    | `& $taskNode tools/test-v2.mjs --file tests/unit/collection-rotation.test.mjs`；`& $taskNode tools/test-v2.mjs --file tests/integration/source-discovery.test.mjs`                                                                                                                                                               |
| 7    | `& $taskNode tools/test-v2.mjs --file tests/unit/recruitment-attachments.test.mjs`；`& $taskNode tools/test-v2.mjs --file tests/integration/attachment-cleanup.test.mjs`                                                                                                                                                         |
| 8    | `& $taskNode tools/test-v2.mjs --file tests/unit/collection-browser-policy.test.mjs`；`& $taskNode tools/test-v2.mjs --file tests/integration/collection-session-cleanup.test.mjs`                                                                                                                                               |
| 9    | `& $taskNode tools/test-v2.mjs --file tests/unit/collection-worker-protocol.test.mjs`；`& $taskNode tools/test-v2.mjs --file tests/integration/collection-worker.test.mjs`                                                                                                                                                       |
| 10   | `& $taskNode tools/test-v2.mjs --file tests/unit/social-recruitment-intent.test.mjs`；`& $taskNode tools/test-v2.mjs --file tests/integration/social-body-collection.test.mjs`                                                                                                                                                   |
| 11   | `& $taskNode tools/test-v2.mjs --file tests/integration/social-service-capabilities.test.mjs`                                                                                                                                                                                                                                    |
| 12   | `& $taskNode tools/test-v2.mjs --file tests/unit/fire-airport-qualification.test.mjs`；`& $taskNode tools/test-v2.mjs --file tests/integration/job-evidence-verification.test.mjs`                                                                                                                                               |
| 13   | `& $taskNode tools/test-v2.mjs --file tests/unit/recruitment-duplicates.test.mjs`；`& $taskNode tools/test-v2.mjs --file tests/integration/collection-version-dedup.test.mjs`                                                                                                                                                    |
| 14   | `& $taskNode tools/test-ui.mjs --file tests/ui/collection-workbench.test.tsx`；`& $taskNode tools/test-ui.mjs --file tests/ui/social-sessions.test.tsx`；`& $taskNode tools/test-ui.mjs --file tests/ui/recruitment-evidence.test.tsx`；`& $taskNode tools/test-v2.mjs --file tests/integration/collection-diagnostics.test.mjs` |
| 15   | `& $taskNode tools/test-v2.mjs --file tests/integration/collection-end-to-end.test.mjs`                                                                                                                                                                                                                                          |

每任务先新增有意义的失败样本，再实现、验证、提交。测试代码块给出测试名和关键断言，测试内的 `f` 指该任务说明的 fixture；其余 arrange 沿用 `tests/helpers/fixtures.mjs`、`package-business-fixture.mjs` 和可控时钟。离线测试不得真实访问平台或调用模型。提交只包含该任务列出的产品/测试文件及锁文件，不提交运行数据、登录材料或原附件。

---

### Task 1: 根活动契约、归属及存储兼容

**Files:** Create `src/domain/collection.mjs`；Modify `src/domain/contracts.mjs`, `src/domain/packages.mjs`, `src/domain/package-ownership.mjs`, `src/infrastructure/storage/package-migration.mjs`, `src/infrastructure/storage/backup-filter.mjs`；Test `tests/unit/collection-contract.test.mjs`, `tests/integration/collection-backup.test.mjs`。

**Interfaces:** 产出 `createCollectionRoot({runId,scope,targetSnapshot,profileSnapshot,plan,limits,now}):Run`、`assertCollectionRun(run,workspace):void`、`normalizeCollectionRun(run,{restored}):Run`。根/子 role 分别为 `collection_root/collection_slice`；子 run 用 `collectionActivityId` 指根 run。目标包新增可选 `collectionSettings = {sourceOverrides,sessionRefs,refreshEnabled:false}`，只存本包采集配置和匿名引用；历史缺字段按空配置处理，凭据不存业务包。

- [ ] **Step 1: 写失败测试**。用 package fixture 创建两个目标，旧 run 无新字段；测试名及断言：

```js
// root_state_is_separate_from_legacy_run_status
assert.equal(root.status, "completed");
assert.equal(root.collectionProgress.status, "paused");
// reject_cross_package_child_and_invalid_cursor
assert.throws(
  () => assertCollectionRun(f.crossPackageChild, f.workspace),
  /collection_scope/,
);
assert.throws(
  () => assertCollectionRun(f.invalidProgress, f.workspace),
  /collection_progress/,
);
// old_runs_remain_terminal_and_restore_never_autostarts
assert.equal(
  normalizeCollectionRun(f.legacyRun, { restored: true }).collectionProgress,
  undefined,
);
assert.equal(f.restoredActive.collectionProgress.status, "paused");
assert.equal(f.restoredCancelled.collectionProgress.status, "cancelled");
```

- [ ] **Step 2: 红灯**。运行两个新测试文件；预期新导出缺失或断言失败，而不是 fixture 初始化错误。
- [ ] **Step 3: 实现契约**。在 `collection.mjs` 定义上文类型、状态迁移、非负安全整数与有限 JSON cursor 校验；根、子和目标快照归属必须一致，completed/cancelled 不因归一化复活。
- [ ] **Step 4: 接入存储与备份**。`assertWorkspace` 调用校验；历史无字段保持原样，恢复收敛未完成活动到 paused；匿名会话引用置空，备份排除运行时、凭据、临时清理清单。新增字段仍为 schema3 可选扩展。
- [ ] **Step 5: 绿灯与提交**。新测试及现有 `tests/integration/package-backup-restore.test.mjs` 通过；`git add` 上述文件，`git commit -m "feat: persist owned collection activity contracts"`。

### Task 2: 持久预约、累计资源与模型费用

**Files:** Create `src/application/collection-ledger.mjs`；Modify `src/infrastructure/http/budget.mjs`, `src/llm/budget.mjs`, `src/llm/deepseek.mjs`, `src/infrastructure/http/client.mjs`, `src/application/run-service.mjs`, `public/js/validation-rules.js`, `src/server/validation.mjs`；Test `tests/unit/collection-limits.test.mjs`, `tests/integration/collection-ledger.test.mjs`。

**Interfaces:** `createCollectionLedger({repository,operationGate,clock})` 产出异步 `reserve({ref,token,reservationId,kind,requestUpperBound,costUpperBoundCny,bytesUpperBound,resourceKey,operationLease})`、`settle({ref,reservationId,verifiedUsage,operationLease})`、`adjustLimits({ref,limits,expectedRevision,operationLease})`；`snapshot(ref):Promise<UsageSnapshot>` 返回当前持久快照。异步 `createActivityBudgets({ledger,ref,token,operationLease})` 先读持久状态，返回兼容现有 budget 的适配器：claim/settle异步、snapshot/isExhausted同步读最新已确认视图，最终额度以锁内预约为准。

- [ ] **Step 1: 写失败测试**。在 `collection-ledger` fixture 用假 transport/模型，暂停预约后重开 repository；并发预约只有一个可获最后额度：

```js
// reservation_is_durable_before_external_call_and_idempotent
assert.equal(f.transportCalls, 0); // 在持久预约注入失败时
assert.equal(f.reopenedUsage.reservedCostCny, 0.7); // 已预约但未结算
assert.equal(f.replayReservation.duplicate, true);
// continuation_cannot_reset_model_or_network_spend
assert.equal(f.afterResume.maxCostCny, 10);
assert.equal(f.afterResume.usedRequests, 399);
assert.equal(f.successfulLastRequestClaims, 1);
assert.equal(f.unresolvedReservation.status, "reserved");
// explicit_limits_not_silently_raised_and_money_exhaustion_keeps_rules
assert.equal(f.migratedExplicit.maxRequests, 120);
assert.equal(f.ruleEvaluationAllowedAfterMoneyLimit, true);
assert.equal(f.modelTransportCallsAfterMoneyLimit, 0);
```

- [ ] **Step 2: 红灯**。运行两个新文件；预期 ledger/统一默认值未实现。
- [ ] **Step 3: 实现 ledger**。在同一 workspace 锁内校验 ownership/lease/epoch/activeSlice，按唯一 reservationId 保存调用前上界；ledger自己的版本与页 `collectionProgress.revision` 分开，预约/结算不能令本次页提交token自行失效。仅可信 usage 释放未用额度，未知失败保守占用。模型身份/价格快照固定在根活动，不由续采的当前设置重解释旧费用。暂停时才可显式调整网络资源；新上限低于已用量则保持耗尽。
- [ ] **Step 4: 兼容预算调用**。HTTP、DeepSeek 的 `claimRequest/settleRequest` 及详情补抓 `claimDetail` 均 `await`；旧同步预算仍可用。异步结算失败不能报为完成或把账本清零。详情按本根活动 resourceKey 只领一次额度。
- [ ] **Step 5: 统一输入校验**。导出 `collectionLimitsFor(mode,explicit)` 和 `validateCollectionLimits(value)`；采用 Global Constraints 数值，UI后续直接复用。岗位词组上限广覆盖12；模型上限仍10元。每活动附件和每页浏览器资源分别验证。
- [ ] **Step 6: 绿灯与提交**。新测试及 `tests/unit/model-money-budget.test.mjs`, `tests/integration/money-budget-wiring.test.mjs` 通过；提交 `feat: reserve collection costs and quotas durably`。

### Task 3: 二进制传输、条件刷新和安全缓存

**Files:** Modify `src/infrastructure/http/client.mjs`, `src/infrastructure/http/transport.mjs`, `src/infrastructure/http/cache.mjs`, `src/infrastructure/http/scheduler.mjs`；Create `src/infrastructure/http/conditional-cache.mjs`；Test `tests/unit/http-bytes.test.mjs`, `tests/integration/collection-conditional-cache.test.mjs`。

**Interfaces:** 既有 `request(url,options)` 新增 `responseType:'text'|'bytes'`，bytes 返回 `{status,headers,bytes:Uint8Array,url}`；text 契约保持。`createConditionalCache({repository,clock})` 提供 `get({scope,resourceKey})`、`put({scope,resourceKey,etag,lastModified,bodyHash,parsedEvidence,checkedAt})`，元数据属于目标包、不得放全局 settings。

- [ ] **Step 1: 写失败测试**。假 transport 返回包含非UTF8字节的PDF、302→200、304、429及私网跳转：

```js
// binary_is_not_roundtripped_through_text
assert.deepEqual(result.bytes, new Uint8Array([0, 255, 37, 80, 68, 70]));
// every_physical_attempt_counts_and_304_reuses_evidence
assert.equal(f.ledger.usedRequests, 4); // 302+200+失败重试+304
assert.equal(f.after304.parseCalls, 1);
assert.equal(f.after304.modelCalls, 0);
assert.equal(f.otherPackageCacheHit, false);
// block_private_redirect_and_oversize_before_decode
assert.equal(f.privateDestinationCalls, 0);
assert.equal(f.oversize.code, "response_size_exceeded");
assert.equal(f.delayAfter429Ms >= 30000, true);
```

- [ ] **Step 2: 红灯**。运行两个新文件；确认失败来自 bytes/条件缓存能力。
- [ ] **Step 3: 实现 bytes**。transport 在真实字节上限内缓存并按模式返回，文本 charset 解码仅在 text 模式；保留现有逐跳 DNS/public URL 校验、取消和连接IP核验，每个物理重试/跳转先预约。预算耗尽不能被重试包装器当瞬时错误。
- [ ] **Step 4: 实现条件元数据和调度**。ETag/Last-Modified 只用于同 scope 同资源；304若缺缓存正文/解析结果则保持待补抓，不宣称已核实。普通内容哈希未变复用解析；刷新时效仍重新判断。慢响应或错误增加间隔，快速错误不提速。
- [ ] **Step 5: 绿灯与提交**。新文件及现有 HTTP 安全、缓存、取消测试通过；提交 `feat: support bounded bytes and conditional collection reads`。

### Task 4: 真正逐页的 provider 契约与 NCSS/公告分页

**Files:** Create `src/sources/collection-page.mjs`；Modify `src/sources/registry.mjs`, `src/sources/adapters/shared.mjs`, `src/sources/adapters/legacy.mjs`, `src/sources/adapters/ncss.mjs`, `src/sources/adapters/official-announcements.mjs`；Test `tests/unit/collection-page.test.mjs`, `tests/integration/ncss-announcement-pagination.test.mjs`。

**Interfaces:** 可选 `provider.collectPage({scope,site,query,cursor,request,signal,context}):Promise<PageResult>`；`capabilities` 新增 `resumablePages/body/attachments`。`readProviderPage(provider,input)` 对迁移 provider 用逐页方法；仅有旧 collect 的 provider 单次完成且明确 `resumablePages:false`，不伪造游标。

- [ ] **Step 1: 写失败测试**。NCSS三页、空第2页仍有 next、重复cursor、公告 list_2 及不支持分页的 legacy：

```js
// pages_beyond_two_and_empty_intermediate_page
assert.deepEqual(f.ncssVisitedPages, [1, 2, 3]);
assert.equal(f.emptySecondPage.done, false);
assert.equal(f.lastPage.nextCursor, null);
// verified_announcement_template_follows_next_link_once
assert.equal(f.announcementSecondPage.records.length, 1);
assert.equal(f.cycleIssue.code, "pagination_cycle");
assert.equal(f.legacy.capabilities.resumablePages, false);
```

- [ ] **Step 2: 红灯**。运行两个文件；现有2页/首页限制应被样本暴露。
- [ ] **Step 3: 实现分页契约**。移除 shared/legacy 内写死的 `Math.min(2,...)`；页数由活动有效额度决定，未迁移 legacy 保留其可验证真实限制。pageKey 由单元/请求游标/解析版本生成，cursor 大小有界，记录循环和结束原因。
- [ ] **Step 4: 扩展 NCSS 和公告**。NCSS 实际列表字段区分岗位/公告，保留来源ID、批次及详情入口；公告分页由已验证模板下一页链接或明确页模式驱动，限制同站及允许路径，不猜测无限URL。附件先形成待解析引用交任务7。
- [ ] **Step 5: 绿灯与提交**。新测试及现有 registry/NCSS/announcement 测试通过；提交 `feat: collect resumable source pages beyond legacy limits`。

### Task 5: 原子页入库、活动协调和生命周期

**Files:** Create `src/application/collection-service.mjs`, `src/application/collection-refresh.mjs`, `src/domain/ingest-records.mjs`, `src/server/collection-routes.mjs`, `tests/helpers/collection-fixture.mjs`；Modify `src/application/job-service.mjs`, `src/application/package-job-service.mjs`, `src/application/run-service.mjs`, `src/application/context.mjs`, `src/application/package-runtime-service.mjs`, `src/application/trash-service.mjs`, `src/application/purge-service.mjs`, `src/server/package-business-routes.mjs`, `src/server/routes-v2.mjs`；Test `tests/integration/collection-activity.test.mjs`, `tests/integration/collection-lifecycle.test.mjs`。

**Interfaces:** `ingestRecordsDraft(workspace,{scope,runId,records,observedAt,provenanceOperationId}):{jobIds,observationIds,newForTarget}` 为纯 reducer，不开事务。`createCollectionService({repository,operationGate,registry,requestFactory,modelBudgetFactory,ledger,clock,events,planner,readService,attachmentService})` 产出 `start({scope,options})`、`pause(ref)`、`resume({ref,requestId,replan})`、`cancel(ref)`、`get(ref)`、`list({scope})`、`commitCollectionPage({ref,token,unitId,page,operationLease}):Promise<{duplicate,committedPages,revision,jobIds}>`；依赖中的后续能力可用明确 unavailable stub，但不可伪造成功。`createCollectionRefresh({service,repository,clock})` 产出 `tick()/start()/stop()`，只调度已明确开启且未结束的根活动。

- [ ] **Step 1: 写失败测试**。`collectionFixture(t,{providers,limits,transport,clock})` 复用 packageBusinessFixture，注入 fakeProvider 和可阻塞提交；返回 scoped service、repository、transport计数及事件。

```js
// commit_is_atomic_replay_safe_and_empty_page_advances
assert.equal(f.afterFailedCommit.unit.committedPages, 0);
assert.equal(f.afterReplay.jobs.length, 1);
assert.equal(f.afterReplay.observations.length, 1);
assert.equal(f.afterEmptyPage.unit.committedPages, 2);
// repeated_continue_joins_same_slice
assert.equal(f.resumeA.sliceRunId, f.resumeB.sliceRunId);
assert.equal(f.maxConcurrentSlices, 1);
// archive_restore_cancel_and_late_worker
assert.equal(f.afterRestore.status, "paused");
assert.equal(f.lateCommit.code, "collection_stale_epoch");
assert.equal(f.cancelledRestore.status, "cancelled");
assert.equal(f.afterPurge.ownedRecordCount, 0);
assert.equal(f.networkCallsAfterRestartBeforeContinue, 0);
assert.equal(f.refreshCreatedNewActivities, 0);
assert.equal(f.refreshRestartedManuallyPausedActivity, false);
```

- [ ] **Step 2: 红灯**。运行两个新文件，确认事务和活动API缺失。
- [ ] **Step 3: 提取 reducer 并提交页**。从现有 package 入库逻辑提取，保留身份、观察、成员关系及 provenance；旧 ingest API 包装同一 reducer。`commitCollectionPage` 在一次 mutateWorkspace 中重新核验 scope/lease/epoch/revision；已提交pageKey返回duplicate且不再生成观察，其他页调用 reducer、提交 pageKey/cursor/revision；禁止调用会嵌套开事务的 ingest API。
- [ ] **Step 4: 实现协调器**。锁内唯一子批次 claim，处理重复 requestId；每批最多10站、每批独立 lease。等待授权释放资源槽，其他单元可推进。失败保留 cursor；查询、目录或解析哈希变化暂停并要求显式 replan，保留账本；同目标新版本创建独立根活动。
- [ ] **Step 5: 路由与生命周期接线**。新增 `POST /api/v2/collections` 开始、`GET /api/v2/collections` 列表、`GET /api/v2/collections/:activityId` 读取、`POST /api/v2/collections/:activityId/pause|resume|cancel`、`PUT /api/v2/collections/:activityId/limits`，全部验证 businessScope。旧 start run 入口路由到新活动并保留响应兼容；旧 `cancelRun` 不用于根活动。归档先 epoch++、暂停及中止子任务，等 lease/浏览器/临时资源后归档；永久cancel/删除拒绝旧回写。恢复仅提示续采。
- [ ] **Step 6: 周期刷新**。开关默认false；开启后只在应用运行、包active/目标enabled、活动未被手动暂停/取消且会话可用、根额度足够时按到期单元调度。开启刷新但等待nextDue的未结束活动不提前标completed，不持有lease；completed/cancelled绝不重开，耗尽停止，退出stop，重启必须用户续采后才恢复调度。
- [ ] **Step 7: 绿灯与提交**。新测试及 `tests/integration/package-run-scope.test.mjs`, `tests/integration/package-purge.test.mjs`, `tests/integration/package-backup-restore.test.mjs` 通过；提交 `feat: coordinate atomic collection pages and lifecycle cancellation`。

### Task 6: 来源公平轮换、有限发现与重点目录

**Files:** Create `src/sources/discovery.mjs`, `src/sources/source-quality.mjs`, `tools/discover-recruitment-sources.mjs`；Modify `src/sources/planning.mjs`, `src/sources/catalog.mjs`, `src/application/source-service.mjs`, `src/application/source-health.mjs`, `src/server/routes-v2.mjs`, `src/sources/catalog/universities.json`, `src/sources/catalog/employers.json`, `src/sources/catalog/public-notices.json`, `src/sources/catalog/platforms.json`, `tools/probe-sources-v2.mjs`, `tools/verify-source-catalog.mjs`；Test `tests/unit/collection-rotation.test.mjs`, `tests/integration/source-discovery.test.mjs`。

**Interfaces:** `buildCollectionPlan({target,catalog,ownedState,mode,now}):{units,hashes,limits,uncovered}`；`discoverSourceCandidates({seed,request,signal,maxDepth:2,maxUrls:100}):Candidate[]`；`assessSourceProbe({site,listSample,detailSample,now}):{capabilities,verification,evidence,issues}`。`sourceService.listScopedSources({scope})` 返回公共目录合并本包配置；`saveScopedConfig({scope,sourceId,config})` 写 `packages[packageId].collectionSettings.sourceOverrides`，`probeScopedSource({scope,sourceId,siteId,ref})` 用活动预算。无活动的用户主动配置探针沿用固定6请求/2详情且不调用模型；已有全局source设置只允许公开工具/目录配置，不接sessionRef/账号/查询私有参数。原 `GET /api/v2/sources` 和 `/api/v2/sources/:sourceId/settings|probe` 接收scope后调用对应新方法。

- [ ] **Step 1: 写失败测试**。30个已验证到期来源，首轮24次后次轮选剩余6个优先；禁用/待验证不混入：

```js
// persisted_rotation_prevents_starvation
assert.equal(f.secondPlan.units[0].siteId, "site-25");
assert.equal(f.selectedDisabledOrUnverified, 0);
assert.equal(f.otherTargetInheritedCursor, false);
// discovery_is_bounded_and_probe_does_not_overclaim
assert.equal(f.maximumDepth, 2);
assert.equal(f.uniqueCandidates <= 100, true);
assert.equal(f.emptyListProbe.capabilities.body, "unverified");
assert.equal(f.searchOnlyProbe.verification, "candidate");
assert.equal(f.otherTargetScopedSourceConfig, undefined);
assert.equal(f.globalSettingsContainSessionRef, false);
```

- [ ] **Step 2: 红灯**。运行两个文件；现有固定评分选站/简单ready标记不能满足断言。
- [ ] **Step 3: 实现轮换与到期选择**。先每选站一轮，再分配补正文；最近检查更久的来源优先补扫，利用本版本更新率和健康调整 nextDueAt，不跨目标复用私有查询缓存。轮换/seenID/正文哈希/应检查时间写所属目标的活动进度，全局health只保存匿名站点事实；来源失败不终止其他单元。保存/探针严格走scoped配置，不将选定账号或凭据引用写入全局settings。
- [ ] **Step 4: 实现有限发现及探针**。官网→招聘栏目→Sitemap/RSS/已知ATS；核验租户和主体。Common Crawl只查所选官方域名候选入口，回现站验证；保留列表/正文/日期/附件/投递能力和各自成功时间，当前403不能写成成功。未知模板进入candidate。
- [ ] **Step 5: 扩目录**。整理50–100个高相关候选：NCSS、机场集团/成员机场/航空保障、消防工程设计施工检测维保装备、公共招聘及行业高校；目录每项记录官方身份依据、允许域名、岗位族、地域、adapter和验证状态。仅实际探针过的项启用；公开网址批量验证放任务15，不以目录数量冒充已采岗位。
- [ ] **Step 6: 绿灯与提交**。新测试、`& $taskNode tools/verify-source-catalog.mjs` 和 `tests/unit/source-planning.test.mjs` 通过；提交 `feat: discover and rotate verified recruiting sources`。

### Task 7: 附件、海报、字段位置及可靠临时清理

**Files:** Create `src/attachments/service.mjs`, `src/attachments/pdf.mjs`, `src/attachments/docx.mjs`, `src/attachments/spreadsheet.mjs`, `src/attachments/ocr.mjs`, `src/attachments/doc-converter.mjs`, `src/attachments/cleanup.mjs`；Modify `src/resume/zip.mjs`, `src/infrastructure/storage/layout.mjs`, `src/application/context.mjs`, `src/application/purge-service.mjs`, `src/application/trash-service.mjs`, `package.json`, `package-lock.json`；Test `tests/unit/recruitment-attachments.test.mjs`, `tests/integration/attachment-cleanup.test.mjs`；Create synthetic fixture files under `tests/fixtures/recruitment-attachments/`。

**Interfaces:** `createAttachmentService({request,ledger,cleanup,ocr,converter,clock})` 的 `extract({ref,token,attachment,operationLease,signal}):Promise<AttachmentResult>`；`createAttachmentCleanup({tempRoot,manifestPath})` 的 `register({scope,activityId,attemptId,relativePath})`、`cleanupAttempt(attemptId)`、`cleanupPackage(packageId)`、`resumePending()`。manifest 独立于业务包，不含原URL/文件名/正文。

- [ ] **Step 1: 写失败测试**。生成无个人数据的文字PDF、扫描页、DOCX表格、XLS/XLSX合并单元格、多页岗位表及低置信度海报；伪PDF、巨型展开ZIP及清理锁占用：

```js
// shared_conditions_keep_role_row_and_page_provenance
assert.deepEqual(f.fireEngineer.degree.evidence.location, {
  sheet: "岗位表",
  cell: "D4",
});
assert.equal(f.scanField.status, "unknown");
assert.equal(f.pdfField.evidence.location.page, 2);
// unsafe_or_unavailable_documents_never_become_verified_jobs
assert.equal(f.fakePdf.status, "rejected");
assert.equal(f.zipBomb.issue.code, "attachment_expansion_limit");
assert.equal(f.noDocConverter.status, "pending");
// cleanup_survives_package_deletion_and_restarts
assert.equal(f.afterLockedDelete.status, "cleanup_pending");
assert.equal(f.afterRetry.tempFiles.length, 0);
assert.equal(f.outsideRootDeleteCalls, 0);
```

- [ ] **Step 2: 红灯**。运行两个文件；现有附件只有链接、扁平DOCX文本不足。
- [ ] **Step 3: 安装并锁解析依赖**。SheetJS CE `0.20.3` 使用官方 tarball `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`，锁完整性，避免旧npm发行。候选本地OCR `tesseract.js 7.0.0`、扫描PDF渲染 `@napi-rs/canvas 1.0.10`；安装前核对正式发行、许可证和Electron兼容，锁精确版本；验证不通过先报告具体差异，不暗中换方案。PDF复用现有pdfjs，OCR语言eng/chi_sim、WASM和worker均本地，不运行时下载。
- [ ] **Step 4: 实现解析器**。bytes先检查20MiB、MIME/魔数；新增附件保护值为ZIP最多2000条目/100MiB展开/200倍压缩比，PDF最多200页，OCR单页最多2500万像素；超过则rejected/pending并可取消，不修改简历导入默认值。不执行宏、外链或公式。PDF保留页和文本坐标；DOCX保留表格/合并关系而不改变原简历解析语义；SheetJS `read` 内存buffer保留工作表和单元格；OCR显式启用blocks/tsv坐标输出，空识别/低置信度待核验。共用条件与行条件分别记录，不确定跨页续表不自动拼到岗位。
- [ ] **Step 5: 实现受控转换与清理**。DOC仅通过已验证本地LibreOffice能力在隔离临时目录转换，缺失则pending并提供原链接/手工DOCX导入。写临时文件前原子登记相对路径，受控根校验；取消、结束、启动、归档、删除调用清理，失败保留manifest重试，不列入业务备份。
- [ ] **Step 6: 绿灯与提交**。新测试及现有 resume PDF/DOCX 回归通过，OCR真实合成样本检查字段/行对应；提交 `feat: extract recruiting attachment evidence with managed cleanup`。

### Task 8: 专用浏览器、会话归属与统一出站控制

**Files:** Create `electron/collection/browser.mjs`, `electron/collection/sessions.mjs`, `electron/collection/network-policy.mjs`, `src/infrastructure/collection/egress-proxy.mjs`, `electron/collection/ipc.mjs`；Modify `electron/main.mjs`, `electron/preload.cjs`, `electron/credentials.mjs`, `electron/self-test-network.mjs`, `ui/src/lib/desktop.ts`；Test `tests/unit/collection-browser-policy.test.mjs`, `tests/integration/collection-session-cleanup.test.mjs`, `tools/test-desktop.mjs`。

**Interfaces:** `createCollectionBrowser({ledger,egressProxy,sessionStore,clock})` 产出 `read({ref,token,url,routePolicy,operationLease,signal}):Promise<ReadResult>`、`openLogin({ref,platform,accountRef,remember}):Promise<{sessionRef,state}>`、`verifySession({ref,sessionRef,testUrl})`、`clearSession({scope,sessionRef})`、`closePackage(packageId)`。`createEgressProxy({resolvePublicUrl,clock})` 的 `start():{proxyUrl,stop}` 为浏览器/worker做公网地址固定与逐跳校验，不计隧道握手为第二次网页请求。

- [ ] **Step 1: 写失败测试**。假BrowserWindow/session与safeStorage；合成远程页面含跳转、200验证码、app-local URL、DNS变私网和关闭窗口：

```js
// remote_windows_have_no_workbench_bridge_and_do_not_share_cookies
assert.equal(f.remoteOptions.webPreferences.nodeIntegration, false);
assert.equal(f.remoteOptions.webPreferences.preload, undefined);
assert.notEqual(f.partitionA, f.partitionB);
assert.equal(f.otherTargetCookies.length, 0);
// login_requires_body_validation_and_encryption_is_optional
assert.equal(f.closedLoginWindow.state, "unverified");
assert.equal(f.challenge200.bodyStatus, "challenge_required");
assert.equal(f.noSafeStorage.persistedCredentialFiles.length, 0);
// count_assets_and_block_private_network_even_after_dns_changes
assert.equal(f.pageAutoRequests, 60);
assert.equal(f.request61Blocked, true);
assert.equal(f.privateSocketConnections, 0);
assert.equal(f.waitingAuthOccupiedSlots, 0);
assert.equal(f.quitLeftoverProcesses, 0);
```

- [ ] **Step 2: 红灯**。运行两个新文件及 desktop 静态测试；现有仅工作台窗口能力不足。
- [ ] **Step 3: 实现网络策略与代理**。自动页面文档、XHR、资源和跳转在webRequest发送前异步预约，实际字节按流量门槛中止；代理只接受本机受控客户端并解析/固定公网IP，禁止工作台、本地/私网/file目标、DNS重绑定和不受控直连。关闭服务worker/不需要的音视频广告及绕过代理的WebRTC流量。登录人工流量单列并限流，登录后正文验证返回活动额度。
- [ ] **Step 4: 实现会话存储**。按 package/platform/account 的随机 sessionRef 隔离，默认内存partition；记住登录才用safeStorage加密必要材料，启动恢复到非持久partition。凭据库登记归属与清理任务；不读取日常浏览器文件，匿名worker拿不到材料；归档关闭窗口，永久删除/清除失败留下独立清理记录。
- [ ] **Step 5: 实现窗口与IPC**。只有工作台主frame可发控制命令，校验scope及允许平台/公开testUrl。远程window sandbox/contextIsolation/noNode/no预加载，拦截导航/弹窗/下载。实际正文验证后才提示已登录；等待验证释放采集槽。主窗口退出也关闭登录窗/worker，不能只依赖 window-all-closed。
- [ ] **Step 6: 绿灯与提交**。新测试及 desktop/network self-test 静态门槛通过；补充合成 Electron 运行验证；提交 `feat: isolate authorized collection windows and egress`。

### Task 9: 匿名 Scrapling worker 与协议边界

**Files:** Create `src/infrastructure/collection/worker-client.mjs`, `src/infrastructure/collection/worker-protocol.mjs`, `python/collection_worker.py`, `python/requirements.in`, `python/requirements.lock`, `tools/build-collection-runtime.mjs`, `resources/collection-runtime/manifest.json`, `tools/verify-collection-runtime.mjs`；Modify `src/application/context.mjs`, `electron/collection/network-policy.mjs`；Test `tests/unit/collection-worker-protocol.test.mjs`, `tests/integration/collection-worker.test.mjs`, `python/tests/test_collection_worker.py`。

**Interfaces:** `createAnonymousWorker({runtime,ledger,egressProxy,clock})` 的 `read({ref,token,publicRoute,extractionRule,operationLease,signal}):Promise<ReadResult>`、`probe():CapabilityResult`、`closePackage(packageId)`。`buildCollectionRuntime({destination,manifest,platform:'win32',arch:'x64'})` 组装固定官方发行；`verifyCollectionRuntime({root,manifest,offline}):{capabilities,issues}`。JSON协议版本1包含 requestId、已重建公开URL、固定规则ID、资源上界、超时和取消消息；不接受任意代码、Cookie或自定义命令。

- [ ] **Step 1: 写失败测试**。假子进程输出超大JSON、原stderr含密钥、半包、崩溃/取消；Python transport mock验证资源预约：

```js
// protocol_strips_secrets_and_rejects_authenticated_routes
assert.equal(f.childEnvironment.DEEPSEEK_API_KEY, undefined);
assert.equal(f.signedUrlAccepted, false);
assert.equal(f.cookieInputAccepted, false);
assert.equal(f.rawStderrInLogs, false);
// uncertain_worker_usage_keeps_upper_bound_and_cancel_stops_child
assert.equal(f.afterCrash.reservedRequests, f.grantedUpperBound);
assert.equal(f.afterCancel.liveWorkers, 0);
assert.equal(f.enhancementAttemptsForSameUrl, 1);
assert.equal(f.hiddenPageInstructionExecuted, false);
```

- [ ] **Step 2: 红灯**。运行两个 JS 文件；运行时准备后使用 `& './.cache/collection-runtime-dev/python/python.exe' -m unittest discover -s python/tests`。运行时准备前只验证协议缺失的红灯，不把找不到Python当成功测试；已启用能力不得跳过样本。
- [ ] **Step 3: 实现worker与依赖锁**。以官方 Python `3.14.8` Windows x64标准GIL嵌入发行、Scrapling `0.4.15` 为验证版本，生成带hash完整依赖锁、浏览器revision和许可证manifest。builder在 `.cache/collection-runtime-dev/` 创建独立能力验证运行时，Python路径固定 `python/python.exe`；运行文件不进Git，不从用户Codex环境复制。检验普通/动态/增强公开读取及官方网络hook实际行为。子进程hidden/no shell、白名单ENV、单条JSON最多8MiB、读取timeout45秒、取消宽限3秒后终止进程树；按provider公开路由重建URL，拒绝凭据query/hash/OAuth回跳。
- [ ] **Step 4: 实现所有出站计量**。worker/browser使用任务8公网代理，每个实际请求由协议申请额度或领取已持久预约的有限grant；禁隐式无限retry与未计数重定向。若实际hook不支持逐次核实，预占完整上界且中止超额；不能直接使用绕过broker的默认网络。Cookie只用于匿名本任务会话，不接收授权浏览器材料。
- [ ] **Step 5: 净化与状态**。固定DOM正文规则清理脚本/隐藏指令，保留岗位表格和条件；CLI若用于能力探针必须 `--ai-targeted`。200挑战壳仍返回challenge，Scrapling缺失返回unavailable，Node/Electron继续可用；取消清理进程、浏览器和临时资源。
- [ ] **Step 6: 绿灯与提交**。JS/Python离线测试及实际本地合成worker能力探针通过；提交 `feat: add bounded anonymous scrapling collection worker`。

### Task 10: 公众号和微博实际正文、长文与账号增量

**Files:** Create `src/sources/adapters/wechat-public.mjs`, `src/sources/adapters/weibo-public.mjs`, `src/sources/social-intent.mjs`, `src/sources/social-content.mjs`, `src/application/content-read-service.mjs`；Modify `src/sources/wechat.mjs`, `src/sources/adapters/social-discovery.mjs`, `src/sources/registry.mjs`, `src/application/context.mjs`, `src/match/article.mjs`；Test `tests/unit/social-recruitment-intent.test.mjs`, `tests/integration/social-body-collection.test.mjs`；Create synthetic HTML/JSON/image fixtures under `tests/fixtures/social-recruitment/`。

**Interfaces:** `createContentReadService({request,browser,anonymousWorker,attachmentService,clock})` 的 `read({ref,token,url,providerId,operationLease,signal}):Promise<ReadResult>` 按普通→动态/一次匿名增强→待授权获取。`classifyRecruitmentIntent({text,evidence,modelBudget}):{intent,evidence}`，intent枚举 employer_recruitment/candidate_seeking/training/news/unknown。wechat/weibo provider 实现任务4逐页契约。

- [ ] **Step 1: 写失败测试**。已知文章、公开账号列表、动态壳、200验证、429、403、过期会话、微博截断长文、海报、重发及正文补抓失败后再试：

```js
// search_discovery_is_not_body_collection
assert.equal(f.searchOnly.recordsVerified, 0);
assert.equal(f.wechatArticle.bodyStatus, "complete");
assert.equal(f.weiboBeforeLongText.bodyStatus, "incomplete");
assert.equal(f.weiboAfterLongText.fullText.includes("报名条件"), true);
// intent_dates_and_location_keep_their_actual_meaning
assert.equal(f.training.intent, "training");
assert.equal(f.candidatePost.intent, "candidate_seeking");
assert.equal(f.postPublishedAtOnly.deadline, null);
assert.deepEqual(f.accountCityOnly.jobCities, []);
// missing_body_remains_retryable_and_auth_does_not_count_success
assert.equal(f.failedBody.retryEligible, true);
assert.equal(f.afterLoginButStillChallenge.recordsVerified, 0);
assert.equal(f.repost.originalPostId, f.original.sourceRecordId);
```

- [ ] **Step 2: 红灯**。运行两个文件；搜索-only旧路径应暴露缺口。
- [ ] **Step 3: 实现公众号**。调用经测试的现有 `parseArticle` 或抽取其纯函数；实际读取标题、主体、发布/编辑时间、完整正文、图片和原公告外链。保留现有providerId `wechat`，从legacy注册集合移出其旧实现再注册新provider，避免重复ID或丢配置。已知公开链接与可信账号种子均可用；按可达列表保存帖子ID/检查时间，账号历史不可取得时明确coverage受限。搜索服务不开通时保留已知链接/官网发现路径，不因缺搜索服务停掉全文采集。
- [ ] **Step 4: 实现微博**。以新provider替换 `social-discovery` 中的 `weibo` 条目并保留该ID，其他社交发现provider不删除。公开账号、可达搜索及正常页面配套数据发现；longText标记触发详情补取并核对实际全文。保留原帖/重发关系、图片、时间和官方外链；浏览器匿名失败可在专用授权会话继续，等待授权不占其他来源槽位。不采私信/关注人群或无关个人帖子。
- [ ] **Step 5: 串联意图、附件和原公告**。单位招聘再抽岗位，未知保留线索，求职/培训/资讯不生成推荐；招聘海报走任务7，跨站官方外链补全证据。正文失败单独排待补抓，seenID不把失败永久跳过。将公告模型展开的固定5篇改为根活动可预算的待处理队列，每篇只在未变正文时缓存复用，不限制岗位数或刷新费用。
- [ ] **Step 6: 绿灯与提交**。新样本、HTTP状态和已有微信解析回归通过，确认每页可暂停/重放；提交 `feat: crawl wechat and weibo recruiting content with evidence`。

### Task 11: 官方读取通道的能力探针与可选开通

**Files:** Create `src/sources/adapters/weibo-official.mjs`, `src/sources/adapters/wechat-authorized.mjs`, `src/infrastructure/collection/service-capabilities.mjs`；Modify `src/application/source-service.mjs`, `src/sources/registry.mjs`, `electron/collection/sessions.mjs`；Test `tests/integration/social-service-capabilities.test.mjs`。

**Interfaces:** `probeReadService({scope,platform,credentialRef,runner}):{availableReadCommands,quota,pricingState,issues}`；`enableReadService({scope,serviceId,confirmedCapability,paidServiceAcknowledged})`。可选provider与网页provider各自capabilities；凭据从受控引用解析，不在JSON/log返回。

- [ ] **Step 1: 写失败测试**。mock可用命令只有搜索、服务未开通、额度未知和拥有自身公众号发布权限：

```js
// service_capability_is_account_specific_and_paid_default_is_off
assert.equal(f.defaultConfig.enabled, false);
assert.equal(f.searchOnly.bodyCapability, false);
assert.equal(f.unknownQuota.automaticCalls, 0);
assert.equal(f.writeCommandExecuted, false);
assert.equal(f.otherAccountPublicationPermissionInferred, false);
assert.equal(f.webProviderAvailableWhenApiDisabled, true);
```

- [ ] **Step 2: 红灯**。运行该文件；能力层缺失。
- [ ] **Step 3: 实现只读探针**。实施时再核对微博官方CLI最新安装/参数与许可证，锁验证版本；固定允许 `doctor`、`commands list --available`、`commands show`及已审查读取命令，不接任意CLI参数/发布写命令。真实开发者认证/OAuth由用户在平台完成，解析账号实际服务/额度后才开通，不把文档命中当成功。
- [ ] **Step 4: 实现微信授权读取边界**。只有自身或运营方授权公众号能力经实际官方权限验证才读发布列表，任意其他公众号不推断可用；官方资料/账号能力缺失时保持unavailable，网页正文渠道照常工作。新付费服务需独立明确开通，不能引用模型10元额度代为购买。
- [ ] **Step 5: 绿灯与提交**。mock测试通过，未获用户登录的真实通道保持未配置且报告原因；提交 `feat: probe optional authorized social read capabilities`。

### Task 12: 字段证据、招聘时效、投递入口和资格三态

**Files:** Create `src/domain/recruitment-evidence.mjs`, `src/application/job-verification-service.mjs`；Modify `src/domain/qualification.mjs`, `src/domain/job-facts.mjs`, `src/domain/ontology.json`, `src/application/evaluation-service.mjs`, `src/llm/prompts.mjs`, `src/llm/validation.mjs`, `src/domain/record.mjs`；Test `tests/unit/fire-airport-qualification.test.mjs`, `tests/integration/job-evidence-verification.test.mjs`。

**Interfaces:** `evaluateEvidenceQualification({profileSnapshot,conditions,sourceEvidence}):QualificationResult`；`assessRecruitmentEvidence({record,now}):{bodyVerified,openingStatus,applicationStatus,missing,conflicts}`；`verifyJob({scope,jobId,ref,operationLease,signal})` 复用活动额度并保存核验观察；`isVerifiedRecommendation({qualification,evidence}):boolean` 为唯一推荐门槛。

- [ ] **Step 1: 写失败测试**。消防/机场样本含专业或关系、证书必需/优先、注册过期、校招届次、正式经验、年龄只在明确要求时，以及公示/过期/长期招聘：

```js
// preferred_certificate_and_title_do_not_create_mandatory_conditions
assert.equal(f.preferredCertificate.status, "pass");
assert.equal(f.engineerTitleOnly.mandatoryCertificate, null);
assert.equal(f.internshipInsteadOfTwoFormalYears.status, "fail");
assert.equal(f.degreeMajorAlternative.status, "pass");
assert.equal(f.missingCertificateRegistration.status, "unknown");
// recommendation_requires_current_evidence_and_qualification
assert.equal(f.highAiScoreHardFailure.recommended, false);
assert.equal(f.unknownDeadline.openingStatus, "unknown");
assert.equal(f.longTermApplyChecked73HoursAgo.recommended, false);
assert.equal(f.proposedHireNotice.openingStatus, "historical");
assert.equal(f.loginRequiredApplication.applicationStatus, "login_required");
```

- [ ] **Step 2: 红灯**。运行两个文件；现有专业/证书有效状态及证据门槛应有失败样本。
- [ ] **Step 3: 实现证据抽取和冲突**。JobPosting/JSON、正文和附件字段各自带sourceExcerpt/位置/版本/哈希；结构化字段与可见正文冲突则unknown。记录招聘批次、地点、合同性质、截止、正式要求/优先要求、主体及投递入口；缺字段不猜。
- [ ] **Step 4: 实现资格与推荐**。读取本目标独立简历和确认事实；专业OR、学历、届次、正式经验、证书等级/注册有效性及明确年龄/体能条件，区分国家消防员/专职消防员/企业技术岗。模型输出必须经规则门槛校验，不能翻转fail/unknown；长期明确招聘入口72小时复核，未写截止不默认长期。
- [ ] **Step 5: 核验写回与权限**。来源正文/投递probe调用共用budget；字段校正仅本包，存原证据与校正事件，不删除冲突出处。投递需登录和入口失效分别显示；过期/关闭/拟录用标历史不计新增有效岗位。
- [ ] **Step 6: 绿灯与提交**。新测试及现有 qualification/recommendation/intern/degree 回归通过；提交 `feat: verify recruiting evidence and fire airport eligibility`。

### Task 13: 多来源证据补全及逐版本保守去重

**Files:** Modify `src/domain/identity.mjs`, `src/domain/job-duplicates.mjs`, `src/domain/job-facts.mjs`, `src/application/package-job-service.mjs`；Create `src/domain/duplicate-candidates.mjs`；Test `tests/unit/recruitment-duplicates.test.mjs`, `tests/integration/collection-version-dedup.test.mjs`。

**Interfaces:** `findDuplicateCandidates({records,existingJobs}):CandidatePair[]` 使用权威ID/规范URL优先，SimHash只筛候选；`compareRecruitmentFacts(a,b):{decision:'same'|'distinct'|'review',conflicts}`；`mergeSourceEvidenceDraft(workspace,{scope,keptJobId,mergedJobId,evidence}):void` 保留各来源事实与个人业务关系。

- [ ] **Step 1: 写失败测试**。官网+公众号同批、不同城/批次/合同/专业/证书、近似模板及两版本相同公开岗位：

```js
// mirrors_merge_evidence_but_conflicting_requirements_do_not_merge
assert.equal(f.sameOfficialId.decision, "same");
assert.equal(f.newRecruitmentBatch.decision, "distinct");
assert.equal(f.conflictingCertificate.decision, "review");
assert.equal(f.similarTextOnly.decision, "review");
assert.equal(f.merged.sourceEvidence.length, 2);
// dedup_preserves_each_target_and_its_applications
assert.equal(f.packageA.jobs.length, 1);
assert.equal(f.packageB.jobs.length, 1);
assert.notEqual(f.packageA.jobs[0].jobId, f.packageB.jobs[0].jobId);
assert.equal(f.packageB.applicationChanged, false);
```

- [ ] **Step 2: 红灯**。运行两个文件；确认失败不是已有保守判重被人为削弱。
- [ ] **Step 3: 实现候选与冲突比较**。保留现有身份/URL规范化规则；业务指纹增加批次、城市、合同、专业和证书明确条件。权威ID冲突也保留字段冲突，不能抹掉旧证据；未知批次/资格的文本相似只待人工核验。SimHash参数用本地中文岗位样本验证，不照搬网页阈值。
- [ ] **Step 4: 合并证据与全版本执行**。同版本合并多来源观察且保留发布时间/最近核验/出处；个人评价、投递关系按现有迁移逻辑保留，不跨包搬运。误合并样本能停用对应自动规则并加入回归；全版本命令循环各包独立处理。
- [ ] **Step 5: 绿灯与提交**。新测试及现有 dedup/应用关系/版本隔离回归通过；提交 `feat: merge source evidence with version scoped conservative dedup`。

### Task 14: 来源能力、活动操作、证据界面和全面诊断

**Files:** Create `ui/src/features/workbench/CollectionProgress.tsx`, `ui/src/features/sources/CollectionSessionDialog.tsx`, `ui/src/features/jobs/RecruitmentEvidence.tsx`；Modify `ui/src/lib/api.ts`, `ui/src/lib/types.ts`, `ui/src/lib/desktop.ts`, `ui/src/features/sources/SourcesPage.tsx`, `ui/src/features/sources/SiteDialog.tsx`, `ui/src/features/workbench/WorkbenchPage.tsx`, `ui/src/features/workbench/RunSummary.tsx`, `ui/src/features/workbench/RunOptions.tsx`, `ui/src/features/jobs/JobsPage.tsx`, `ui/src/features/jobs/JobFilters.tsx`, `ui/src/features/jobs/JobDetailsSheet.tsx`, `ui/src/features/jobs/job-view.ts`, `src/application/run-service.mjs`, `src/application/export-service.mjs`, `src/store.mjs`, `src/server/routes-v1.mjs`, `src/infrastructure/diagnostics/fields.mjs`, `src/infrastructure/diagnostics/log.mjs`；Test `tests/ui/collection-workbench.test.tsx`, `tests/ui/social-sessions.test.tsx`, `tests/ui/recruitment-evidence.test.tsx`, `tests/integration/collection-diagnostics.test.mjs`。

**Interfaces:** api封装任务5 collection与任务8受控desktop接口；`CollectionProgress({activity,onPause,onResume,onCancel,onAdjustLimits})` 只读根活动快照。日志事件固定 `collection.plan/page/body/attachment/qualification/dedup/finish`，字段仅activity/unit安全ID、engine、页序号、计数、缓存、流量、耗时、HTTP状态和错误码。

- [ ] **Step 1: 写失败测试**。React fixture含根+2子run、部分覆盖、预算不足、登录受限、错误ID和持久表单；诊断输入主动含敏感标记：

```js
// root_metrics_are_not_counted_twice_and_all_operations_give_feedback
assert.equal(f.historyActivityCount, 1);
assert.equal(f.displayedModelCost, "¥3.20");
assert.equal(f.successToastAfterPause, true);
assert.equal(f.resumeClickCountWhenDoubleClicked, 1);
assert.equal(f.failedSaveKeptDraft, true);
// incomplete_body_unknown_fit_and_login_state_are_explicit
assert.equal(f.unknownQualificationShownAsPass, false);
assert.equal(f.loginWindowCloseShownAsVerified, false);
assert.equal(f.evidenceHasSourceLocator, true);
// logs_exports_have_counts_without_secrets
assert.equal(f.log.includes(f.privateSentinel), false);
assert.equal(f.log.includes(f.rawCursor), false);
assert.equal(f.loggedResourceRequests, 12);
```

- [ ] **Step 2: 红灯**。运行统一命令表任务14的四条命令；应缺新组件/统计口径。
- [ ] **Step 3: 来源页与登录操作**。用 shadcn 与 UI UX Pro Max 技能沿现有九页风格，分类行业/来源/访问方式，展示候选、列表/正文/附件/投递验证、时间及受限原因；提供验证、独立窗口、记住/清除登录。无safeStorage提示无法记住，不误用原deepseek凭据可用标记作为浏览器能力。
- [ ] **Step 4: 活动进度与历史**。展示已提交页、计划/实际站点、未覆盖单元、根累计额度及剩余、模型回退、暂停/继续/取消/调整额度。向上调整必须暂停并显示已用量，不声称全量；不可用按钮解释原因。UI历史使用collection列表加非collection的旧run，一根活动一项；根累计/子用量只选一套。旧 `listRuns`、`store.summary`、v1 tracking summary排除根容器的旧成功计数，子run仅用于兼容诊断；所有权/删除记录数仍包含根容器，不能删除底层root逃避重复统计。
- [ ] **Step 5: 岗位证据与反馈**。符合/待核验/不符合及当前/历史筛选；详情展示条件原文、页/单元格、主体/批次/核验时间与多来源冲突。所有保存、验证、清除、暂停、续采、取消、校正成功toast；失败保留draft/progress并给诊断ID及下一步；键盘/焦点/移动宽度和三DPI可用。
- [ ] **Step 6: 日志与质量计数**。白名单字段新增活动阶段漏损：发现→正文→附件→资格→去重→推荐。请求分母含所有自动物理请求，人工登录单列；新增有效岗位限定本版本此前未有+正文/当前招聘/必需资格/投递证据均过门槛，镜像补证和旧刷新不算新增。sanitize所有未知provider/siteID和worker错误为安全ID/固定码，导出亦同。
- [ ] **Step 7: 绿灯与提交**。新UI/diagnostics、全部 `test:ui`、`typecheck:ui`、`build:ui` 通过；提交 `feat: present collection capabilities progress and recruiting evidence`。

### Task 15: 独立运行时、公开试点、完整验收及 EXE

**Files:** Create `tools/pilot-recruitment-coverage.mjs`, `docs/source-expansion-usage.md`, `docs/reports/2026-10-09-source-expansion-validation.md`；Modify `tools/build-collection-runtime.mjs`, `resources/collection-runtime/manifest.json`, `tools/build-desktop.mjs`, `tools/verify-package.mjs`, `tools/test-desktop.mjs`, `tools/verify-desktop-self-test.ps1`, `electron/self-test-network.mjs`, `README.md`；Test `tests/integration/collection-end-to-end.test.mjs`。

**Interfaces:** 复用任务9 `buildCollectionRuntime/verifyCollectionRuntime`；`pilotRecruitmentCoverage({scope,activityId,sourceIds,since,limits,readOnlyServices})` 只用现有活动及预算，输出脱敏分来源计数/误差报告，不导出简历正文。

- [ ] **Step 1: 写端到端失败测试**。合成NCSS/公告/社交/附件跨页，中断重启、预算耗尽、归档恢复、取消、删除以及无开发机工具环境：

```js
// end_to_end_restore_keeps_costs_evidence_and_ownership
assert.equal(f.afterRestart.usedRequests, f.beforeRestart.usedRequests);
assert.equal(
  f.afterRestart.unresolvedCostCny,
  f.beforeRestart.unresolvedCostCny,
);
assert.equal(f.duplicateCountAfterReplay, 0);
assert.equal(f.crossPackageWrites, 0);
assert.equal(f.after72Hours.allChildRecords, 0);
assert.equal(f.offlineRuntime.pythonAvailable, true);
assert.equal(f.offlineRuntime.scraplingAvailable, true);
assert.equal(f.offlineOcr.automaticDownloads, 0);
```

- [ ] **Step 2: 红灯与运行时组装**。先运行端到端测试。Python Windows x64标准GIL嵌入发行以 `3.14.8` 为验证版本，Scrapling `0.4.15`及其实际要求浏览器锁定；官方hash、依赖hash、许可证、浏览器revision、OCR语言/WASM/canvas原生模块列入manifest。验证wheel/Python/Electron兼容，不从个人Codex虚拟环境复制或依赖本机PATH；`.node`/运行文件正确asar unpack，后台进程Hidden。manifest只有版本/相对路径/hash，不含用户路径。
- [ ] **Step 3: 公开小样本验证**。仅向已选官方源发送通用消防/机场/工程岗位词，每种启用来源核验列表、正文、日期及投递；NCSS现网请求路径先核对页面实际协议。失败受限保留状态，不用fixture冒充线上成功；第三方付费接口未开通不调用，平台登录由用户本人完成。
- [ ] **Step 4: 社交试点和人工参考**。最多20个已核验机构账号，最近7天回溯窗口，100–200条可取得公开内容，不足则全部核对；含招聘/求职/培训负例。仍受同一个根活动网络/附件/模型10元预算，资源不足就报告实际覆盖，不能重开额度凑数量。每轮新岗位/待核验/过期/疑似重复各最多10条人工检查；发现字段错位或误合并，修复并补回归后重测相关风险。参照只对人工可见样本，不宣称平台全历史或全量召回。
- [ ] **Step 5: 完整门槛**。依次运行 `& $taskNpm run test:offline`（已包含v2、React及desktop测试，不重复全跑）、`& $taskNpm run typecheck:ui`、`& $taskNpm run dist:desktop`、`& $taskNpm run verify:package`、`& ./tools/verify-desktop-self-test.ps1 -ExePath './dist/简历岗位雷达-win32-x64/简历岗位雷达.exe' -Scales 1,1.25,1.5`。全部退出0；三种DPI真实EXE检查九页、独立登录窗、续采、证据、回收/恢复/清空及72小时模拟钟清理。无开发机Python/Node环境验证打包运行时；缺可选DOC转换明确pending。后续修复只重跑相关测试，改变包内容后重建并验证发行包。
- [ ] **Step 6: 交付与集成**。报告列实际成功/受限来源、每100自动请求新增有效唯一岗位、正文/投递完整率、过期/待核验/重复/误合并及预算，并区别离线与线上证据。使用说明补充来源启用、专用登录、暂停续采、证据与诊断操作。独立整分支代码审查后修复实质问题；保留现有工作树/桌面快捷方式，替换EXE前确认文件未占用，需用户关闭时解释原因。提交 `feat: ship verified source expansion desktop runtime`，沿已有授权更新原PR，不自行合并；检查PR当前提交/CI后汇报EXE绝对路径及能力限制。

## 文档自审与实施门槛

- 设计第1–4节由任务1/4/6/15覆盖；第5节由8–11覆盖，公众号/微博实际正文是任务10必需交付。
- 第6节由1–6覆盖；第7节由3/7覆盖；第8节由12覆盖；第9节由1/5/13覆盖；第10节由14覆盖；第11节由8/9/15覆盖；第12节由各任务测试及15整体验收覆盖。
- 类型与预算只以上文及任务1/2为准；活动ID统一根runId，页提交统一 `commitCollectionPage`，所有后续任务调用同一 ledger/read/attachment接口。
- 自审已修正：ledger版本与页revision分离；来源私有配置不写全局settings；历史列表不重复累计根/子数据；Python开发测试运行时在任务9准备，打包在15消费。任务15修改任务9新建文件属于明确依赖，不按当前尚未存在误报。
- Review Focus五项均已落到所属任务断言。安全/崩溃/隔离测试不可跳过；线上不能验证的能力报告受限，未配置可选服务不阻断公开网页渠道交付。
- 当前只完成设计与计划文件，未实施产品、登录账号、批量采集或改变个人数据。用户审阅此计划后，按既定当前会话方式开始任务1。
