# 岗位库、版本与保存目录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已选择当前会话执行，本计划使用 superpowers:executing-plans，保留该选择。

**Goal:** 修复版本操作，以唯一名称管理全部版本，保守清理全版本重复岗位，并使分类、保存位置及操作反馈清楚可用。

**Architecture:** 延续 Node/Electron 与单个 JSON 工作区的原子事务。版本管理元数据、版本岗位成员和旧岗位 ID 重定向分开存储；清理经预览、操作门禁、备份后执行。历史事实、观察、评价与快照保持不可变，消费者统一解析引用。

**Tech Stack:** Node.js >=20、ES modules、Electron 44.5.1、现有 JSON repository/跨进程锁、node:test、linkedom；不新增数据库或界面框架依赖。

**Spec:** [2026-10-08-workspace-version-and-dedup-design.md](../specs/2026-10-08-workspace-version-and-dedup-design.md)，用户已于 2026-10-08 确认。

代码基线：`a4036016d0cd09e5f44902a69b48a40e75260f81`；设计提交：`7c66faa`；工作分支：`codex/v2-upgrade`。本计划已获用户确认，执行中。

## Global Constraints

- 目标版本名称必填，1–60 个字符。名称只作为显示元数据，不作为文件路径。
- 唯一键使用 NFKC、首尾去空白、连续空白折叠、英文大小写统一；保留有意义的内部空格与标点。
- 目标名称在当前工作区全部目标版本中唯一，包括停用及回收站版本。
- 同一 `jobId` 同时属于多个目标版本属于正常使用关系，不是多份岗位实体。
- 不改写不可变评价、来源观察、历史运行快照和它们的哈希。
- 组内多于一条有人工记录时默认保护整组，即使状态看似相同也不自动覆盖。
- 预览期间岗位或人工记录变化则提示刷新，不执行过期清理。
- 采集任务或独立重评分正在运行时不执行全局去重或永久删除。
- 不修改原始简历、画像事实、人工备注或旧快照内容，不把版本名称写进模型输入。
- 保留原模型 10 元预算和隐私规则；本轮不发起付费模型调用或自动重新采集个人招聘目标。
- 维持现有数据根目录与 `RJR_DATA_DIR` 覆盖规则；不自动合并开发、其他工作树和正式桌面数据。
- 浏览器导出提示“导出已生成，已开始下载”；公开 Web 不提供私人路径 API，日志不记录绝对路径。
- 所有回归使用合成数据及隔离目录。升级补齐关系，不自动执行日常数据清理。

## Review Focus

1. 全角/大小写/空白等价名称和网络重试并发到达：只保存一份；同提交标识不同内容拒绝。由 Task 2 验证。
2. 简历只在投递历史事件中被引用，或活动任务间接使用它：不得永久删除；活动期间不得移入回收站。由 Task 2、5 验证。
3. 旧版观察使用 `record`、手工观察没有真实 run、旧评价只有正文哈希：不能丢失归属、误报损坏或借用不匹配分数。由 Task 4、7 验证。
4. 来源编号跨年复用、URL 是通用申请页、城市集合部分重叠、相似关系形成链：保留不同招聘机会。由 Task 3、6 验证。
5. 清理预览后新增人工备注，运行已结束但快照未落盘，或恢复旧备份：拒绝过期/竞争写入，恢复后无残留重定向。由 Task 1、5、6 验证。

---

## 文件与接口地图

以下路径均相对仓库根目录；已有大文件只改对应入口，不进行无关重构。

| 边界 | 新文件 | 改动现有文件 |
| --- | --- | --- |
| 管理数据与升级 | `src/domain/workspace-management.mjs`、`src/infrastructure/storage/upgrade-workspace.mjs` | `contracts.mjs`、`backup.mjs`、`context.mjs`、`src/store.mjs` |
| 版本事务 | `src/domain/version-names.mjs`、`src/domain/version-references.mjs` | `workspace-service.mjs`、`routes-v2.mjs`、`src/cli.mjs`、`src/pipeline.mjs` |
| 岗位身份与引用 | `src/domain/job-duplicates.mjs`、`src/domain/job-resolution.mjs`、`src/domain/job-facts.mjs` | `identity.mjs`、`record.mjs`、`job-service.mjs`、`evaluation-service.mjs`、来源适配器 |
| 操作门禁与清理 | `src/application/workspace-operations.mjs`、`src/application/job-cleanup-service.mjs` | `repository.mjs`、`recovery.mjs`、`run-service.mjs`、`import-service.mjs`、`context.mjs`、路由 |
| 版本界面 | `public/js/version-management.js`、`public/js/components/version-list.js` | `profiles.js`、表单、`state.js`、`workbench.js`、`feedback.js`、样式 |
| 岗位库界面 | `public/js/components/duplicate-cleanup.js` | `jobs.js`、筛选/列表/详情、`jobs-data.js`、投递页 |
| 本地目录 | `src/infrastructure/storage/layout.mjs`、`electron/directories.mjs`、`public/js/components/data-locations.js` | `config.mjs`、fontmap/university 缓存、Electron main/preload、settings |
| 兼容与交付 | 无独立兼容数据副本 | `run-events.mjs`、`export-service.mjs`、`routes-v1.mjs`、`store.mjs`、`pipeline.mjs`、桌面自检、打包验证、使用文档 |

### 数据契约

沿用 `schemaVersion:2`，新字段可缺省以读取旧账本；出现时严格验证。管理视图与不可变事实分离：

- `managementVersion:1`、`membershipVersion:0|1`：扩展迁移标记。
- `versionMetadata[revisionId] = {kind:'profile'|'target', versionName, nameKey, enabled, archivedAt:null|ISO, updatedAt}`。画像的 `enabled` 固定为 true；目标有效启停读元数据，旧配置中的 enabled 不改写。
- `versionCounters = {profile:{[profileId]:maxRevision}, target:{[targetId]:maxRevision}}`；永久删除不回收序号。
- `versionSubmissions[kind+':'+submissionId] = {revisionId,inputHash}`；只存哈希，不存请求正文。
- `targetMembers[targetRevisionId][jobId] = {firstSeen,lastSeen,currentObservationId,factContentHash,factRefs}`。`factRefs` 项为 `{observationId,factContentHash,runId:null|string,provenanceOperationId:null|string,observedAt}`，合并时按 observationId 去重保留。
- `jobRedirects[oldJobId] = {toJobId,operationId,mergedAt}`；扁平化到仍存在的实体，不形成环。
- `dedupOperations[operationId] = {at,planHash,counts,backupId}`，不存岗位正文、个人信息或绝对路径。
- `operationLeases[operationId] = {kind,ownerPid,token,targetRevisionId,profileRevisionId,startedAt}`；属于运行态，不导出到业务备份，不记录 token。恢复期间仅临时保留本次恢复租约，释放后清空。

