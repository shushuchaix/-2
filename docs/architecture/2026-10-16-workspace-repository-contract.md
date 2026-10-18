# 正式 Workspace Repository 端口（Phase 2A）

2026-10-16。入口 `openWorkspaceRepository({dataDir,fsAdapter?,clock?,diagnostics?,faultInjector?,busyTimeoutMs?,onStartupStage?})` 是异步的；导入和固定派生代际升级完成后返回。未完成的恢复 intent 仍禁止业务访问，正式 context 完成恢复、归档与到期清理门槛之后才发布 ready。业务只有 `workspace.sqlite` 一个写入权威。底层 `openSqliteRowStore` 不向 application 装配导出。

## 有界业务接口

方法和选择器沿用 [行存储契约](2026-10-16-row-store-contract.md)，这里的方法都返回 Promise。返回值与调用者隔离。

`allowLegacy:true` 仅为历史导入/维护及旧格式测试保留 schema2 SQLite；schema2 的普通行读写仍拒绝。正式 application context 不传该选项，必须完成 schema3 切换。它不是 JSON 业务引擎开关。

```js
await repository.getMeta('revision');
await repository.getRow({collection:'runs',id:activityId,ownerPackageId:packageId}, {scope});
await repository.getRecord({collection:'targets',id:targetRevisionId,ownerPackageId:packageId}, {scope});
await repository.readView({select:[selector],metaKeys:['revision']}, {scope});
await repository.queryRows(selector, {scope});
await repository.queryIds(selector, {scope});
await repository.aggregateRows({collection:'jobs',ownerPackageId:packageId,operation:'count'}, {scope});
await repository.readChanges({afterSeq:0,ownerPackageId:packageId,limit:100}, {scope});
await repository.transaction({select:[selector],metaKeys:[]}, tx => {
  const run = tx.getRow({collection:'runs',id:activityId});
  tx.putRow({collection:'runs',id:activityId,ownerPackageId:packageId,value:{...run,status:'cancelled'}});
  return {cancelled:true};
}, {scope,operationLease});
```

`scope` 是 `{packageId,targetRevisionId}`。即使 selector 的 ids 为空、查询无结果或事务无变化，也核查 scope。显式 owner 同样逐个核查，不能利用空结果跳过归属或72小时期限。options 的 `access` 默认为 `business`，管理端可显式 `management` 或 `trash_read`；到期正文在三种 access 下都拒绝。全局小集合（settings/sourceHealth/operationLeases/packages 等）不要求虚构 target scope。

`queryRows(packages)` 和 `readView().rows.packages` 返回明确元数据 DTO；有 scope 也不会自动补回配置。需要私有来源核验、会话引用或刷新配置时，明确 `getRow({collection:'packages',id},{scope})`。单包配置不含已拆出的 `collectionCache` 正文。声明事务的 `tx.view` 保留已声明小包配置，供同事务核查/更新。回收站列表始终显式 DTO + SQL counts，不 spread package。

事务回调必须同步，tx 方法同底层；不能 await 文件/网络/浏览器。返回 `{result,revision,changes}`。普通 WAL 读不获取文件写锁；多行/total/changes+head 在同一 SQL 读快照。每次读在交付结果前核对当前 control 指纹，跨进程删除、损坏或缺失会撤销结果。每笔写：共同 workspace 文件锁 → 锁内读取最新 control/lease → 短同步 SQLite 事务 → commit → 解锁。所有 control 写使用相同顺序。

新增同步 `tx.ensurePart({collection,id,path})`：父行须已声明且存在或本事务先 putRow；path 只能是 `SPLIT_PARTS` 固定路径，childCollection/shape 由 core 确定。空 map/array 的登记与事务共同提交/回滚；不能使用 sentinel 假 child。`runs.jobIds` 与 `runs.collectionProgress.newJobIds` 均拆为 `activityJobIds`，完整 path 区分两者；array ID 仍为 `rowKey(runId,path,ordinal文本)`。`activityJobIds` 的 scalar value 索引为 jobId，`runEvaluationIds` 的 scalar value 索引为 resourceKey。

## 生命周期的控制与写入 fence

`withWriteFence(action,options)` 供版本身份预留、归档/永久清理准备等需要先持久 control 再提交行的命令。异步 action 收到只在这次 fence 有效的端口：

```js
await repository.withWriteFence(async fence => {
  const control = fence.control; // 隔离快照
  // 先建立单调 identity/highWater/maintenance intent，失败后不能回退。
  await fence.commitControl(nextControl);
  return fence.transaction(selection, synchronousRowAction);
}, {operationLease});
```

fence 提供同步有界 `getMeta/getRow/getRecord/readView/queryRows/queryIds/aggregateRows/readChanges`、下面的固定查询、`getPackageCounts(packageId)`、`readOperationState({limit<=200})`、同步 `transaction(selection,action)`、异步 `commitControl(next)`。不包含 DB、任意SQL或全量视图。回调结束后所有方法拒绝。

