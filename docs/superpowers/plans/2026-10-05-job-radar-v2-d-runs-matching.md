# Job Radar v2 D: Runs and Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可取消、可恢复的持久检索任务，输出资格、匹配度和完整度，并让三种入口消费同一服务。

**Architecture:** 应用服务冻结画像/目标 revision，先保存采集事实，再补详情和评分。规则评价、模型建议、用量账本及缓存版本分开管理；HTTP 只转换输入与事件。

**Tech Stack:** Node >=20 ESM、node:test、现有 DeepSeek/OpenAI 兼容客户端、NDJSON。

**Spec:** [设计 7–9](../specs/2026-10-04-job-radar-v2-design.md)；类型与上游接口见 [主计划](2026-10-05-job-radar-v2.md) 和 B/C 计划。

## Global Constraints

- 资格为 pass/fail/unknown；“优先”属于加分项，缺失信息为 unknown。
- 模型不能用高分消除确定的硬性不符合；评分不表示录用概率。
- 默认最多 20 次模型 HTTP 请求（含重试与格式修复），每请求最多 4000 输出 tokens。
- 缓存绑定 JD hash、画像/目标 revision、promptVersion、ruleVersion、模型端点/名/参数，Key 不进入缓存。
- queued → running → completed/partial/failed/cancelled/interrupted；断开浏览器不取消任务。
- 所有规范化采集记录在评分截断前保存；每任务固定 targetSnapshot。

## Review Focus

1. 学历够但岗位接受较低学历、“优先证书”或未写证书：D1 正确区分 pass/bonus/unknown。
2. AI 缺少/重复/未知 jobId、编造证据：D2 只回退无效项并保护有效项。
3. 换画像/目标/提示词、并行任务：D2/D5 缓存和用量绝不串用。
4. 空结果、源失败、取消或低分：D3 不删除事实、不重置人工记录。
5. afterSeq 太旧、断线、进程重启：D4 发快照或 interrupted，不产生假进度。

---

### D1: 证据资格、规则评分与可重放基线