公共版本返回 `{...immutableRevision,versionName,enabled,archivedAt,availability}`；画像名称不得覆盖 `profile.name`。`availability = {canCollect,canRescore,reasonCode}`；停用只阻止新采集，回收站目标或画像阻止新采集及新评分。

结构化错误沿用现有 HTTP 格式及 `fieldErrors`，新增小写固定代码：`version_name_conflict`、`version_submission_conflict`、`version_submission_retired`、`version_parent_mismatch`、`version_archived`、`version_referenced`、`workspace_operation_busy`、`duplicate_plan_stale`、`job_identity_ambiguous`。

### 验证命令约定

在仓库根目录的 PowerShell 使用：

```powershell
$rjrNode = Join-Path (Get-Location) '.cache/node20-runtime/node-v20.20.2-win-x64/node.exe'
& $rjrNode --version
function Invoke-RjrTest {
  $rjrPriorDataDir = $env:RJR_DATA_DIR
  try {
    $env:RJR_DATA_DIR = Join-Path (Get-Location) '.cache/workspace-management-tests/data'
    & $rjrNode --import './tests/helpers/network-guard.mjs' --test @args
  } finally {
    $env:RJR_DATA_DIR = $rjrPriorDataDir
  }
}
```

预期 `v20.20.2`。每个新 shell 先定义以上变量与测试函数；下文单项测试命令使用 Invoke-RjrTest，预期 exit 0、failed 0，禁止非本机网络。RED 命令预期相关行为断言失败，不能以语法错误冒充回归。Windows 临时目录原子重命名或共用 Git 目录写入受限时按现有授权走工具审批，不改用日常数据目录。每次提交仅暂存当前任务列出的文件。已有合成 setup 的 saveTarget 请求同时补齐名称/提交标识，不降低新版本校验要求；集中维护在 tests/helpers/fixtures.mjs 和调用它的现有测试。

## Task 1：管理扩展、可恢复升级与旧备份完整替换

**Files:** Create `src/domain/workspace-management.mjs`、`src/infrastructure/storage/upgrade-workspace.mjs`；Modify `src/domain/contracts.mjs`、`src/infrastructure/storage/backup.mjs`、`src/application/context.mjs`、`src/store.mjs`；Test 新建 `tests/integration/workspace-management.test.mjs`，修改 `tests/e2e/migration-recovery.test.mjs`。

**Interfaces:**
- Produces `normalizeWorkspaceExtensions(workspace) -> Workspace`：返回副本，补齐管理字段、稳定旧名称/序号，不修改事实；`assertWorkspaceExtensions(workspace) -> void`。
- Produces `upgradeWorkspace({repository,clock}) -> Promise<{changed,backupId}>`：外层检测、持锁复核，在确需迁移时先备份当前业务状态。
- Extend `createBackup({repository,clock,workspaceSnapshot}) -> {path,backupId,manifest}`：backupId为生成档案的basename，不含绝对路径；可接受锁内准确副本，快照读取不重入工作区锁。`restoreBackup({repository,archivePath,operationLease})` 先验证原档案哈希，再规范化并完整替换业务字段。
- Consumes `repository.mutateWorkspace(fn)`、现有不可变 snapshot/backup 校验。

- [x] **1. 写失败测试。** 使用 `tempRepository` 构造旧账本、旧备份和含扩展字段的恢复前账本；测试名 `upgrade is idempotent and preserves facts`、`old restore replaces extension state`、`failed upgrade keeps valid workspace`。断言：
  ```js
  assert.equal(second.changed, false);
  assert.deepEqual(after.profiles, before.profiles);
  assert.deepEqual(after.observations, before.observations);
  assert.deepEqual(restored.jobRedirects, {});
  assert.deepEqual(restored.targetMembers, {});
  assert.equal(backupCreatedBeforeWrite, true);
  ```
  验证旧 ID、评价和 snapshot 哈希相同，备份失败不写账本；缺字段可读、坏类型/重定向环/重复名称拒绝。
- [x] **2. RED。** `Invoke-RjrTest tests/integration/workspace-management.test.mjs tests/e2e/migration-recovery.test.mjs`，预期升级或旧恢复残留断言失败。
- [x] **3. 实现管理规范化、验证和升级入口。** 旧目标名为“岗位方向 · v序号 · 短ID”，冲突时确定性扩展 ID；画像默认日期+revisionId。不自动删除岗位。`context` 与独立 store 均升级；Task 4 再接成员回填。
- [x] **4. 实现备份与恢复兼容。** 清除运行态租约能力，保持业务备份完整；替换时删除旧对象业务键后写入规范化档案，保留仓库 revision 计数。禁止用 Object.assign 单独覆盖旧业务键。
- [x] **5. GREEN。** 运行步骤 2 及 `tests/integration/repository.test.mjs`、`tests/integration/migration.test.mjs`；预期全部通过，备份可以整体还原。
- [x] **6. Commit。** 暂存本任务 Files，`git commit -m "feat: add recoverable workspace management extensions"`。

## Task 2：唯一版本名称、幂等保存及管理操作 API

**Files:** Create `src/domain/version-names.mjs`、`src/domain/version-references.mjs`；Modify `src/application/workspace-service.mjs`、`src/server/routes-v2.mjs`、`src/cli.mjs`、`src/pipeline.mjs`、`tools/eval-matching.mjs` 的合成目标构造；Test 新建 `tests/unit/version-names.test.mjs`、`tests/integration/version-management.test.mjs`，更新 `tests/helpers/fixtures.mjs`、`tests/integration/workspace-service.test.mjs`、`tests/integration/api-v2.test.mjs`。