禁止 nested fence（`workspace_fence_nested`），已有 fence 必须显式传给 helper。ALS token、端口身份、active 都须匹配；即使父回调仍活着，派生并行 nested async 也不能另取控制快照提交。并发 commitControl 或其期间 SQL 写拒绝 `workspace_fence_busy`；遗漏 await 的 control 写会被等候后报错，锁不提前释放。control 提交不与 SQLite 冒充跨文件原子；中间失败依据已准备 intent 重放。外部取消、RPC、文件复制与资源排空在短 fence 外进行。

## 固定业务查询

同名方法由 core 静态装配，facade 返回 Promise，fence 同步返回。业务不能提交 SQL 或注册查询工厂。

| 方法 | 返回 / 范围 |
|---|---|
| `queryJobPage(filters,{scope,asOf})` / `queryApplicationPage(...)` | `{items,total,page,pageSize,asOf,revision,jobHead,readOnly}`；items 为本页 job/owner/target/application/observation/evaluation 身份与 temporalStatus |
| `readJobHead({ownerPackageId})` / `readJobHead({allTargets:true})` | `{head}`；互斥 scope。只追踪岗位事实、评价、申请、成员、关系、目标配置及 maintenance replace；排除 ledger/runEvents/sourceHealth 噪声 |
| `findJobIdentityCandidates({ownerPackageId,keys,recordIdentity?,afterJobId?,limit<=200})` | `{jobIds,hasMore,nextCursor}`；keys<=4096，候选完整性与最终分类由岗位领域合同限定 |
| `readJobBodySignatures({ownerPackageId,contentHashes})` | hashes<=1000，`{signatures:[{contentHash,simHash}]}`；只读摘要 |
| `queryJobQuality({ownerPackageId,runId?,activityId?,asOf})` | 固定 SQL 计数和时间有效性摘要；runId/activityId 互斥 |
| `queryJobRelatedPage({ownerPackageId,jobId,afterJobId?,limit<=50})` | `{jobIds,total,hasMore,nextCursor}`；普通关系、紧凑组、历史组 SQL union 后统一排序/分页 |
| `queryCollectionSnapshot({scope?,allTargets?,afterSeq?,limit<=200,asOf?,activityId?})` | `{cursor,changed,collections,...}`；cursor/变化判断/小 heads/预算/质量同快照；无变化返回空列表 |
| `queryRunHeads({scope?,allTargets?,status?,limit<=200,offset?})` | `{runs,total,hasMore}`；普通运行小 heads，不含拆分正文/快照 |
| `queryCollectionSlicePage({scope,activityId,afterId?,limit<=200})` | `{sliceRunIds,hasMore,nextCursor}`；限定同 owner、目标版本和 root，以已有 `row_refs.collectionActivityId` 索引分页读取 slice 身份；按身份升序游标，不读取正文，不存在或范围不符的 root 拒绝 |

全目标查询在 SQL count/order/LIMIT 前排除 control 删除 owner；内部 excludedOwnerPackageIds 由 repository 生成。scope 即使空结果仍核查。普通 GET 不构建或修复派生数据。`changes_job_owner(collection,owner_id,seq)`、`changes_job_id(collection,id,seq)`、`changes_job_collection(collection,seq)` 分别支持 scoped、package 身份、全目标 head 的尾部 seek，不能用 decodedRows=1 掩盖 SQL 扫描。

`getPackageCounts(packageId)` 是 SQL 只读数字统计，可为到期/待清理 DTO 使用；不提供正文。`readOperationState` 仅在 held fence 暴露，返回有界 lease 与 active run 元数据，截断必须拒绝决策。

## 明确维护接口

`exportWorkspace()` / `read()`、`replaceWorkspace(w,options)`、`withMaintenanceTransaction(action,options)` / `mutateWorkspace(action,options)` 都是全量维护兼容端口，计入 `maintenanceReads/maintenanceMutations/maintenanceTransactions`，不能用于列表、详情、预算、事件、scope或普通设置路径。旧 maintenance tx 保留 workspace/control/commitControl/commitWorkspace 与受管 snapshot 方法，仅为备份、恢复、一次性导入和待迁移消费者使用。SQL事务绝不跨越 action 的异步文件工作。

`readControl()` 返回验证后的隔离控制元数据；`metrics({reset?})` 返回 facade 和 core 指标；`checkpoint()`、`compact()`、`backupDatabase(destination)` 是显式维护操作；busy 结果保持 incomplete，不宣称清理成功；`close()` 等待本实例排队写完成再关闭。