**Files:** Create src/domain/{qualification,ranking}.mjs、src/domain/ranking-config.json、tests/unit/qualification.test.mjs、tests/unit/ranking.test.mjs、evals/{dataset,metrics}.mjs、evals/fixtures/*.json、tools/eval-matching.mjs；Modify src/match/{requirements,score}.mjs。

**Interfaces:** Produces evaluateQualification(record,profile,target):{status,checks}，profile 为 ConfirmedProfile，check 含 type/status/requirement/evidence/reason；evaluateRules(record,profile,target,{ruleVersion}={}):EvaluationDraft；computeRankingMetrics(labels,ranked):{precisionAt10,ndcgAt10,qualificationConfusion,incompleteHighRecommendationRate}。EvaluationDraft 为 Evaluation 除 ID/createdAt/版本关联字段；本任务提供 captureLegacyBaseline(dataset,{ref='3547885'}={}):Report（工具内，从该提交临时导出原始 src 后执行其纯 preScore，不能使用已被 A6 修改的兼容模块当 v1）。

- [ ] **Step 1 — 测试：**
```js
test('eligibility preserves unknown and preferred conditions', () => {
  assert.equal(evaluateQualification(bachelorOrBelowJob,bachelorProfile,target()).status,'pass');
  assert.equal(evaluateQualification(requiredCertificateJob,unspecifiedCertificateProfile,target()).status,'unknown');
  assert.equal(evaluateQualification(requiredCertificateJob,explicitlyNoCertificateProfile,target()).status,'fail');
  assert.notEqual(evaluateQualification(preferredCertificateJob,explicitlyNoCertificateProfile,target()).status,'fail');
  assert.equal(evaluateRules(missingJdJob,profile(),target()).recommendation,'insufficient');
});
```
- [ ] **Step 2 — 红灯：** qualification/ranking 两个测试运行失败，预期新规则缺失；从固定提交3547885导出的纯规则执行并保存 v1 合成基线，独立临时目录且网络guard有效。
- [ ] **Step 3 — 实现：** 资格涵盖届别、学历、岗位类型、明确经验下限、必须证书，按原文证据区分必须/优先。评分复用 A6 技能/专业族，分项和权重显式版本化，默认从 v1 基线提取再按标注对比调整；完整度独立，JD 不足不生成确定高推荐。初始3画像×至少10 JD 标记 synthetic，含理由/来源/标签创建方式；不得把模型标签当人工真值。
- [ ] **Step 4 — 绿灯：** 两测试通过；`node tools/eval-matching.mjs --mode rules --compare-legacy --out evals/reports/rules-v2.json` 输出样本数≥30、四项指标、版本与局限。补测毕业年范围、无经验、消防/网络安全、信息不足、硬门槛不被总分消除；旧录制模型输出不用于证明新提示词效果。
- [ ] **Step 5 — 提交：** `git add src/domain/qualification.mjs src/domain/ranking.mjs src/domain/ranking-config.json src/match/requirements.mjs src/match/score.mjs tests/unit/qualification.test.mjs tests/unit/ranking.test.mjs evals tools/eval-matching.mjs`；`git commit -m "feat: evaluate eligibility and explainable ranking with baseline"`。

### D2: 每轮模型账本、校验与版本缓存

**Files:** Create src/llm/{budget,validation,prompts}.mjs、src/application/evaluation-service.mjs、tests/integration/evaluation.test.mjs、tests/fixtures/llm/*.json；Modify src/llm/deepseek.mjs、src/resume/profile.mjs、tools/eval-matching.mjs。

**Interfaces:** Produces createModelBudget({maxRequests=20,maxOutputTokens=4000}):{claimRequest(),snapshot()}；createEvaluationService({repository,cache,modelFactory,clock}).evaluate({jobIds,profileRevisionId,targetRevisionId,mode,signal,runId,modelClient}):Promise<{evaluations,usage,issues}>；validateModelResults(raw,{records}):{valid,invalidIds,missingIds,issues}；evaluationCacheKey({jdHash,profileRevisionId,targetRevisionId,promptVersion,ruleVersion,modelFingerprint}):string。DeepSeek(cfg,{signal,budget,transport}={}) 保留原 chat/json 方法，新选项传递 signal/maxTokens。

- [ ] **Step 1 — 测试：**
```js
test('every model attempt consumes budget and missing ids alone fall back', async () => {
  const r=await evaluateMixedModelFixture({maxRequests:3});
  assert.equal(r.usage.requests,3);
  assert.equal(r.evaluations.find(x=>x.jobId==='j-valid').status,'ai');
  assert.equal(r.evaluations.find(x=>x.jobId==='j-missing').status,'rule_fallback');
  assert.equal(r.evaluations.find(x=>x.jobId==='j-hard-fail').qualification.status,'fail');
  assert.notEqual(evaluationCacheKey(keyV1),evaluationCacheKey({...keyV1,profileRevisionId:'p1@2'}));
  assert.equal((await cancelModelBackoffFixture()).requestsAfterCancel,0);
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/evaluation.test.mjs`，预期评价服务/账本缺失。
- [ ] **Step 3 — 实现：** 每次任务 modelFactory 新客户端；HTTP 成功/失败/JSON不支持降级/格式修复都先 claim，单次输出≤4000，预算可降低不可无声突破。结构校验 jobId唯一已知、0–100分、字段类型、引文来自输入；无效/缺项仅回退对应项。硬规则 fail 保持，AI 建议附证据；评分缓存仅保存脱敏评价、所有关键版本有效才命中。实时 eval 显式 --mode live，更新 model/prompt fixture版本。
- [ ] **Step 4 — 绿灯：** evaluation 测试通过；补测第20次成功/第21次禁止、无Key正常规则模式、用户请求AI但失败degraded、双任务用量隔离、所有缓存字段变更、无效输出不覆盖既有评价、并发争用预算、AbortError不重试。
- [ ] **Step 5 — 提交：** `git add src/llm src/application/evaluation-service.mjs src/resume/profile.mjs tests/integration/evaluation.test.mjs tests/fixtures/llm tools/eval-matching.mjs`；`git commit -m "feat: bound model usage and version evaluation caches"`。

### D3: 持久任务编排与完整漏斗

**Files:** Create src/application/run-service.mjs、tests/integration/run-service.test.mjs、tests/helpers/fake-sources.mjs；Modify src/pipeline.mjs、src/match/{article,enrich}.mjs。

**Interfaces:** Produces createRunService({repository,workspaceService,jobService,evaluationService,registry,requestFactory,modelFactory,eventHub,runGate,clock}):{startRun({targetRevisionId,mode,credentials}),getRun(runId),listRuns(filters),cancelRun(runId),waitForRun(runId)}，全部 Promise；startRun 返回 {runId,status}，credentials 仅内存；waitForRun 返回 RunSnapshot（{run,profileRevision,jobs,evaluations,events}）。旧 runPipeline 经 D6 转换调用此服务。

- [ ] **Step 1 — 测试：**
```js
test('partial and cancelled runs retain all facts and human state', async t => {
  const f=await runFixture(t,{oneSourceFails:true,lowScoreRecord:true});
  const {runId}=await f.service.startRun({targetRevisionId:f.target.revisionId,mode:'rules'});
  const result=await f.service.waitForRun(runId);
  assert.equal(result.run.status,'partial');
  assert.equal((await f.repository.read()).jobs['low-score'].jobId,'low-score');
  assert.equal((await f.repository.read()).applications['previous-job'].status,'applied');
  assert.equal(result.run.targetSnapshot.revisionId,f.target.revisionId);
  assert.equal(result.run.counts.normalized,2);
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/run-service.test.mjs`，预期 run service 缺失。
- [ ] **Step 3 — 实现：** 取得 quota permit→冻结目标/画像→计划→采集批次检查点→公告抽取→身份→详情→资格/规则/AI→finalizeCoverage→快照与完成。所有规范事实先 ingest，再排候选；onBatch/final 汇总按 observation 幂等，详情新观察也保存。统计 raw/normalized/notices/expanded/deduplicated/eligible/shortlisted/aiSuccess/fallback/newForTarget，语义明确；partial/failed按是否有有效事实判断。finally 释放 permit；取消跨排队/来源/详情/模型传 signal，已完成事实/评价与 cancelled 快照保留。
- [ ] **Step 4 — 绿灯：** run-service 测试通过；补测正常空结果 completed、全部失败 failed、预算截断 partial、规则模式 completed、AI回退degraded、用户改目标中途不影响快照、取消排队与运行、onBatch重复不双计数、引用快照失败恢复。
- [ ] **Step 5 — 提交：** `git add src/application/run-service.mjs src/pipeline.mjs src/match/article.mjs src/match/enrich.mjs tests/integration/run-service.test.mjs tests/helpers/fake-sources.mjs`；`git commit -m "feat: persist cancellable runs and truthful collection counts"`。

### D4: 事件序号与断线重连

**Files:** Create src/application/run-events.mjs、src/server/event-stream.mjs、tests/integration/run-events.test.mjs。

**Interfaces:** Produces createRunEventHub({repository,clock,maxBuffered=200}):{publish(runId,type,payload),subscribe(runId,{afterSeq,onEvent,signal}),getSnapshot(runId)}；publish 返回 Promise<RunEvent>；subscribe 返回 Promise<unsubscribe function>；writeRunEventStream({req,res,runId,afterSeq,eventHub}):Promise<void>。

- [ ] **Step 1 — 测试：**
```js
test('old cursor receives snapshot and disconnect does not cancel', async () => {
  const f=await eventFixture({maxBuffered:2});
  await f.publishThreeEvents();
  const seen=await f.collectEvents({afterSeq:0});
  assert.equal(seen[0].type,'snapshot');
  assert.ok(seen.every((e,i)=>i===0||e.seq>seen[i-1].seq));
  await f.disconnectClient();
  assert.notEqual((await f.getRun()).status,'cancelled');
  assert.equal((await f.restart()).status,'interrupted');
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/run-events.test.mjs`，预期事件服务缺失。
- [ ] **Step 3 — 实现：** RunEvent 标准信封，阶段/批次事件 seq 单调且检查点保存；内存上限200，旧cursor先发服务端快照再后续事件。snapshot.seq 为其状态覆盖到的序号，不重放重复项；NDJSON处理分片、背压、心跳和断开订阅，关闭连接不触发 run.cancel。恢复后用 B5 interrupted 状态显示可重新检索，不自动继续过期凭证任务。
- [ ] **Step 4 — 绿灯：** event 测试通过；补测恰好边界 afterSeq、未来seq拒绝、中文跨字节分片、慢客户端背压、多个订阅者、重复取消、进程恢复不重用旧seq。
- [ ] **Step 5 — 提交：** `git add src/application/run-events.mjs src/server/event-stream.mjs tests/integration/run-events.test.mjs`；`git commit -m "feat: resume run event streams from persisted snapshots"`。

### D5: 无需重采的重新评分

**Files:** Create tests/integration/rescore.test.mjs；Modify src/application/{evaluation-service,job-service}.mjs。

**Interfaces:** Consumes evaluationService.evaluate 和 jobService.queryJobs/saveEvaluations；Produces rescore({jobIds,profileRevisionId,targetRevisionId,mode,signal}):Promise<{evaluations,usage,issues}>，作为 evaluationService 方法，不调用 registry/requestFactory。

- [ ] **Step 1 — 测试：**
```js
test('rescore changes revision without recollecting or resetting applications', async t => {
  const f=await rescoreFixture(t);
  await f.service.rescore({jobIds:['j1'],profileRevisionId:'p1@2',targetRevisionId:'t1@2',mode:'rules'});
  assert.equal(f.sourceCalls,0);
  const w=await f.repository.read();
  assert.ok(Object.values(w.evaluations).some(x=>x.profileRevisionId==='p1@1'));
  assert.ok(Object.values(w.evaluations).some(x=>x.profileRevisionId==='p1@2'));
  assert.equal(w.applications.j1.status,'applied');
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/rescore.test.mjs`，预期 rescore 缺失。
- [ ] **Step 3 — 实现：** 读取现有规范事实/最新可信 JD，绑定实际存在 revision，新评价追加保存不覆盖旧版本；资料不足记录状态，Key/模型预算与 D2 相同。批量受限并可取消，跨版本比较返回两个版本标签。
- [ ] **Step 4 — 绿灯：** rescore 测试通过；补测无岗位/无revision、规则模式0模型、取消保留已完成项、相同版本缓存复用、来源不访问。
- [ ] **Step 5 — 提交：** `git add src/application/evaluation-service.mjs src/application/job-service.mjs tests/integration/rescore.test.mjs`；`git commit -m "feat: rescore saved jobs across profile revisions"`。

### D6: v2 API、v1 转换与安全输入

**Files:** Create src/server/{routes-v2,routes-v1,validation}.mjs、src/application/context.mjs、src/version.mjs、tests/integration/api-v2.test.mjs、tests/integration/api-v1-compat.test.mjs；Modify src/server.mjs、src/pipeline.mjs、src/store.mjs、src/limits.mjs、src/auth.mjs。

**Interfaces:** Produces createApplicationContext({cfg,dataDir,dependencies}):Promise<Context>（汇集 B/C/D 服务）；handleV2Request(req,res,context):Promise<boolean>、handleV1Request(req,res,context):Promise<boolean>；createLegacyRunInput({resumeText,options,cfg,llm}):Promise<{targetRevisionId,mode,credentials}>。createServer(cfg) 保留返回 server/llm/gate/authRequired/exposure；startServer() 保留 server/cfg/ctx。version 从 package.json 读取单一来源。

- [ ] **Step 1 — 测试：**
```js
test('v2 saves real data and v1 keeps response and event shapes', async t => {
  const f=await apiFixture(t);
  const created=await f.post('/api/v2/runs',{targetRevisionId:'t1@1',mode:'rules'});
  assert.ok(created.runId);
  assert.equal((await f.post('/api/analyze',legacyInput)).events.at(-1).type,'done');
  assert.ok((await f.get('/api/runs')).runs);
  assert.equal((await f.post('/api/tracking/jobs/j1',{status:'applied',note:''})).job.note,'');
  assert.equal((await f.get('/api/health')).version,f.packageVersion);
  assert.equal((await f.postForbiddenOrigin()).status,403);
});
```
- [ ] **Step 2 — 红灯：** api-v2/api-v1-compat 两文件预期新routes/context缺失。
- [ ] **Step 3 — 实现：** 实现设计第8节全部接口，profile preview→确认保存、目标、异步runs/events/cancel、分页jobs/详情/评价、application、sources/probe/settings、imports/links、exports/backup。v1 /upload/analyze/runs/:id/delete/export/tracking/session/login/logout 请求响应和 ping/queued/saved/quota/error/done 事件转换；删除历史运行使其不再被v1查询，但仍被观察/人工记录引用的内部运行以deletedAt归档保留，不能破坏引用。runPipeline/listRuns/loadRun/saveRun 为同一服务包装，消除重复写。保留鉴权、origin、RunGate和请求体40MiB/简历20MiB/分析文本30–60000限制；legacy画像标推断待校正。临时 userApiKey 只入内存凭证，不入context序列化、事件、快照/错误。异步初始化 context 由请求等待 ready，启动恢复只一次；包/health/about共用version。
- [ ] **Step 4 — 绿灯：** 两套测试通过；覆盖非法分页/日期/ID、未认证/错误origin、write失败HTTP非2xx、路径穿越、导出/备份无Key、v1状态aliases冲突、公开health脱敏、API事件断开仍运行、首次迁移不同时启动两次。
- [ ] **Step 5 — 提交：** `git add src/server src/application/context.mjs src/version.mjs src/server.mjs src/pipeline.mjs src/store.mjs src/limits.mjs src/auth.mjs tests/integration/api-v2.test.mjs tests/integration/api-v1-compat.test.mjs`；`git commit -m "feat: expose workspace api and legacy compatibility routes"`。