**Interfaces:**
- Produces `normalizeVersionName(value) -> {versionName,nameKey}`，按 Unicode 字符计长；`countVersionReferences(workspace,{kind,revisionId,excludeOperationId=null}) -> {targets,runs,evaluations,members,applications,applicationEvents,activeOperations}`。永久删除排除本次exclusive租约自身，不能排除其他活动操作。
- Extend `saveProfile(input)`/`saveTarget(input)` 接收 `versionName,submissionId`；画像名可缺省，目标新版本必填。hash 包含父 ID、名称和配置，排除 submissionId/运行元数据；名称字段不进入画像事实。
- Produces `updateVersion({kind,parentId,revisionId,versionName?,enabled?})`、`archiveVersion(...)`、`restoreVersion(...)`、`permanentlyDeleteVersion(...)`，均返回公共版本视图或明确删除结果。
- Routes `/api/v2/{profiles|targets}/:id/revisions/:revisionId` 的 GET/PATCH/DELETE；POST 同路径 `/restore`，DELETE `/permanent`。新增 targets 的版本 GET/POST；原 profile DELETE 改默认移入回收站。旧 targets PUT 创建新配置版本，旧 PATCH 仅支持显式 revisionId 的管理操作，否则给字段错误，不猜最新版本。

- [x] **1. 写失败测试。** 名称边界 0/1/60/61，`" ＡＢＣ  方向 "` 与 `"abc 方向"` 冲突；保留 `"机场-消防"` 与 `"机场 消防"` 的区别。并发调用验证：
  ```js
  assert.equal(successfulCreates.length, 1);
  assert.equal(replayed.revisionId, first.revisionId);
  assert.equal(afterRename.targets.length, beforeRename.targets.length);
  assert.equal(afterToggle.targets[0].revisionId, saved.revisionId);
  assert.equal(afterPermanentDelete.versionCounters.target.t1, 2);
  ```
  同 nonce 不同内容拒绝；已永久删除的 nonce 重试返回 retired；回收站名仍占用；错父路径拒绝。设置旧来源已删除/模型已变化，停用仍成功，新配置仍完整校验。仅投递事件 from/to 引用的画像不能永久删除。
- [x] **2. RED。** `Invoke-RjrTest tests/unit/version-names.test.mjs tests/integration/version-management.test.mjs tests/integration/workspace-service.test.mjs`，预期名称、元数据或回收站行为失败。
- [x] **3. 实现纯名称/引用规则。** 画像和目标独立命名空间，覆盖运行顶层与 frozen target、评价、全部投递包括未解决记录、事件 from/to、成员及活动租约。自己的原名称不冲突。
- [x] **4. 实现版本事务及路由。** 锁内占名/nonce/序号分配；状态操作不走 saveTarget 配置校验；配置保持 immutable。回收站可引用、永久删除必须无引用。CLI/legacy 系统创建版本生成明确稳定名称及提交标识，不能绕过占名规则。
- [x] **5. GREEN。** 运行步骤 2 加 `tests/integration/api-v2.test.mjs tests/integration/cli-compat.test.mjs`；将既有物理删除断言更新为用户批准的回收站语义，不削弱引用保护。
- [x] **6. Commit。** `git commit -m "feat: manage uniquely named target and resume versions"`。

## Task 3：保守身份判定与重复采集幂等

**Files:** Create `src/domain/job-duplicates.mjs`、`src/domain/job-resolution.mjs`；Modify `src/domain/identity.mjs`、`src/domain/record.mjs`、`src/application/job-service.mjs`、`src/application/import-service.mjs`、`src/match/article.mjs`；来源改动为 `src/sources/adapters/shared.mjs`、`tencent.mjs`、`greenhouse.mjs`、`smartrecruiters.mjs`、`ncss.mjs`、`university-91job.mjs`、`legacy.mjs`、`social-discovery.mjs`（均在同一 adapters 目录）；Test 新建 `tests/unit/job-duplicates.test.mjs`，更新 `tests/unit/identity.test.mjs`、`tests/integration/job-service.test.mjs`。

**Interfaces:**
- Produces `classifyJobDuplicate(left,right,{leftProvenance,rightProvenance}={}) -> {relation:'confirmed'|'possible'|'distinct',reasonCodes}`。
- Extend `resolveJobIdentity(record,{provenance}={})`，保留旧 key/aliases 返回形状，增加招聘事项 occurrenceKey；`relateJobs` 为兼容层映射 confirmed→same。
- Produces `resolveJobId(workspace,id,{allowMissing=false}={}) -> string|null`、`resolveJobIds(...) -> string[]`、`jobIdMatches(workspace,storedId,requestedId) -> boolean`、`resolveApplicationAssociation(workspace,application) -> {status,jobIds,originalApplicationId}`。歧义别名不任取第一条。
- 可信 provenance 为适配器生成的 `{sourceRecordIdKind:'authority'|'generated'|'hint',urlKind:'job_detail'|'job_apply'|'notice_detail'|'listing'|'campaign'|'unknown'}`；用户请求不得自行提升权威性。旧来源缺证明时保守降级；不能按 UUID 外形推断 generated，真实 API 岗位编号可能也是 UUID。

- [x] **1. 写失败测试。** 参数化覆盖种类/公司分支/标题/城市集合/届别/批次/年份/类型/职级/学历/经验/证书/工作方式冲突；同编号跨年 distinct，同通用 URL 不同岗位 distinct，缺字段/短正文/模板 possible。断言：
  ```js
  assert.equal(classifyJobDuplicate(beijing, beijingAndShanghai).relation, 'distinct');
  assert.equal(classifyJobDuplicate(oldCohort, newCohort).relation, 'distinct');
  assert.equal(classifyJobDuplicate(templateA, templateB).relation, 'possible');
  assert.equal(Object.keys(afterThreeManualImports.jobs).length, 1);
  assert.equal(Object.keys(afterThreeManualImports.observations).length, 3);
  ```
  URL 保留未知/签名/jobid/hash，仅剔已知追踪参数；随机 UUID 不成为编号冲突。同业务内容不同运行元数据相同；正文/资格不同则不碰固定后缀。
