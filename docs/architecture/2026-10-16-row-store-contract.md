# SQLite 行存储端口契约（Phase 1）

2026-10-16。实现：`src/infrastructure/storage/sqlite-store.mjs`、`sqlite-schema.mjs`、`sqlite-records.mjs`。这是项目自定义端口；不是 `node:sqlite` 的方法列表。正式 repository 尚未切换，本阶段不表示现有 EXE 已提速。

## 1. 运行与写入边界

```js
import {openSqliteRowStore} from '../../infrastructure/storage/sqlite-store.mjs';
import {rowKey} from '../../infrastructure/storage/sqlite-records.mjs';
const store = openSqliteRowStore({
  filename: '/controlled/data/workspace.sqlite',
  busyTimeoutMs: 250,
  guard(input, readPort) { /* 同步检查当前控制代际、删除账本、授权 */ },
  onProjection(tx, changes) { /* 同一事务内维护已声明派生行 */ },
});
```

`openSqliteRowStore` 同步返回冻结的端口对象。先调用共同运行时守卫，再加载 `node:sqlite`；最低 Node 24.16 且小于 25，不提供 JSON fallback。连接选项复制已核实的官方 DatabaseSync 最小 API。每连接强制 WAL、synchronous=FULL、foreign_keys=ON、secure_delete=ON 并回读；不满足直接拒绝启动（`:memory:` 仅测试允许 journal=memory）。

**本端口是内部基础设施。** 正式 repository 必须对每笔短写先取得与所有 control 写共用的工作区文件锁，在锁内读最新控制/授权，再同步执行事务并提交，最后释放。这里不持有或异步获取该锁，不把独立控制文件和 SQLite 说成一个原子事务。普通 WAL 读取不取写锁。guard 在 write 和 commit 两阶段运行，但它不替代共同 fence。

`guard(input, readPort)` 与 `onProjection(tx, changes)` 必须同步；返回 Promise/thenable 直接拒绝。guard 的 readPort 只有有界 `getMeta(key)`、`getRow({collection,id})`；没有原始 SQL、数据库连接或完整工作区方法。该接口用于核心授权，不暴露给 renderer 或远程调用。guard 接收阶段、revision、owner/recordID、变化身份；不传正文。投影 hook 接收选中变化的 before/after，供准确失效。hook 只能调用同一个声明事务端口，不能另开隐式查询或异步任务。

普通事务禁止变更已存在行的 ownerPackageId、recordId。将来“授权归属转移”必须由正式维护协议提交 control prepared intent 和有效 lease，本阶段没有任意开关跳过此限制。

`getMeta`、`readChanges` 和 `exportWorkspace` 是内部元数据/维护端口，不自动进行完整业务鉴权；不能从 route 直接暴露。正式 wrapper 必须检查调用权限、当前 control、版本归属及回收过期状态。raw SQL core 只能由正式 repository 装配；完整 export 不能成为日常 read。

首次创建以 SQLite writer 锁内重判格式，再原子创建 schema 和初始元数据；锁外的空库观察不作为初始化授权。第二个首次 opener 不得重置已经提交的导入 revision、topKeys 或业务数据。

## 2. 固定数据模型

每记录一行；JSON 只保存该记录不可预测的原字段，不将工作区、整包、全部活动明细装成一行。SQL 的固定集合白名单和列名见 sqlite-schema.mjs；所有业务值绑定。数据库维护：

- collection+id 主键；全局稳定 recordId 唯一；owner→package 外键。
- 包 kind+versionId 唯一；未 purged 的规范化 kind+nameKey 唯一；版本元数据同样唯一。
- 同 owner 的 job/run/observation/application 引用由复合 FK 保证；目标成员 target+job 唯一，成员事实引用同 owner。
- 同活动 runEvents.seq 唯一；同活动 detail_credit/attachment_credit 的 kind+resourceKey 唯一。
- 业务 revision 与耐久 changes.seq；恢复不会重置变化序号。replace 的 revision=max(现有+1,源revision)，初次 import 保留源 revision。

固定集合除了原有实体，还包括：

