# Job Radar v2 C: Source Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留八类旧渠道，新增至少六个自动采集适配器，建立有证据的高校/企业/公共站点目录。

**Architecture:** 适配器只负责源特有请求与解析；请求、预算、地址校验、缓存和健康信息统一。候选能力通过合成契约及真实有效样本双重验证，覆盖计划按目标和限额选择站点。

**Tech Stack:** Node >=20 ESM、node:http/https/dns、已有 HTML/静态数据解析器、node:test；不增加浏览器抓取服务。

**Spec:** [设计 6.1–6.5](../specs/2026-10-04-job-radar-v2-design.md)；契约见 [主计划](2026-10-05-job-radar-v2.md)。

## Global Constraints

- collect 返回 records/issues/coverage/stats；取消不是可重试错误。
- 来源请求只接受 HTTP(S) 公网目标；每次重定向检查协议、DNS 与实际连接地址。
- 标准覆盖 maxSites=12 / maxRequests=120；广泛覆盖 maxSites=24 / maxRequests=240；两者 maxKeywords=6 / maxPagesPerQuery=2 / maxDetails=20。
- 所有列表、详情、重试与重定向消耗同一来源请求账本；模型预算独立。
- 新增至少 6 个自动采集适配器，覆盖至少 4 类渠道；目录至少 20 所高校（4 种系统）、10 家企业（3 家非互联网行业）、6 个公共/地方/行业公告站点。
- 公告、网申窗口、具体岗位分别保留 kind；社招/实习/校招能力按已验证契约声明。

## Review Focus

1. 公网域名重定向/重绑定到回环、IPv6 或私网：C1 在实际连接前拒绝。
2. 收到 200 的验证码壳、业务 code403/500、正常空列表：C2/C4/C6 分别记录，不能全当成功。
3. 91job 学校代码混用、NCSS 公告被当具体岗位：C4 保存站点作用域与 kind。
4. 相同企业租户 URL、站点宣传新闻、无年份截止日：C5/C6 不制造身份/日期/岗位。
5. 很多站点+关键词耗尽预算或一域失败：C3 保持覆盖多样性并报告截断，C1 不影响其他域。

---

### C1: 共享请求层、取消、地址安全与账本

**Files:** Create src/infrastructure/http/{client,scheduler,budget,public-url,cache}.mjs、tests/unit/http-budget.test.mjs、tests/integration/http-client.test.mjs。

**Interfaces:** Produces createRequestClient({scheduler,budget,transport,dnsLookup,cache,clock}):request（主计划签名）；createScheduler({maxConcurrent=8,maxPerOrigin=2,minIntervalMs=600,clock})；createSourceBudget({maxRequests,maxDetails}):{claimRequest(kind),claimDetail(key),snapshot()}。transport 是可注入的 socket 请求，默认实现将 DNS 校验结果固定给 lookup 并在实际连接核对 remoteAddress。

- [ ] **Step 1 — 测试：**
```js
test('budget includes retries and cancellation stops queued work', async () => {
  const f=await httpFixture({maxRequests:3,responses:[429,503,200]});
  assert.equal((await f.request(PUBLIC_URL,{})).status,200);
  assert.equal(f.budget.snapshot().requests,3);
  await assert.rejects(f.request(PUBLIC_URL,{}),/budget_exhausted/);
  assert.equal(f.transport.calls,3);
  await assert.rejects(requestRedirectingToPrivateAddress(),/private|address/i);
  assert.equal((await cancelQueuedAndRetryFixture()).callsAfterCancel,0);
});
```
- [ ] **Step 2 — 红灯：** 分别运行 `node tools/test-v2.mjs --file tests/unit/http-budget.test.mjs` 与 http-client.test.mjs，预期模块缺失。
- [ ] **Step 3 — 实现：** 每次实际尝试前 claim；最多 2 次重试，仅 429/5xx/瞬时网络错误，Retry-After 与退避可取消；401/403/验证码不重试。默认 timeout 15000ms、响应 4MiB、最多 3 次重定向，重定向也计数。进程共享域名调度，保持旧来源更长 delay 下限；缓存键含来源配置/查询/语言/parserVersion，缓存命中不记出站。检查 IPv4/IPv6/映射地址、凭证 URL、DNS 全部结果，禁止手动 Host 绕过；检查真正连接后才发送敏感内容/读取响应。
- [ ] **Step 4 — 绿灯：** 两套测试退出 0；覆盖同域跨任务间隔、不同域并行、AbortSignal.timeout 与调用方 signal、429 等待、DNS 换址、重定向到 file/localhost、流式大小超限、缓存隔离，全部注入 transport 不访问公网。
- [ ] **Step 5 — 提交：** `git add src/infrastructure/http tests/unit/http-budget.test.mjs tests/integration/http-client.test.mjs`；`git commit -m "feat: coordinate cancellable source requests and budgets"`。

