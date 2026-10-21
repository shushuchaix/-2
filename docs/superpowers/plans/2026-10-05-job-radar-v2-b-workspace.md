# Job Radar v2 B: Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立唯一权威持久化路径，安全迁移 v1 数据并保存长期档案、目标与投递记录。

**Architecture:** 应用服务注入 Repository；事务串行、跨进程锁、原子文件提交。采集事实、版本化评价与人工记录独立，迁移先备份后激活。

**Tech Stack:** Node >=20 ESM、node:fs/promises、node:crypto、node:test；纯 JSON 文件存储。

**Spec:** [设计](../specs/2026-10-04-job-radar-v2-design.md)；共用类型见 [主计划](2026-10-05-job-radar-v2.md)。

## Global Constraints

- schemaVersion=2；workspace.v2.json 为权威状态，runs-v2/<runId>.json 为不可变快照。
- 每次事务重新读取最新文件；进程内串行并取得数据目录级独占写锁。
- 损坏文件和 schema 过新返回明确错误，不能静默替换为空库。
- API Key 不进入业务历史、普通日志或导出；有人工记录的岗位与引用简历不自动删除。
- 迁移以旧人工状态为准，旧评分标记 legacy；重复迁移不复制记录。

## Review Focus

1. CLI 与服务同时写，PID 活着但锁很旧：B1 等待/拒绝，不能按年龄强删。
2. 旧 ID 混合了多个真实岗位：B2 保留冲突与 legacy 人工记录。
3. 同一画像保存两次、目标在检索中被改：B3 版本不可变，旧快照仍可读取。
4. note 缺省与空字符串：B4 前者保持原值，后者清空并追加事件。
5. 快照已写但 workspace 提交失败、备份损坏：B5 记录恢复问题，不丢当前有效库。

---

### B1: 文件事务、锁和错误传播

**Files:** Create src/infrastructure/storage/{repository,lock,atomic}.mjs、tests/integration/repository.test.mjs、tests/helpers/{repository,writer-process}.mjs。

**Interfaces:** Consumes A1 contracts；Produces openWorkspaceRepository({dataDir,clock,fsAdapter}):Promise<Repository>，方法见主计划；withWorkspaceLock(dataDir,fn):Promise<T>；writeAtomicJson(path,value):Promise<void>。tests/helpers/repository.mjs 提供 tempRepository(t):Promise<Repository>，只创建自己可清理的临时目录。

- [ ] **Step 1 — 测试：**
```js
test('two processes preserve writes and report failures', async t => {
  const repo=await tempRepository(t);
  await runTwoWriters(repo.dataDir,['note-a','note-b']);
  assert.deepEqual((await repo.read()).recoveryRecords.map(x=>x.message).sort(),['note-a','note-b']);
  await assert.rejects(withInjectedWriteFailure(repo),/write|persist/i);
  assert.equal((await repo.read()).revision,2);
  await assert.rejects(openCorruptRepository(t),/corrupt|schema/i);
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/repository.test.mjs`，预期 repository 缺失。
- [ ] **Step 3 — 实现：** 事务深拷贝、校验、revision+1 后 flush 唯一临时文件并原子重命名；发布成功后才返回 result。独占锁含 PID 与随机 owner token，仅 owner 释放；PID 不存在才清理，EPERM/无法判断视为活跃。锁超时明确返回 busy；备份最后可用状态。Windows 重命名失败不先删除权威文件。read 返回独立对象。
- [ ] **Step 4 — 绿灯：** 测试退出 0；补测活跃旧锁、owner 不匹配、进程死亡、并发 20 次提交、读对象外部变更、写盘/rename 故障、过新 schema。两个 writer 使用真实子进程和同一隔离目录。
- [ ] **Step 5 — 提交：** `git add src/infrastructure/storage/repository.mjs src/infrastructure/storage/lock.mjs src/infrastructure/storage/atomic.mjs tests/integration/repository.test.mjs tests/helpers/repository.mjs tests/helpers/writer-process.mjs`；`git commit -m "feat: add atomic workspace repository with process locking"`。

### B2: 有备份、幂等的 v1 迁移