- [x] **2. RED。** `Invoke-RjrTest tests/unit/job-duplicates.test.mjs tests/unit/identity.test.mjs tests/integration/job-service.test.mjs`。
- [x] **3. 实现判定器及来源证明。** 冲突先于编号/URL捷径；标题只做 Unicode/空白规范化，城市比较规范化完整集合。确定重复要求 spec §6 的事实证据；仅以正文证明时，去首尾空白后不足30字符、占位/导航/验证码/泛化模板或缺关键事实只能疑似。完整内容证明要求有效公司/标题、实际职责或资格、条件无冲突；无链接手工完整输入按全部业务输入指纹幂等。shared默认hint；腾讯/Greenhouse/SmartRecruiters真实来源编号、NCSS岗位编号及91job岗位编号按已校验scope声明authority，公告/窗口URL独立标记。SmartRecruiters未验证applyUrl不提升；legacy仅明确岗位编号生产者可声明authority，social保持hint；import与article派生编号显式generated。
- [x] **4. 接入 ingest/import 与有界引用解析。** 生成身份排除 UUID/任务 ID/模型 ID；不同事实使用完整业务内容指纹和招聘事项区分实体。解析 oldID/alias 时检查环、最终实体和歧义；先统一该服务现有读写，Task 7 覆盖其他消费者。
- [x] **5. GREEN。** 运行步骤 2 加 `tests/integration/resume-import.test.mjs tests/integration/source-detail-retention.test.mjs`；相同无链接内容三次不冲突，保留三次观察。
- [x] **6. Commit。** `git commit -m "fix: distinguish recruitment occurrences before merging identities"`。

## Task 4：精确版本成员、事实依据与评价缓存

**Files:** Create `src/domain/job-facts.mjs`；Modify `src/application/job-service.mjs`、`src/application/evaluation-service.mjs`、`src/application/run-service.mjs`、`src/application/import-service.mjs`、`src/infrastructure/storage/upgrade-workspace.mjs`、`src/infrastructure/storage/backup.mjs`、`src/domain/contracts.mjs`、`src/server/routes-v2.mjs`；Test 新建 `tests/integration/job-membership.test.mjs`、`tests/integration/evaluation-facts.test.mjs`，修改 `tests/integration/rescore.test.mjs`。

**Interfaces:**
- Produces `jobFactHash(record) -> string`，前缀 `job-fact-v1:`，稳定序列化内容/资格/批次/日期/薪资等业务字段，排除 identity/URL/采集时间/解析与运行元数据；正文原样参与哈希，不改引文。
- Produces `backfillTargetMembers(workspace) -> {changed,assigned,unassigned}`、`selectVersionJobFact(workspace,{targetRevisionId,jobId}) -> {status,record,factContentHash,observationIds,originalJobId}`、`resolveEvaluationFactBasis(workspace,evaluation) -> {status,factContentHash,observationIds,reasonCode}`、`selectMatchingEvaluation(workspace,{jobId,targetRevisionId,profileRevisionId,factContentHash}) -> Evaluation|null`。
- Extend `ingestRecords({runId,records,observedAt,targetRevisionId,provenanceOperationId})`；run 从冻结版本传入，import 可传目标版本或不归属。
- Extend `queryJobs(filters)`/`getJob(id,{targetRevisionId}={})`，严格成员过滤/版本事实；新评价追加 `observationId,factContentHash`。旧 jdHash 保持原值。

- [x] **1. 写失败测试。** 同实体两个版本、一个未评价记录、目标级旧关联、import-UUID 无 runs 节点、v1 `observation.record`。精确查询同时传 targetId/versionId，父版本不符报错。断言：
  ```js
  assert.equal(versionWithoutEvaluation.total, 1);
  assert.equal(otherVersion.total, 0);
  assert.equal(selected.record.degree, '本科');
  assert.equal(selectedEvaluation, null); // 最新评价对应另一份事实
  assert.equal(cachedProjection.jobId, canonicalId);
  assert.equal(oldEvaluation.jdHash, beforeHash);
  ```
  旧完整记录 hash、包含旧jobId的 jdHash、v1正文 hash 分别校验；无法对应显示 historical，不借最新分。正文/学历改变 hash 改变，内部 ID/时间改变 hash 不变。
- [x] **2. RED。** `Invoke-RjrTest tests/integration/job-membership.test.mjs tests/integration/evaluation-facts.test.mjs tests/integration/rescore.test.mjs`。
- [x] **3. 实现回填与版本事实投影。** 优先 run冻结目标+观察，评价仅补充可验证关系；没有事实证据标缺失。按 observedAt、稳定 observationId 选择版本当前依据，factRefs 保留所有证据；不假分配目标级旧数据。升级/旧恢复接回填，完成后 membershipVersion=1。
- [x] **4. 接入入库、查询、详情及 evaluate/rescore。** 缓存同时约束事实 hash、画像/目标/prompt/rule/model；旧缓存命中返回主 ID 投影，不改旧评价。rescore 只取指定版本成员及其事实，原始观察与 snapshot 不改写。
- [x] **5. GREEN。** 运行步骤 2 加 `tests/integration/evaluation.test.mjs tests/integration/run-service.test.mjs tests/e2e/migration-recovery.test.mjs`；同版本成员最多一条，无评价也可见。
- [x] **6. Commit。** `git commit -m "feat: scope jobs and evaluations to version fact evidence"`。

## Task 5：跨进程操作门禁与回收站可运行状态

**Files:** Create `src/application/workspace-operations.mjs`；Modify `src/infrastructure/storage/repository.mjs`、`src/infrastructure/storage/recovery.mjs`、`src/infrastructure/storage/upgrade-workspace.mjs`、`src/infrastructure/storage/backup.mjs`、`src/application/context.mjs`、`src/application/workspace-service.mjs`、`src/application/run-service.mjs`、`src/application/evaluation-service.mjs`、`src/application/import-service.mjs`、`src/pipeline.mjs`、`src/store.mjs`；Test 新建 `tests/integration/workspace-operations.test.mjs`、`tests/helpers/operation-process.mjs`，更新 `tests/integration/run-service.test.mjs`、`tests/integration/rescore.test.mjs`。