### C2: 注册契约并迁移八类旧来源

**Files:** Create src/sources/registry.mjs、src/sources/adapters/legacy.mjs、src/application/source-service.mjs、tests/unit/source-registry.test.mjs、tests/integration/legacy-sources.test.mjs、tests/fixtures/sources/legacy/*.json；Modify src/sources/{index,common,zhaopin,shixiseng,searchapi,wechat,nowcoder,university,chenyun,jiuyeqiao,fontmap}.mjs。

**Interfaces:** Produces createSourceRegistry(providers):{get(id),list()}；providers 必有 id/name/capabilities/configSchema/collect/fetchDetail/probe。createSourceService({registry,repository,requestFactory,clock}):{listSources(),probe(sourceId,siteId),saveSourceConfig(input),addSite(input)} 均 Promise；无详情能力的 fetchDetail 原样返回记录并说明 unavailable。保留 SOURCES 与 collectJobs 的外部转换入口。

- [ ] **Step 1 — 测试：**
```js
test('legacy sources share contract and preserve partial data', async () => {
  assert.throws(()=>createSourceRegistry([provider,provider]),/duplicate/i);
  const r=await collectLegacyFixture({failingSource:'zhaopin'});
  assert.ok(r.records.length>0);
  assert.ok(r.coverage.some(x=>x.status==='failed'));
  assert.ok(r.issues.some(x=>x.code==='http_forbidden'));
  assert.equal(r.records.find(x=>x.sourceId==='wechat').kind,'recruitment_notice');
});
```
- [ ] **Step 2 — 红灯：** 运行 registry/legacy-sources 两个文件，预期新契约缺失。
- [ ] **Step 3 — 实现：** 所有旧源网络调用注入 request/signal，包括牛客、字体、详情与搜索；移除模块级裸 fetch 路径。保留源特有分页和字体修复，明确 raw/parsed/accepted 统计；200 验证码、业务错误与 empty 分开，complete 只表示计划请求完成。健康信息在来源/站点维度保存，有限退避；探针复用 collect/detail 解析且预算独立最多 6 请求/2 详情。
- [ ] **Step 4 — 绿灯：** 两测试通过；八源各至少一个成功+解析失败夹具，无 Key 搜索为 skipped；字体未知字符保留、冲突不猜测、缓存按站点/parserVersion 隔离；旧来源测试仍通过。
- [ ] **Step 5 — 提交：** `git add src/sources src/application/source-service.mjs tests/unit/source-registry.test.mjs tests/integration/legacy-sources.test.mjs tests/fixtures/sources/legacy`；`git commit -m "refactor: adapt existing sources to shared collection contract"`。

### C3: 已验证站点目录与目标覆盖计划

**Files:** Create src/sources/{catalog,planning}.mjs、src/sources/catalog/{universities,employers,public-notices}.json、tests/unit/source-planning.test.mjs、tools/verify-source-catalog.mjs；Modify config.example.json、src/config.mjs、src/application/source-service.mjs。

**Interfaces:** Produces loadSiteCatalog({customSites=[]}={}):Site[]、buildCollectionPlan({targetSnapshot,profileRevision,catalog,health}):{sites,queries,budgets,skipped}。query 为 {sourceId,siteId,keyword,city,pageLimit}；saveSourceConfig 返回脱敏配置；addSite 必须归属证据和 probe 验证后变 ready，否则保存 candidate。

- [ ] **Step 1 — 测试：**
```js
test('broad planning is bounded and diverse', () => {
  const p=buildCollectionPlan(broadCatalogFixture);
  assert.ok(p.sites.length<=24);
  assert.equal(p.budgets.maxRequests,240);
  assert.ok(new Set(p.sites.map(x=>x.category)).size>=4);
  assert.ok(p.queries.every(q=>q.pageLimit<=2));
  assert.ok(!p.sites.some(x=>x.status==='candidate'));
  assert.ok(p.skipped.some(x=>x.reason==='backoff'));
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/unit/source-planning.test.mjs`，预期 planner 缺失。
- [ ] **Step 3 — 实现：** 本校/专业/城市/显式选择优先，按类别轮转并分配请求，健康仅调整排序/退避，不能抹掉用户选择原因；标准12/120、广泛24/240，关键词最多6、每 query 2页、详情20。每个目录条目有官方归属证据、provider/tenant、能力与验证时间；复核已有高校错误名称/域名，不推测新域名。将 config.sources.searchApi 映射 providerId searchapi，保留旧 key。
- [ ] **Step 4 — 绿灯：** planning 测试通过；校验目录至少20高校/4系统、10企业/3非互联网、6公共站点的实时 gate 放 C6，此任务合成目录测试禁止把 candidate 当 ready。补测只有1站、全失败、无学校、指定站点超过预算、禁用源、同域多租户。
- [ ] **Step 5 — 提交：** `git add src/sources/catalog.mjs src/sources/planning.mjs src/sources/catalog tools/verify-source-catalog.mjs src/application/source-service.mjs src/config.mjs config.example.json tests/unit/source-planning.test.mjs`；`git commit -m "feat: plan diversified coverage from verified source catalog"`。

### C4: NCSS 与 91job 公开结构化渠道

**Files:** Create src/sources/adapters/{ncss,university-91job}.mjs、tests/integration/ncss-91job.test.mjs、tests/fixtures/sources/{ncss,91job}/*.json；Modify src/sources/registry.mjs、src/sources/catalog/universities.json。

**Interfaces:** Produces providers ncss 与 university-91job，遵从主计划 Source 接口；sourceRecordId 用 jobId/zpgwid，identityScope 分别为全国平台/学校代码；公告用自己的公告 ID 与 kind。

- [ ] **Step 1 — 测试：**
```js
test('public platform records preserve kind and school identity', async () => {
  const {ncss,seu,hhu}=await replayPlatformFixtures();
  assert.equal(ncss.records.find(x=>x.sourceRecordId==='notice-1').kind,'recruitment_notice');
  assert.notEqual(seu.records[0].identityScope,hhu.records[0].identityScope);
  assert.equal(seu.records[0].description,'合成的工程岗位要求');
  assert.equal(seu.coverage[0].truncated,true);
  assert.equal((await replayBusinessError403()).issues[0].code,'restricted');
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/ncss-91job.test.mjs`，预期适配器缺失。
- [ ] **Step 3 — 实现：** NCSS 使用 GET /student/jobs/jobslist/ajax/，offset 从1、limit，携带前端列明空字段及 X-Requested-With/Referer，读取 flag/data.list/pagenation；核实详情路径和 recruitType。91job POST JSON;charset=utf-8 /web/wsjysc/lbxq/getZpgwPageList，current/size/xxdm 与前端字段，读 success/code/result.records；getZpggPageList 为公告，GET getZpgwxq?zpgwid=&xxdm= 为详情。zwms JSON 字符串静态解析并文本化；学校代码10286/10294 依据官方子站入口；时间/薪资单位待原字段证据确认，未知保留 null。
- [ ] **Step 4 — 绿灯：** 确定性测试通过；单独 probe 两源各至少一条有效记录和详情，记录 checkedAt。补测正常空页、最后页、不支持筛选、业务500、缺ID、错误学校、列表成功详情失败、学历/年薪单位。未通过 live gate 不标 ready。
- [ ] **Step 5 — 提交：** `git add src/sources/adapters/ncss.mjs src/sources/adapters/university-91job.mjs src/sources/registry.mjs src/sources/catalog/universities.json tests/integration/ncss-91job.test.mjs tests/fixtures/sources/ncss tests/fixtures/sources/91job`；`git commit -m "feat: collect ncss and 91job public recruitment records"`。

### C5: 校招聚合与官方公告

**Files:** Create src/sources/adapters/{yingjiesheng,official-announcements}.mjs、tests/integration/notice-sources.test.mjs、tests/fixtures/sources/notices/*.html；Modify src/sources/registry.mjs、src/sources/catalog/public-notices.json。

**Interfaces:** Produces yingjiesheng、official-announcements providers；官方公告模板配置包含 listUrl/linkRule/titleRule/dateRule/bodyRule/category，不执行配置代码。若海投/国聘另有已验证公开契约，可增加独立 haitou/iguopin 适配器及对应测试，不能把一个模板的多个站点计成多个适配器。

- [ ] **Step 1 — 测试：**
```js
test('notices remain notices with trustworthy dates and links', async () => {
  const r=await replayNoticeFixtures();
  assert.ok(r.records.every(x=>x.kind!=='job'));
  assert.equal(r.records.find(x=>x.sourceRecordId==='window-1').kind,'company_campaign');
  assert.equal(r.records.find(x=>x.sourceRecordId==='missing-year').publishedAt,null);
  assert.ok(!r.records.some(x=>x.title==='平台宣传新闻'));
  assert.ok((await replayWafPage()).issues.some(x=>x.code==='captcha'));
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/notice-sources.test.mjs`，预期 providers 缺失。
- [ ] **Step 3 — 实现：** 应届生 /deadline/ GBK HTML 仅按实际可读范围解析网申窗口/明确截止日期，详情不可读保留线索和截断；取得正文后才满足新增直连验收。官方公告按验证过的学校/国资/地方/行业模板读标题、正文、日期、附件和原投递入口；图片/PDF附件缺文字提示待核实，不编造岗位。依据公开页面字段确认日期年份，不能默认以发现日期替代。
- [ ] **Step 4 — 绿灯：** notice 测试通过，另测跨年日期、相对链接、外站applyUrl、重复公告、非招聘新闻。live probe 至少一份有效列表与正文；超时/业务403/WAF 记录失败，优先寻找同类别可读官方来源满足 C6。
- [ ] **Step 5 — 提交：** `git add src/sources/adapters/yingjiesheng.mjs src/sources/adapters/official-announcements.mjs src/sources/registry.mjs src/sources/catalog/public-notices.json tests/integration/notice-sources.test.mjs tests/fixtures/sources/notices`；`git commit -m "feat: collect campus windows and official recruitment notices"`。

### C6: 企业官网、导入与真实接入门槛

**Files:** Create src/sources/adapters/{tencent,smartrecruiters}.mjs、src/application/import-service.mjs、tools/probe-sources-v2.mjs、tests/integration/employer-sources.test.mjs、tests/integration/source-readiness.test.mjs、tests/fixtures/sources/employers/*.json、docs/reports/2026-10-05-source-readiness.md；Modify src/sources/registry.mjs、src/sources/catalog/employers.json、package.json。

**Interfaces:** Produces tencent/smartrecruiters providers；createImportService({repository,jobService,request,clock}).import({url?,text?,note?}):Promise<{jobIds,issues}>；probe-sources-v2 支持 --source <id>、--site <id>、--report <path>，输出 ready/empty/restricted/unavailable/parse_error。tools/probe-sources-v2.mjs 导出 countReadyProviders(results):number，按 distinct providerId/category 计数，不导入即运行。

- [ ] **Step 1 — 测试：**
```js
test('employer capabilities and readiness counts are evidence based', async () => {
  const r=await replayTencentFixture();
  assert.equal(r.records[0].jobType,'social');
  assert.equal(countReadyProviders(mixedProbeResults),6);
  assert.equal(countReadyProviders(homepageOnlyResults),0);
  assert.equal(countReadyProviders(twoSchoolsOneProvider),1);
  await assert.rejects(importPrivateUrlFixture(),/private|address/i);
  assert.equal((await importTextFixture()).records[0].publishedAt,null);
});
```
- [ ] **Step 2 — 红灯：** 分别运行 employer-sources/source-readiness 两测试，预期适配器与统计模块缺失。
- [ ] **Step 3 — 实现：** 腾讯 GET /tencentcareer/api/post/Query 使用 keyword/pageIndex/pageSize/language，Data.Posts 的 PostId 为强身份，实测接口声明 social；详情需核实公开接口。SmartRecruiters 按官方 Posting API GET /v1/companies/{companyIdentifier}/postings（offset/limit/q/country/region/city），详情跟随已校验 ref；读取 jobAd.sections、active/experienceLevel/applyUrl/releasedDate，岗位类型按实际证据判断。博世 companyIdentifier=BoschGroup 已验证，其他租户须官方归属证明；依照公开API契约，不模拟专用机器人身份。飞书为备用候选，字节405、国聘签名403 不标 ready。导入 URL 使用共享公网请求，文本标 manual；搜索API新增官方站查询预设，但发现线索不计新直连。公开候选不满足验收时增加有真实证据的同类别适配器/模板并补契约，禁止复制解密/签名绕过代码。
- [ ] **Step 4 — 绿灯与接入 gate：** 确定性两测试通过；显式运行 `node tools/probe-sources-v2.mjs --report docs/reports/2026-10-05-source-readiness.md` 和 `node tools/verify-source-catalog.mjs --live`。要求≥6新 provider/≥4类别、每个有稳定标识/标题/URL/正文或结构化要求有效样本；目录≥20高校/4系统、10企业/3非互联网、6公共站点。报告失败、时间、样本数量及预算，不把 empty/主页/搜索/人工导入算通过。未达门槛继续验证替代源；保留未解决差额。
- [ ] **Step 5 — 提交：** `git add src/sources/adapters/tencent.mjs src/sources/adapters/smartrecruiters.mjs src/application/import-service.mjs src/sources/registry.mjs src/sources/catalog/employers.json tools/probe-sources-v2.mjs package.json tests/integration/employer-sources.test.mjs tests/integration/source-readiness.test.mjs tests/fixtures/sources/employers docs/reports/2026-10-05-source-readiness.md`；`git commit -m "feat: add employer sources and verified channel readiness gates"`。新增替代适配器及测试按实际文件显式加入本次提交。