| 集合 | 身份 / 说明 |
|---|---|
| profiles / targets | id=revisionId，一版一行；parent 分组仅供维护重组 |
| profileCopies | id=自有简历副本 revisionId；targets.profileSnapshot 的独立实体 |
| targetMembers | id=`rowKey(targetRevisionId,jobId)`；factRefs 仅为一个成员的依据 |
| runEvents | id=`rowKey(runId,'events',原数组位置字符串)`；seq SQL 索引 |
| activityUnits | id=`rowKey(runId,'collectionProgress.units',unitId)` |
| reservations | id=`rowKey(runId,'collectionProgress.ledger.reservations',reservationId)` |
| activityUsage | ledger.usage 每字段一行；ledger revision/模型身份留在小根记录 |
| runSnapshots | targetSnapshot/profileSnapshot 分别一行；默认不随 run 读取 |
| contentBodies / contentArticles / contentLinks | pendingBodies / pendingArticles / pendingOfficialLinks 每项一行 |
| articleCache / officialLinkCache | 每活动每缓存项一行 |
| conditionalCache | id=`rowKey(packageId,'collectionCache',cacheKey)`；不随 package 读取 |
| activityJobIds / runEvaluationIds | newJobIds / evaluationIds 每项一行 |
| runCoverage / runIssues / applicationEvents | 数组每条一行 |
| jobProjections | 应用维护的当前列表摘要；不是第二事实权威 |
| jobIdentityKeys / jobFactBasis / jobRelations | 固定候选身份/事实依据/关系索引集合 |
| activityMetrics / budgetUsage | 应用维护的活动指标和预算聚合；不扫描历史预约 |
| sourceRotation / maintenanceTasks | 明确来源调度与维护任务 |

`rowKey(...parts)` 仅为 JSON 数组编码，不能用手写分隔符拼接。内部 row_parts 保存少量已拆字段路径/形状，子行有 parentId/path/ordinal；维护导出能区分字段缺失、空 map/array、null 与历史未知扩展。普通写入父行不能包含拆出的字段，必须对相关子集合显式写入。不得将“读出部分 children”误认为整个集合并批量删除其余记录。

拆分子行写入前验证完整规范 ID：map 为 `rowKey(parentId,path,原key)`，预约/单元的原key还须等于 reservationId/unitId；array 末段为规范非负整数文本且等于 ordinal；value 只能是 `rowKey(parentId,path,'value')`、ordinal=0。profileCopies 特例以自身 revisionId 为键、ordinal=0。SQL 的单值 parent/path 唯一索引进一步保证基数。非法编码或第二个 scalar 子行整笔拒绝，不能在导出时静默丢弃。

schema2 只允许 `importWorkspace(w,{allowLegacy:true})`、`exportWorkspace()`、显式 `scanRows` 维护；普通读取/事务拒绝。转换 schema3 时必须提供完整工作区，执行现有全量契约和真实 FK；schema3 的私有行不能 null owner 或跨 owner 引用。全量导入可读一次历史字段，普通命令不执行 assertWorkspace 全库校验。

## 3. 读取端口（同步；均返回隔离普通值）

```ts
getMeta(key: string): Json | undefined
getRow({collection,id,ownerPackageId?}): Json | null
getRecord({collection,id,ownerPackageId?}): {id,value,indexes} | null
readView({select: Selector[],metaKeys?: string[]}): {rows,indexes,meta,pageInfo}
queryRows(selector): {rows: {id,value,indexes}[],total?,hasMore,nextCursor}
queryIds(selector): {ids: string[],total?,hasMore,nextCursor}
aggregateRows({collection,ownerPackageId?,ownerPackageIds?,where?,groupBy?,
  operation?: 'count'|'sum'|'min'|'max',field?,limit?}): {groups,hasMore}
scanRows(selector): {rows:{id,value,routing}[],hasMore,nextCursor} // 显式维护
```

Selector：

```js
{
  collection: 'evaluations',
  ownerPackageId: packageId, // 私有集合普通查询必须 owner 或 ownerPackageIds
  ids: ['evaluation-id'],   // 可选；最多1000个显式ID
  where: {jobId, targetRevisionId, profileRevisionId, factContentHash, ruleVersion},
  limit: 50, offset: 0,
  orderBy: 'score', direction: 'desc',
  total: true,
}
```

普通页默认/上限200；显式 IDs 最多1000；每 view 最多64个 selector；最多100个明确 owner。维护 scan 每页最多1000，使用 afterId 游标，禁止 Infinity 和100000以上 offset。`nextCursor` 仅默认 id 升序时提供；其他排序始终为 null，应使用稳定排序+offset。afterId 与倒序、显式 orderBy 或非零 offset 的组合直接拒绝。所有排序追加 id 作为第二键。

固定过滤/排序字段：id、ownerPackageId、parentId、path、jobId、runId/activityId、targetRevisionId、profileRevisionId、observationId、factContentHash、ruleVersion、status、kind、nextDueAt、resourceKey、checkedAt、sortAt、title、company、jobType、score、recommendation、openingStatus、applicationStatus、sourceId、siteId、ordinal、seq、nameKey。where 每字段支持标量等值、null、`{in:[...]}`（最多100项）或单个 `{lt|lte|gt|gte:value}`。无用户 SQL/LIKE/表达式透传。聚合的 sum/min/max 只允许 score/ordinal/seq；count 可按固定字段 groupBy。聚合截断必须检查 hasMore。