**Interfaces:**
- Produces `createWorkspaceOperationGate({repository,clock,isOwnerAlive})`，方法 `acquire(kind,{targetRevisionId,profileRevisionId,parentLease,expectedWorkspaceRevision,signal}={}) -> Promise<Lease>`、`withOperation(kind,options,action) -> Promise<result>`；Lease 为 `{operationId,token,acquiredRevision,release()}`，只通过内部调用传递。
- shared kinds：`collect,evaluate,import,legacy`；exclusive kinds：`cleanup,permanent-delete,restore,upgrade`。同锁检查并登记，活动 shared 与 exclusive 互斥。
- Extend `repository.mutateWorkspace(fn,{operationLease=null,operationMaintenance=false}={})`：exclusive 存在时普通业务写拒绝；maintenance 仅允许更改租约且校验其余业务摘要未变。lease token 验证失败拒绝。Extend `writeRunSnapshot(id,snapshot,{operationLease=null}={})` 同样验证 exclusive/lease。
- Extend内部 `startRun/evaluate/rescore/import` 支持父 operationLease；正常公开 API 不接收 token。

- [x] **1. 写失败测试。** 两 repository/真实子进程竞争；一个运行停在最后 snapshot write，一个 standalone rescore 停在评价；exclusive 均拒绝。断言：
  ```js
  assert.equal(cleanupError.code, 'workspace_operation_busy');
  assert.equal(snapshotWrittenBeforeLeaseRelease, true);
  assert.equal(restoredProfile.revisionId, originalProfile.revisionId);
  assert.equal(newRunRejectedWhenProfileArchived, true);
  assert.equal(newRescoreRejectedWhenProfileArchived, true);
  ```
  活动间接画像不能 archive；停用不取消既有 run；恢复后重算状态。测试活 PID 不回收、死 PID 可回收、异常/取消释放、检查后启动竞争只有一方成功；故障诊断无 token/路径。
- [x] **2. RED。** `Invoke-RjrTest tests/integration/workspace-operations.test.mjs tests/integration/run-service.test.mjs tests/integration/rescore.test.mjs`。
- [x] **3. 实现持久租约、repository 写保护与恢复。** isOwnerAlive 复用 hasLiveOwner 的保守 PID 判定；先清理确已终止的操作。无需长时间持有文件锁；所有租约业务改动仍走原子事务，不能重入 mutate。
- [x] **4. 接入全流程租约与版本状态。** 排队 run 从登记起持有，直到最终 snapshot 和失败收尾结束再释放；RunGate 配额独立。run 内评价复用父 lease；standalone评分独立取得；legacy 覆盖画像/目标创建到snapshot，import覆盖获取、入库及人工备注。恢复/永久删除/升级使用 exclusive；archive 锁内检查间接引用活动。
- [x] **5. GREEN。** 运行步骤 2 加 `tests/integration/api-v1-compat.test.mjs tests/integration/atomic-storage.test.mjs`；父lease复用不自阻塞，失败恢复无残留能力。
- [x] **6. Commit。** `git commit -m "fix: coordinate cleanup with collection scoring and snapshot writes"`。

## Task 6：全版本重复预览、备份与原子清理

**Files:** Create `src/application/job-cleanup-service.mjs`；Modify `src/domain/job-duplicates.mjs`、`src/domain/job-resolution.mjs`、`src/domain/contracts.mjs`、`src/application/context.mjs`、`src/server/routes-v2.mjs`；Test 新建 `tests/integration/job-cleanup.test.mjs`。

**Interfaces:**
- Produces `buildWorkspaceDuplicatePlan(workspace) -> {workspaceRevision,planHash,groups,possiblePairs,protectedGroups,counts}`；组 `{groupId,keepJobId,removeJobIds,reasonCodes,targetRevisionIds,protected}`。
- Produces `applyWorkspaceDuplicatePlan(workspaceDraft,plan,{operationId,at}) -> counts`，同步修改业务副本，不执行 IO。
- Produces `createJobCleanupService({repository,operationGate,clock})` 的 `preview()` 与 `apply({workspaceRevision,planHash,selectedGroupIds}) -> {operationId,counts,backupId}`；POST `/api/v2/jobs/duplicates/preview` 和 `/apply` 在动态 jobID 路由之前匹配。
- counts 固定 `{confirmedGroups,removedEntities,collapsedVersionEntries,affectedVersions,possiblePairs,protectedGroups}`；planHash 排除 revision/operationLeases，包含所有影响合并及人工保护的业务状态。

- [x] **1. 写失败测试。** 全部正常/停用/历史/回收站成员和未归属重复都参与；同ID多版本引用不算删除。一组只有一个人工记录保留它，两条直接或间接 legacy 人工记录保护整组；链式三记录不全并。断言：
  ```js
  assert.equal(result.counts.removedEntities, 2);
  assert.equal(result.counts.collapsedVersionEntries, 1);
  assert.deepEqual(after.applications[manualId], before.applications[manualId]);
  assert.equal(resolveJobId(after, removedId), keptId);
  assert.deepEqual(after.evaluations, before.evaluations);
  assert.equal(staleError.code, 'duplicate_plan_stale');
  ```
  覆盖预览后备注/版本/岗位改变、伪造组选中、备份失败/原子写失败无部分删除、空清理；成功后重发原apply返回过期预览，不再次删除或生成成功计数。所有历史 hashes 保持。
- [x] **2. RED。** `Invoke-RjrTest tests/integration/job-cleanup.test.mjs tests/unit/job-duplicates.test.mjs`。
- [x] **3. 实现确定性计划。** 先按安全身份候选索引缩小比较，再逐对判定；每组所有成员互相 confirmed。主记录按人工→权威→完整度→最早→ID选择。未知/疑似不选中，人工保护按独立 application 记录去重计数，不仅查看 jobs 上的状态。
- [x] **4. 实现清理事务。** acquire 时在锁内验证 preview revision，再在业务 mutate 内要求 `w.revision===lease.acquiredRevision` 且 hash相符，避免自身租约误报过期。该锁内先对准确副本 createBackup，成功后合并非冲突事实/sourceRefs/aliases、全部 members及factRefs，生成扁平 redirects并移除多余实体。投递记录、观察、评价、快照不改写；最后验证引用。租约释放在 finally。
- [x] **5. GREEN。** 运行步骤 2 加 `tests/integration/workspace-operations.test.mjs tests/e2e/migration-recovery.test.mjs`；用清理前备份整体恢复并核对业务数据，不提供单组撤销。
- [x] **6. Commit。** `git commit -m "feat: preview and safely clean duplicates across all versions"`。