**Files:** Create src/infrastructure/storage/migrate-v1.mjs、tests/integration/migration.test.mjs、tests/fixtures/migration/*.json；Modify src/doctor.mjs。

**Interfaces:** Consumes Repository 与 resolveJobIdentity；Produces migrateV1({dataDir,repository,dryRun=false}):Promise<{status,counts,conflicts,skipped,backupPath,manifestPath}>。doctor 增加只读迁移预检，正式迁移只能通过同一函数。

- [ ] **Step 1 — 测试：**
```js
test('migration preserves human data and is idempotent', async t => {
  const {repository,dataDir}=await legacyFixture(t);
  const first=await migrateV1({dataDir,repository});
  const once=await repository.read();
  await migrateV1({dataDir,repository});
  assert.deepEqual(await repository.read(),once);
  assert.equal(once.applications['legacy:old-1'].note,'已投递，等待回复');
  assert.ok(first.backupPath);
  assert.equal(first.conflicts.length,1);
  assert.equal(first.skipped.length,1);
  assert.ok(Object.values(once.evaluations).every(x=>x.status==='legacy'));
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/migration.test.mjs`，预期 migrator 缺失。
- [ ] **Step 3 — 实现：** 只读取 job-index.json 和 runs/*.json；白名单备份并记录 SHA-256，保留首次/最近发现、可读运行和旧状态。aliases 映射 string→string[]；冲突不把人工状态复制到新岗位。坏单文件写摘要，整体一致性失败不激活。用输入哈希+版本 marker 保证幂等，dryRun 无业务写入。
- [ ] **Step 4 — 绿灯：** migration 测试退出 0；另测无 v1 空目录、重复 run、损坏索引、历史文件无索引、备份失败、激活前故障、旧文件未改变、敏感配置未复制。
- [ ] **Step 5 — 提交：** `git add src/infrastructure/storage/migrate-v1.mjs src/doctor.mjs tests/integration/migration.test.mjs tests/fixtures/migration`；`git commit -m "feat: migrate legacy workspace with backups and aliases"`。

### B3: 不可变画像与目标服务

**Files:** Create src/application/workspace-service.mjs、tests/integration/workspace-service.test.mjs；Modify src/config.mjs。

**Interfaces:** Produces createWorkspaceService({repository,clock}):{saveProfile(input),saveTarget(input),getProfileRevision(revisionId),getTargetRevision(revisionId),listProfiles(),listTargets(),deleteProfileRevision(revisionId)}，方法均 Promise。saveProfile 返回 ProfileRevision；saveTarget 返回 SearchTarget。城市模式为 any/from_profile/selected；degreePolicy 为 eligibility/minimum_requirement。

- [ ] **Step 1 — 测试：**
```js
test('profile and target revisions remain immutable', async t => {
  const service=createWorkspaceService({repository:await tempRepository(t)});
  const p1=await service.saveProfile(confirmedProfile);
  const p2=await service.saveProfile({...confirmedProfile,profileId:p1.profileId,text:'更新后的简历'});
  const tg=await service.saveTarget({...targetInput,profileRevisionId:p1.revisionId,cityMode:'any',cities:[]});
  assert.notEqual(p1.revisionId,p2.revisionId);
  assert.equal((await service.getProfileRevision(p1.revisionId)).text,confirmedProfile.text);
  assert.equal(tg.profileRevisionId,p1.revisionId);
  await assert.rejects(service.deleteProfileRevision(p1.revisionId),/referenced/i);
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/workspace-service.test.mjs`，预期 service 缺失。
- [ ] **Step 3 — 实现：** 保存确认文本、结构化画像与 overrides；生成稳定 ID、revisionId/hash，目标引用实际存在的 revision。校验城市模式、来源/预算、启停；删除只允许无引用 revision。v1 cities null/[]/数组精确转换三种模式，既有 minDegree 保留含义。config load 每次深复制默认值，数据目录配置路径在读取时解析，环境覆盖不能污染下一次读取。
- [ ] **Step 4 — 绿灯：** 测试退出 0；追加旧城市语义、手改优先、停用目标、无效引用、同进程两次 loadConfig、首次 seed 后配置立即可读。
- [ ] **Step 5 — 提交：** `git add src/application/workspace-service.mjs src/config.mjs tests/integration/workspace-service.test.mjs`；`git commit -m "feat: persist immutable profiles and search targets"`。

### B4: 事实、评价与人工投递独立保存

**Files:** Create src/application/job-service.mjs、tests/integration/job-service.test.mjs；Modify src/store.mjs、src/server.mjs、src/pipeline.mjs、tools/test-store.mjs。

**Interfaces:** Consumes A2 identity/lifecycle 与 Repository；Produces createJobService({repository,clock}):{ingestRecords({runId,records,observedAt}),finalizeCoverage({runId,coverage,detailEvidence}),saveEvaluations(evaluations),queryJobs(filters),getJob(jobId),updateApplication(jobId,patch),linkJobs(a,b),unlinkJobs(a,b)}；均 Promise。ingestRecords 返回 {jobIds,observationIds,newForTarget}；queryJobs 返回 {items,total,page,pageSize}；getJob 返回 {job,observations,evaluations,application,relatedJobs}。Job 增加 targetFirstSeen:Record<targetId,ISODate>；patch 只更新出现的字段，返回实际持久化 Application。

- [ ] **Step 1 — 测试：**
```js
test('recollection preserves status and explicit empty note clears', async t => {
  const {service,runId}=await jobServiceFixture(t);
  const {jobIds}=await service.ingestRecords({runId,records:[job()],observedAt:AT});
  const id=jobIds[0];
  await service.updateApplication(id,{status:'applied',note:'已投递'});
  await service.ingestRecords({runId,records:[job()],observedAt:AT});
  assert.equal((await service.getJob(id)).application.status,'applied');
  await service.updateApplication(id,{note:''});
  assert.equal((await service.getJob(id)).application.note,'');
  assert.equal((await service.getJob(id)).observations.length,1);
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/job-service.test.mjs`，预期 service 缺失。
- [ ] **Step 3 — 实现：** 按强身份 upsert、按 run/source/site/record/contentHash 幂等 observation；冲突证据与 possible 组保留，首次发现按全局/目标分别记录。所有记录先保存，无评分阈值截断；finalizeCoverage 用 A2 deriveLifecycle 更新同范围有效性。投递枚举保留 new/seen/interested/applied/interviewing/offer/rejected/ignored，追加状态/备注事件，引用简历版本。查询按目标版本查 Evaluation，支持分页/搜索/kind/资格/状态/来源/日期/城市。store 改为 await 的兼容包装，同步调整 server/pipeline 与 test-store；旧测试中“损坏自动空库/空结果消失”改为新正确语义的断言，保存失败抛错。
- [ ] **Step 4 — 绿灯：** 测试退出 0；补测 note 缺省、别的目标首次发现、重评分不改状态、存储失败、非法日期/状态、关联后两记录仍可读/取消关联、同一 identity 不同 observation。
- [ ] **Step 5 — 提交：** `git add src/application/job-service.mjs src/store.mjs src/server.mjs src/pipeline.mjs tools/test-store.mjs tests/integration/job-service.test.mjs`；`git commit -m "feat: retain observations and independent application history"`。

### B5: 检查点、备份和启动恢复

**Files:** Create src/infrastructure/storage/{backup,recovery}.mjs、src/application/export-service.mjs、tests/integration/recovery.test.mjs；Modify src/export.mjs、src/doctor.mjs。

**Interfaces:** Produces createBackup({repository,clock}):Promise<{path,manifest}>、restoreBackup({repository,archivePath}):Promise<{revision,recovered}>、recoverWorkspace(repository):Promise<{interruptedRunIds,orphanSnapshots,issues}>；createExportService({repository}).export({format,filters}):Promise<{filename,contentType,body}>。backup 归档为含 manifest/workspace/runSnapshots 的 JSON，哈希逐项校验。

- [ ] **Step 1 — 测试：**
```js
test('restart marks unfinished runs and rejects damaged backups', async t => {
  const repo=await seededRunningRepository(t);
  const recovered=await recoverWorkspace(repo);
  assert.equal((await repo.read()).runs.r1.status,'interrupted');
  assert.deepEqual(recovered.interruptedRunIds,['r1']);
  const backup=await createBackup({repository:repo});
  assert.equal(JSON.stringify(backup.manifest).includes('apiKey'),false);
  await corruptBackup(backup.path);
  await assert.rejects(restoreBackup({repository:repo,archivePath:backup.path}),/hash/i);
  assert.equal((await repo.read()).runs.r1.status,'interrupted');
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/recovery.test.mjs`，预期 recovery/backup 缺失。
- [ ] **Step 3 — 实现：** 快照写成功才在 workspace 引用其路径/hash；启动把 queued/running 变 interrupted，发现孤立快照/缺失引用并记录可见问题。备份白名单只含业务实体和运行快照，默认排除 config、Key、uploads/cache；恢复先完整校验后用事务激活并备份当前状态。导出 JSON/CSV/Markdown，CSV 中公式前缀转义，保留薪资原单位；清缓存不删除人工记录及引用画像。
- [ ] **Step 4 — 绿灯：** recovery 测试退出 0；补测快照成功但 workspace 失败、丢失快照、有效恢复、未来 schema 拒绝、路径越界、导出无 Key、CSV 公式与中文长字段。
- [ ] **Step 5 — 提交：** `git add src/infrastructure/storage/backup.mjs src/infrastructure/storage/recovery.mjs src/application/export-service.mjs src/export.mjs src/doctor.mjs tests/integration/recovery.test.mjs`；`git commit -m "feat: recover workspace runs and validate business backups"`。