岗位仓储应先 `queryIds({collection:'jobProjections',ownerPackageId,where,limit:50,...})` 得到 page/total，再只读该页 jobs、当前 observations/evaluations/applications；不能 queryRows 全库后 JS filter。候选身份可用 jobIdentityKeys 的 kind/resourceKey，同一事实评价用 evaluations 或 jobFactBasis 的组合列，活动状态只取小 runs/budgetUsage/activityMetrics。固定索引在 schema 中声明；新增业务过滤需有明确固定列和验证，不用通用 SQL 注册表绕开授权。

这些是基础查询，不是全部岗位逻辑的表达式 DSL。Phase2 可在 storage 内部增加 `sqlite-job-queries.mjs` 等静态 prepared 读模块，用实际业务查询实现城市/来源数组、搜索、资格组合、期限判断及活动 join/count。由 store 内部组装，仅绑定值，经过同一 guard/一致读取边界；不把 raw db 交给业务服务或 renderer，不用 registry/factory 插件体系。基础接口不足时应补准确固定查询，不能加载全体 JSON 后 filter。

readParts 是**附加有界子选择，不会把完整 children 填回父记录**：

```js
const view = store.readView({select:[{
  collection:'runs', ownerPackageId:packageId, ids:[activityId],
  readParts:[{path:'collectionProgress.units',limit:100}],
}]});
const root = view.rows.runs[activityId]; // 不含正文/预约/事件/快照
const targetRevisionId = view.indexes.runs[activityId].targetRevisionId;
const units = Object.values(view.rows.activityUnits || {});
// 检查 pageInfo.hasMore；更多 children 用独立 collection+parentId/path 查询。
```

普通根记录缺少拆分字段是端口的设计；应用不得将其当成完整旧 workspace 再写回。多选择/rows+total 使用一个读事务快照。getRow 对不匹配 owner 返回 null；没有传 owner 的私有普通查询拒绝。

## 4. 声明事务端口

```js
const key = rowKey(activityId,'collectionProgress.ledger.reservations',reservationId);
const receipt = store.transaction({select:[
  {collection:'runs', ownerPackageId:packageId, ids:[activityId]},
  {collection:'reservations', ownerPackageId:packageId, ids:[key]},
  {collection:'budgetUsage', ownerPackageId:packageId, ids:[activityId]},
],metaKeys:[]}, tx => {
  const existing = tx.getRow({collection:'reservations',id:key});
  if (existing) return {duplicate:true};
  // 应用在这里检查 epoch/lease/聚合限额及同参身份，不能 await。
  tx.putRow({collection:'reservations',id:key,ownerPackageId:packageId,
    parent:{collection:'runs',id:activityId,path:'collectionProgress.ledger.reservations'},
    value:{reservationId,kind:'request',status:'reserved',requestUpperBound:1}});
  return {duplicate:false};
});
```

`BEGIN IMMEDIATE` 在读声明集之前取得 writer 锁。tx 有：

- `view`：声明读取的隔离 rows/indexes/meta/pageInfo；修改它不会隐式写库。
- `getRow({collection,id,ownerPackageId?})`：只能读声明 ID 或实际已读出的行。缺失的私有 ID 省略 owner 时，从不可变声明推断唯一 owner；多 owner 不明确时拒绝，不能随意挑选。
- `putRow({collection,id,value,ownerPackageId?,parent?:{collection,id,path},ordinal?,runId?,targetRevisionId?,jobId?,profileRevisionId?})`：新/缺失ID必须事先在 ids 声明；对按 where 取出的已读行可更新。现有路由默认沿用。
- `deleteRow({collection,id,ownerPackageId?})`：显式删除已读行；不因 view 缺字段或分页截断而删除未读内容。
- `getMeta(key)` / `setMeta(key,value)` / `deleteMeta(key)`：需要 metaKeys 事先声明（至多64个唯一合法key，执行前快照）。每值最多16KiB；回调修改原 metaKeys 不增加授权。最后一次操作生效，恢复原值/原缺失状态为 no-op、不提高 revision。删除缺失状态用 deleteMeta，setMeta(undefined) 拒绝。storeVersion/schemaVersion/revision/topKeys 是受管字段，普通事务不能写。