## Task 7：旧 ID、历史事实与兼容入口完整接通

**Files:** Modify `src/application/job-service.mjs`、`src/application/evaluation-service.mjs`、`src/application/run-service.mjs`、`src/application/run-events.mjs`、`src/application/export-service.mjs`、`src/server/routes-v1.mjs`、`src/server/routes-v2.mjs`、`src/store.mjs`、`src/pipeline.mjs`；Test 新建 `tests/integration/job-redirects.test.mjs`，修改 `tests/integration/run-events.test.mjs`、`tests/integration/api-v1-compat.test.mjs`、`tests/integration/cli-compat.test.mjs`。

**Interfaces:** Consumes Task 3 的 resolveJobId/resolveApplicationAssociation、Task 4 的事实选择；现有 getJob/updateApplication/link/unlink/saveEvaluations/finalizeCoverage、legacy view/saveIndex/upsert/annotate 等内部统一解析。GET详情可携带 targetRevisionId；返回主jobId并保留原查询ID供前端替换。

- [x] **1. 写失败测试。** 使用 Task 6 已合并合成集，对 oldID 读详情、修改投递、单条/批量评分、解除关联、source alias再入库、分页导出、SSE重连快照、legacy store/v1 tracking 各走实际入口。断言：
  ```js
  assert.equal(oldDetail.jobId, keptId);
  assert.equal(legacyApplication.association.status, 'single');
  assert.equal(legacyApplication.association.jobIds.length, 1);
  assert.equal(replayedRecord.description, originalRunDescription);
  assert.equal(exportedRows.filter(row => row.jobId === keptId).length, 1);
  assert.equal(Object.keys(afterReingest.jobs).length, 1);
  ```
  旧歧义投递原事件/legacy候选ID保留；两个真正不同事项别名仍歧义；旧缓存输出主ID；snapshot正文与人工当前状态分开投影。
- [x] **2. RED。** `Invoke-RjrTest tests/integration/job-redirects.test.mjs tests/integration/run-events.test.mjs tests/integration/api-v1-compat.test.mjs`。
- [x] **3. 接通服务及快照/导出消费者。** 包括观察聚合、覆盖统计、未解决投递列表/详情、application事件引用、v1 summary；run-events 从该run观察构造原事实，不能直接 w.jobs[oldID] 或全局新canonical。
- [x] **4. 接通独立 store 与 pipeline。** store启动升级，所有 status/note/evaluation/upsert入口解析；snapshotToLegacy保持snapshot原事实和评价对应，只将当前人工状态从主ID读入。无悬空实体或重复行。
- [x] **5. GREEN。** 运行步骤 2 加 `tests/integration/cli-compat.test.mjs`；运行 `& $rjrNode tools/test-store.mjs` 和 `& $rjrNode tools/test-export.mjs`，预期 exit0。
- [x] **6. Commit。** `git commit -m "fix: retain historical access through merged job redirects"`。

## Task 8：版本列表、按钮、表单同步与可见成功提示

**Files:** Create `public/js/version-management.js`、`public/js/components/version-list.js`；Modify `public/js/pages/profiles.js`、`public/js/pages/workbench.js`、`public/js/state.js`、`public/js/components/profile-form.js`、`public/js/components/target-form.js`、`public/js/components/application-form.js`、`public/js/components/feedback.js`、`public/js/components/shell.js`、`public/styles/components.css`、`public/styles/layout.css`；Test 新建 `tests/integration/ui-version-management.test.mjs`，修改 `tests/integration/ui-profiles.test.mjs`、`tests/integration/ui-profile-validation.test.mjs`、`tests/integration/ui-model-money.test.mjs`、`tests/integration/ui-workbench.test.mjs`。

**Interfaces:**
- Produces `upsertVersion(versions,saved) -> Version[]`、`versionLabel(version) -> string`、`versionAvailability(target,profiles) -> availability`；state新增 `versionUpdated` 管理更新，不清空岗位/运行。
- Produces `versionList(document,{versions,kind,onRename,onToggle,onArchive,onRestore,onPermanentDelete}) -> {node,update}`，两组及状态筛选全部版本；引用保护显示类别数量。
- Extend `targetForm(document,{target,profiles,model,onSubmit,...})`：显式配置字段、新名称空白，model从安全 settings读入；submissionId一次编辑提交生成，网络重试复用，成功/内容改变后重建。
- Extend `feedback(document)` 的 `show(text,error=false,{notify=false}={})`：兼容旧调用，notify=true触发 shell 的可见 aria-live 通知；行内同时显示。成功通知可关闭并显示至少6秒，错误保持到关闭/下一操作；普通 show('') 不清全局操作通知。

- [x] **1. 写真实点击失败测试。** 打开同组多个命名版本；编辑→停用→另存新名，payload不含旧enabled；已有10元预算加载实际model后前端合法。断言：
  ```js
  assert.equal(createRequests.length, 1); // 忙时连击
  assert.equal(toggleRequests[0].revisionId, selectedRevisionId);
  assert.equal(savedList.filter(v => v.revisionId === savedId).length, 1);
  assert.equal(store.getState().targetRevisionId, selectedRevisionId);
  assert.match(visibleNotification.textContent, /已停用/);
  assert.equal(notificationSurvivesReadRefresh, true);
  ```
  重名/失败保留输入；rename不清岗位；archive/restore保持原ID，画像回收站禁运行/评分、旧投递画像标签仍显示但不可新选。开始按钮各恢复路径依据 availability，不无条件启用。