`exportPackage(packageId,{access})` 是明确单包导出，包含该 owner 的完整闭包；不是普通详情/列表桥接。`rebuildReadModels(options?)` 是明确冷维护：无活操作，或调用者持有唯一 upgrade/restore lease；只删写固定 derived 集合，在同 SQL 事务发布 ready generations。正式 open 在共同锁内按编译的 `JOB_READ_MODEL_VERSION`（本阶段最终 v3）及 collection projection v1 检查，并用固定 prepared/complete journal 续做；未来/非法 generation 保留拒绝。业务事实、原件、migrationSourceHash 不重写。SQL trigger 的承诺仅为拒绝低于当前 ready version 的旧 projection 写，不能宣称禁止所有任意旧 SQL 写。

## 受管运行快照

`writeOwnedRunSnapshot(id,snapshot,{scope,operationLease,collectionGuard?})`：有界校验 → 短 fence 预留 snapshot/file 稳定 ID 与内容 intent → 锁外不可变文件 IO → 有界 files SQL 事务 → control complete。每一步重新核查 scope/lease/epoch。中断可按相同内容/身份重试；迟到结果不复活已停止活动，孤立副本保有可清理的持久身份。这里的 JSON 是受管不可变副本。

`readRunSnapshot(id,{scope})` 或回收管理的 `{ownerPackageId,access:'trash_read'}` 仅取所选 run/file 行，再锁外读文件；核查唯一登记、recordId、owner、内容 hash，并在交付前重查期限/控制。无 owner 的旧 read/writeRunSnapshot 仅保留维护兼容，正式执行器不得调用。

## 设置与本地凭据

业务 settings 的 SQLite 行是公开模型配置/预算唯一权威；config.json 仅启动/部署项。secret 留在本地加密凭据。成功 SQL 提交后发布 cfg 运行快照，保留10元上限和单独会话用户 key 边界。

同 settings SQL 事务保存独立 `settings.apiKeyBinding`（无明文 fingerprint + endpoint/model 绑定），该整行由 API/备份 redaction 剔除。启动读取本地 key 只验证；缺失/不匹配时停用模型并返回固定 `credentialStatus:'needs_configuration'` 和说明，规则功能继续可用。任意预算 patch 不改加密 key、不绑定空 cfg key。

明确 native save/delete 经 `credentials IPC → backend.modelKey → context.commitModelCredential → saveSettings → reverse host.credentials.saveModel → SQL binding`，主进程只写一次加密文件；返回的是业务 configured。`backend.start.modelKey` 始终只验证。软失败补偿前 key；补偿失败报告 incomplete 并阻止后续保存；凭据已写/SQL未提交的硬杀由重启绑定失配 fail-closed。`sqlite_post_commit` 不补偿已确认提交的 key。恢复的备份不携绑定，模型须重新配置。

## 指标和关闭

每 DB 最多持有256个 prepared statement 的 LRU 引用，无 iterator/跨连接复用。`statements` 保留执行次数口径；`prepares`、`statementCacheHits`、`cachedStatements`、`statementCacheLimit` 分开报告。close 清缓存并关闭真实 SQLite 句柄。control 指纹只缓存已验证当前状态；缺失/损坏/无 stat 永不命中旧控制。

`transactionReadMs/StageMs/WriteRowsMs/RefsMs/CommitMs` 与 `maintenanceFlattenMs/BuildMs/WriteRowsMs/RefsMs/CommitMs` 为聚合诊断；不是产品 p95。context shutdown 依次停止刷新/采集、设置队列、运行、附件/OCR/worker/owned resources，repository 最后关闭；前一步失败仍释放 DB，返回 failedResources，不报告 drain 成功。

## 迁移与错误边界

迁移在旧文件锁内核对活任务/lease，持有升级独占直至旧 JSON 已变为拒写 marker。源字节 hash、受管 archive、SQL导入/内容核验和切换阶段记入单调 control journal。中断后按阶段续做，完成前不返回业务端口。损坏/未来源、缺 control、冲突数据库保留拒绝。迁移 archive 与 snapshot 是受管不可变副本，可被永久清理净化，不能日常接受业务写。

拒写 marker 只位于当前 `workspace.v2.json`；旧 `workspace.v2.previous.json` 是受管历史副本，不是第二个 marker。永久清理可用原 identity/control 将合法 schema2 previous 冷规范为 schema3 并净化，先耐久身份增量再替换文件；损坏/未来 previous 保留 pending。不能修改原 sourceHash/迁移锚点。已实测 immutable c4 原 repository 的新实例及已持 warm cache 实例都拒绝 marker，不能 fallback previous 写回。

保留 core 的 `sqlite_*` 错误。`sqlite_post_commit` 的 committed=true 不可当作未提交自动重试。增加 `workspace_migration_busy`、`workspace_migration_conflict`、`workspace_repository_closed`、`workspace_fence_closed`、`workspace_maintenance_pending`；原 package/control/operation 错误继续保持。所有成功表示对应耐久步骤确实完成；跨文件动作使用 intent 和阶段状态。