返回 `{result,revision,changes:[{collection,id,ownerPackageId,action}]}`。no-op 不提高 revision；普通事务只验证变化实体及其 SQL 引用，不全库 clone/JSON stringify/写 previous。回调/guard/projection 抛错则 rollback；异步返回拒绝，迟到续体不能再调用 tx。外部网络、文件和浏览器操作必须在事务之外。changes before/after 仅给同步投影 hook，不复制到耐久通知。

投影必须与事实同事务更新：消费者声明其 `jobProjections/jobIdentityKeys/jobFactBasis/jobRelations` 等 ID，onProjection 用同一 tx get/put/delete；未声明写入同样拒绝。应用维护当前事实选择/评价依据及 conservative candidate 语义；基础层不把相似文本自动判为重复。

## 5. 维护、变化和指标

```ts
importWorkspace(workspace,{allowLegacy?:boolean}): {schemaVersion,revision,rows}
replaceWorkspace(workspace,{allowLegacy?:boolean}): {schemaVersion,revision,rows}
exportWorkspace(): Workspace
readChanges({afterSeq?:number,ownerPackageId?:string,limit?:number}): {changes,head,nextCursor}
metrics({reset?:boolean}): Metrics
pragmas(): {journal_mode,synchronous,foreign_keys,secure_delete}
integrityCheck(): {integrity:string[],foreignKeys:object[]}
checkpoint(): {busy,log,checkpointed,complete}
compact(): {complete,busy,phase,checkpoint?}
backup(destination:string): Promise<{pages,destination}>
close(): void
```

import 只接受空库；replace 明确全量维护。二者完整验证 schema/字段/归属，单 SQL 事务替换业务记录，不覆盖外部 control 或内部授权元数据。unknown 历史扩展原值按记录保存；import→export 使用规范化字段内容哈希对照（不承诺 JSON 对象键序或空白字节相同）。显式全量维护才重组 workspace，不能拿来当日常 read。

字典用安全 own 属性保留合法的 `__proto__`/`constructor` 名称，不改变返回对象原型。JSON 输入必须是无稀疏/额外属性的数组或普通数据对象；symbol、accessor、隐藏属性和会被 JSON 静默丢弃的值拒绝。revision 的增量在提交前检查安全整数范围，耗尽后抛 sqlite_sequence_exhausted，不能提交一个下次无法打开的 revision。

changes.seq 是 SQLite AUTOINCREMENT，replace 不删除日志。通知仅含 seq/revision/collection/id/owner/topic/action。私有消费者使用 owner 过滤；owner=null 的维护通知应让投影重新核查作用域。此阶段不实现历史通知清理，后续若有清理必须返回可识别的 cursor gap。

指标区分 statements、rowsRead（实际取回的业务记录/小元数据/ID/聚合行，**不是 SQLite VM 扫描步数**）、decodedRows/decodedBytes（业务 JSON）、metaRowsRead/metaDecodedBytes（小元数据）、serializedRows/serializedBytes、rowsWritten（业务行+元数据）、transactions/commits/rollbacks、maintenanceExports/Imports。不把 count(*) 的内部扫描冒充已解码全部正文；需用 query plan 和实测时间另验搜索复杂度。元数据JSON很小，单行预算状态不会因其他目标正文增长而解码更多字节。

checkpoint 必须检查返回 busy；compact 先 TRUNCATE、再 VACUUM、再 TRUNCATE，任一步 busy 返回 complete=false。磁盘错误抛出，不能标记删除完成。SQLite清理不清除受管备份/附件/会话；正式维护任务负责它们。backup 使用官方异步 backup，只能在端口 idle 时发起；期间禁止 close/其他端口操作。生产 wrapper 在共同维护 fence 内决定一致的业务时点。

常见错误代码：sqlite_selection_invalid、sqlite_scope_required、sqlite_undeclared_write、sqlite_identity_immutable、sqlite_part_write_required、sqlite_constraint、sqlite_busy、sqlite_async_transaction、sqlite_transaction_closed、sqlite_legacy_maintenance_only、sqlite_post_commit。最后一种带 `committed:true,revision`，表示 COMMIT 已完成而后续报告失败；不得当成未提交直接重试。重放仍需业务幂等身份。磁盘损坏/未来格式不自动覆盖。

## 6. 验证边界

Phase1 验证使用 `.cache/sqlite-row-store-tests/` 的合成数据库。包含千/万岗位规模与大正文、真 FK/唯一键、跨 owner、回滚/异步拒绝、caller 隔离、完整导出哈希、真实备份/PRAGMA/checkpoint、两进程竞争及提交前后强杀。它不证明生产迁移、全部应用消费者、受管文件清理或 EXE 启动已经完成；这些属于 Phase2/3。