- [x] **2. RED。** `Invoke-RjrTest tests/integration/ui-version-management.test.mjs tests/integration/ui-profiles.test.mjs tests/integration/ui-model-money.test.mjs tests/integration/ui-workbench.test.mjs`。
- [x] **3. 实现统一版本组件和通知。** 版本按父组展示但不折叠旧版本；所有操作指定 revisionId、busy保护；行内失败含字段/引用/活动原因及diagnosticId；管理与配置保存分开。
- [x] **4. 接通画像/目标表单、store及工作台。** 列表按ID upsert，编辑器有效状态同步；旧配置“新建版本”要求空白新名称；重新选择/恢复后可运行状态一致。版本名称只本地显示，不进入模型 payload。
- [x] **5. GREEN。** 运行步骤 2 加 `tests/integration/ui-profile-validation.test.mjs tests/unit/ui-state.test.mjs tests/integration/ui-shell.test.mjs`；在长列表模拟滚动后通知仍可见且 aria-live 有内容。
- [x] **6. Commit。** `git commit -m "fix: make version management actions consistent and visible"`。

## Task 9：岗位库分类与全版本清理界面

**Files:** Create `public/js/components/duplicate-cleanup.js`；Modify `public/js/pages/jobs.js`、`public/js/components/job-filters.js`、`public/js/components/job-list.js`、`public/js/components/job-detail.js`、`public/js/components/duplicate-compare.js`、`public/js/jobs-data.js`、`public/js/state.js`、`public/js/pages/applications.js`、`src/application/export-service.mjs`、`public/styles/components.css`；Test 新建 `tests/integration/ui-job-cleanup.test.mjs`，修改 `tests/integration/ui-jobs.test.mjs`、`tests/integration/ui-applications.test.mjs`、`tests/integration/job-service.test.mjs`。

**Interfaces:** Consumes preview/apply及版本事实API；Produce `duplicateCleanup(document,{api,onApplied,notify}) -> {node,open,dispose}`。`queryJobs(filters)`明确独立字段 `targetRevisionId:'all'|'unassigned'|ID`、`kind:'job'|'recruitment_notice'|'company_campaign'|'all'`、`recommendation:'high'|'consider'|'low'|'insufficient'|'not_recommended'|'unevaluated'|'all'`、`qualification:'pass'|'unknown'|'fail'|'all'`、`applicationStatus`（沿用 APPLICATION_STATUSES）、`duplicateStatus:'normal'|'possible'|'protected'|'all'`。缺省/all表示该维度不限，旧 filter 参数仅映射兼容。正常UI不把回收站版本加入常规下拉，从回收站入口显式浏览。

- [x] **1. 写失败测试。** 合成跨类别、跨页、未评价和三状态版本；组合过滤计数与服务一致。默认选中版本+job，consider/low/insufficient/unevaluated均可选，notice/campaign独立。断言：
  ```js
  assert.equal(filters.kind, 'job');
  assert.equal(filtered.total, expectedMatchingCanonicalCount);
  assert.equal(previewRequests[0].body.targetRevisionId, undefined);
  assert.deepEqual(defaultSelectedGroups, confirmedUnprotectedGroupIds);
  assert.match(resultNotice.textContent, /重复实体.*版本.*备份/);
  assert.equal(stalePlanShowsRefreshAction, true);
  ```
  预览不受当前分页/版本筛选限制，疑似和人工保护不能默认删除；确认前不apply，忙时一次提交；失败不清空预览/输入。oldID详情返回主ID后替换缓存/选中行，不重复显示。
- [x] **2. RED。** `Invoke-RjrTest tests/integration/ui-job-cleanup.test.mjs tests/integration/ui-jobs.test.mjs tests/integration/ui-applications.test.mjs`。
- [x] **3. 实现独立筛选与详情依据。** 服务匹配 spec §8 全部推荐/资格/投递枚举；详情展示所选版本依据、历史分数与当前事实区别，未验证依据明确提示。导出复用同一查询语义。
- [x] **4. 实现清理预览/确认/结果。** 展示主项/删除项/理由/版本/保护/疑似/清理前备份说明，支持选确定组；apply成功按主ID刷新所有缓存，报告实体数和版本内归并条目数，提供完整备份恢复入口说明。
- [x] **5. GREEN。** 运行步骤 2 加 `tests/integration/job-service.test.mjs tests/integration/job-redirects.test.mjs`；预览/清理/导出/投递操作的可见提示不会被 load()清除。
- [x] **6. Commit。** `git commit -m "feat: organize version job views and global duplicate cleanup"`。

## Task 10：目录集中解析、安全桌面入口与全页操作反馈

**Files:** Create `src/infrastructure/storage/layout.mjs`、`electron/directories.mjs`、`public/js/components/data-locations.js`；Modify `src/config.mjs`、`src/sources/fontmap.mjs`、`src/sources/university.mjs`、`electron/main.mjs`、`electron/preload.cjs`、`public/js/pages/settings.js`、`public/js/components/backup-panel.js`、`public/js/components/job-import.js`、`public/js/pages/applications.js`、`public/js/pages/workbench.js`；Test 新建 `tests/unit/storage-layout.test.mjs`、`tests/unit/desktop-directories.test.mjs`，更新 `tests/unit/fontmap.test.mjs`、`tests/integration/ui-settings.test.mjs`、`tests/integration/form-feedback.test.mjs`。

**Interfaces:**
- Produces `resolveDataLayout(dataDir) -> {root,workspace,previous,config,credentials,lock,runs,legacyRuns,backups,cache,logs}`，runs 指 runs-v2；`ensureDataLayout(layout)`、`migrateKnownCaches(layout,{fsAdapter}) -> results`。只验证导入 font-map.json/university-hosts.json 两项旧缓存，新路径优先，损坏旧文件不替代有效新缓存。
- Produces `registerDirectoryIpc({ipcMain,shell,clipboard,getWindow,getOrigin,layout})`，复用 guardDesktopSender；preload仅 `getDataLocations()`、`openDataLocation(kind)`、`copyDataLocation(kind)`，kind固定 `data,history,backups,cache,logs`。open成功以 shell.openPath返回空错误串为依据。
- Produces `dataLocations(document,{bridge,notify}) -> node`；bridge缺失时显示Web下载说明，不请求私人路径。

- [x] **1. 写失败测试。** override/root一致、当前历史指runs-v2、旧缓存有效迁入/新缓存优先/坏旧缓存保留且不用、不递归未知目录。断言：
  ```js
  assert.equal(layout.runs, path.join(dataDir, 'runs-v2'));
  assert.equal(arbitraryPathRejected, true);
  assert.equal(otherWindowRejected, true);
  assert.equal(otherFrameRejected, true);
  assert.equal(publicWebPathEndpointExists, false);
  assert.match(downloadNotice, /导出已生成，已开始下载/);
  ```
  IPC错误不显示成功，不向日志写绝对路径；Web无bridge可用。成功matrix覆盖导入、评分、投递、备份、恢复、设置、导出、打开/复制目录，读取刷新不消除通知。
- [x] **2. RED。** `Invoke-RjrTest tests/unit/storage-layout.test.mjs tests/unit/desktop-directories.test.mjs tests/unit/fontmap.test.mjs tests/integration/ui-settings.test.mjs tests/integration/form-feedback.test.mjs`。
- [x] **3. 实现目录及缓存接入。** 权威账本/配置/凭据不搬迁；已知缓存验证后原子写新位置，验证成功后才可删除确切旧缓存文件，失败保留旧文件。不把 uploads 显示为简历原件，不生成假导出目录。
- [x] **4. 实现受保护 IPC、菜单与设置卡片。** 主进程固定映射、验证主窗口/主框架/本机应用origin；当前历史菜单修到runs-v2，旧历史明确兼容。每项开/复制后显示对应成功/错误。
- [x] **5. 接通其余写操作通知。** 复用 Task8反馈，不创建第二套通知；业务成功后发通知，重评分报告更新数，备份/恢复可确认本地写入，浏览器下载用限定文案，保留安全diagnosticId。
- [x] **6. GREEN。** 运行步骤 2 加 `tests/unit/desktop-bridge.test.mjs tests/integration/ui-applications.test.mjs tests/integration/ui-settings-validation.test.mjs`；无凭据和路径泄露。
- [x] **7. Commit。** `git commit -m "feat: clarify local data locations and operation feedback"`。

## Task 11：完整回归、桌面实际自检、文档与 PR 更新

**Files:** Modify `electron/main.mjs` 的 selftest、`tools/verify-package.mjs`、`tests/e2e/workspace-flow.test.mjs`、`README.md`、`docs/v2-upgrade-guide.md`；Create `docs/reports/2026-10-08-workspace-version-and-dedup.md`；更新本计划完成状态。

**Interfaces:** Consumes Tasks1–10；selftest继续输出 `<RJR_DATA_DIR>/desktop-self-test.json`；包检查新增本轮新模块存在、敏感运行文件不在包内。

- [x] **1. 写交付回归。** 合成E2E串联两命名版本→未评分入库→停用→回收站/恢复→跨全部版本重复预览→确认清理→oldID投递修改→备份恢复；断言所有引用、计数、事实与通知。桌面selftest补实际表单点击/按钮、版本名称、10元目标保存、目录bridge、清理及成功通知可见检查，不调用真实来源/模型。
- [x] **2. RED。** `Invoke-RjrTest tests/e2e/workspace-flow.test.mjs`，未覆盖流程断言先失败。
- [x] **3. 完成自检/包验证和使用说明。** 写清名称规范、停用/回收站/永久删除区别、全部版本清理、疑似/人工保护、旧ID兼容、预览过期、备份整体恢复、真实存储位置。报告仅合成证据与验证结果。
- [x] **4. 执行全套离线回归。** `& $rjrNode tools/run-all-tests.mjs --skip-network`；预期非产物检查全部通过，network与产物检查明确跳过，既有415项v2基线与新增测试均通过。不能以只跑新增测试代替最终全套；失败先定位原因再扩大验证范围。新包验证在下一步执行，不能让旧ASAR冒充本轮产物。
- [x] **5. 顺序重建 EXE。** 检查本项目程序文件占用，未关闭则说明具体原因；仅已确认路径下运行 `& $rjrNode tools/build-desktop.mjs`。与步骤4串行，避免共用.tmp/dist争用；`& $rjrNode tools/verify-package.mjs` 预期0问题。
- [x] **6. 运行实际 EXE。** 为 `.cache/workspace-management-selftest/data` 设置 RJR_DATA_DIR；使用 `Start-Process -WindowStyle Hidden` 启动 `dist/简历岗位雷达-win32-x64/简历岗位雷达.exe --self-test`。检查该data根下结果failed=0、旧30项和新增检查全通过，验证未使用日常APPDATA。最后恢复原环境变量值。
- [x] **7. 独立整分支审查。** 使用 requesting-code-review，审查数据丢失、名称/nonce并发、操作租约、历史事实/hash、人工保护、所有旧ID入口、IPC权限和实际UI流程；修复有证据的问题，重跑受影响及最终必要检查。
- [ ] **8. Commit / push / PR。** 选择性提交产品/测试/文档，排除.cache、运行数据和私密日志；沿用已有用户授权推送 codex/v2-upgrade，更新既有 PR #1 并确保已附加。等待该提交CI结果，不能沿用旧提交成功状态。报告新EXE绝对路径、验证、备份机制和任何剩余限制。

## 自审结果与执行边界

| 已批准设计章节 | 对应任务 |
| --- | --- |
| §1–3 要求、已复现根因与架构 | Task1–10；沿用单账本 |
| §4 唯一名称、幂等、版本操作和引用保护 | Task1、2、5、8 |
| §5 精确归属、旧回填、事实和评价 | Task4、7、9 |
| §6 身份、冲突、证据、非传递分组 | Task3、6 |
| §7 全范围预览、备份事务、redirect及旧恢复 | Task1、5、6、7、9 |
| §8 独立分类与每次成功反馈 | Task8、9、10 |
| §9 目录/缓存/桌面安全入口 | Task10 |
| §10 隔离迁移、并发、真实点击、EXE与隐私 | Task1、5、11 |

作者已检查：各任务输入/输出名称一致；所有五项 Review Focus 已落到回归；新字段与旧备份完整替换一致；lease释放覆盖最终snapshot；清理hash排除自身lease且仍核验业务revision；没有实际删除日常数据或模型付费步骤。

任务依次执行，每个任务完成有独立测试与提交。生产数据升级在用户启动新版时完成并先备份；全版本清理仍需在软件中预览并确认。本计划已获用户确认，沿用当前会话执行。
