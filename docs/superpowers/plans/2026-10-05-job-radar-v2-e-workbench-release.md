# Job Radar v2 E: Workbench and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付五页个人求职工作台，并验证 Web、Electron、CLI 和旧数据升级的完整使用流程。

**Architecture:** 原生模块页面共用 API/state/router 与小型组件；所有业务写入经 D6 API，浏览器只管理查看状态与临时凭证。保留桌面安全边界和可写数据目录，发布以完整流程验证结束。

**Tech Stack:** 原生 ES modules/CSS、Node >=20、Electron、Node 测试；DOM 测试使用固定版本 linkedom（仅开发依赖），真实浏览器检查布局。

**Spec:** [设计 3、8、9](../specs/2026-10-04-job-radar-v2-design.md)；接口见 [主计划](2026-10-05-job-radar-v2.md) 及 D6。

## Global Constraints

- 五页：工作台、岗位库、投递进度、简历与目标、数据源与设置。
- 桌面优先，小屏单列；列表、弹层、菜单支持键盘和明确焦点。
- API Key 不进入历史结果、普通日志、导出或浏览器持久化存储；临时 Key 仅当前页面内存。
- 分数不称录用概率；首次发现与发布日期分别显示；岗位、公告、公司窗口分别展示。
- start/desktop/CLI 入口和旧参数保留；Node >=20、原生 ES modules 与 CSS。
- Electron 保持 sandbox/contextIsolation、nodeIntegration=false；发布数据目录可写且不在 ASAR 内。

## Review Focus

1. 中文长标题/长JD/极窄屏/空数据：E3/E7 信息可读、焦点可见、无横向溢出。
2. 断线后重复事件、切换目标、迟到查询响应：E1/E4 不双计新增、不展示旧目标结果。
3. 点击保存失败、清空备注、无简历目标：E2/E4 如实提示，失败不显示已保存。
4. 临时 Key、外链与恶意 JD HTML：E3/E5 不执行内容、不留凭证、只打开HTTP(S)。
5. 新资源漏包、首次桌面配置、公开启动器不监听：E6/E7 实际验证交付产物及入口。

---

### E1: 应用外壳、路由、API 与状态

**Files:** Create public/js/{main,api,state,router}.js、public/js/components/{shell,feedback}.js、public/styles/{tokens,layout,components}.css、tests/unit/ui-state.test.mjs、tests/integration/ui-shell.test.mjs、tests/helpers/dom.mjs；Modify public/index.html、public/app.js、public/style.css、package.json、package-lock.json、.github/workflows/ci.yml。

**Interfaces:** Produces createApiClient({fetchImpl,onAuthRequired}):{request(path,options),streamRun(runId,{afterSeq,onEvent,signal})}；createStore(initial):{getState,dispatch,subscribe}；createRouter({window,onRoute}):{start,navigate,stop}；mountShell({root,store,router,api}):{destroy}；createTestDocument(html):Document。hash routes 为 /workbench、/jobs、/applications、/profiles、/settings。

- [ ] **Step 1 — 测试：**
```js
test('ui ignores repeated events and stale target responses', () => {
  const s=createStore(initialUiState);
  s.dispatch(runEventAction(seq1)); s.dispatch(runEventAction(seq1));
  assert.equal(s.getState().run.lastSeq,1);
  s.dispatch(selectTarget('t2')); s.dispatch(jobsResponse('t1',oldItems));
  assert.equal(s.getState().selectedTargetId,'t2');
  assert.deepEqual(s.getState().jobs.items,[]);
  assert.equal(parseChunkedNdjson(chineseSplitChunks)[0].payload.title,'安全工程师');
});
```
- [ ] **Step 2 — 红灯：** ui-state/ui-shell 两文件运行，预期新模块缺失。
- [ ] **Step 3 — 实现：** 浅色工作台、深蓝主色、文字+颜色状态，五个导航与共享反馈；拆分 app.js，入口只加载 /js/main.js。API 同源 cookie、JSON错误、NDJSON UTF-8 分片/重连及去重；401跳登录，查询响应有target/request版本。状态只管理展示/运行快照，不长期存业务或Key。执行时核对 linkedom 官方兼容版本并锁定 devDependency；CI npm ci --ignore-scripts 安装测试依赖，不下载Electron运行时。
- [ ] **Step 4 — 绿灯：** 两测试通过；五路由恢复、空状态、401、分片/解析错、重复seq/快照、query取消均覆盖；静态检查无内联脚本/样式、外部模块 MIME 正确。
- [ ] **Step 5 — 提交：** `git add public/js public/styles public/index.html public/app.js public/style.css tests/unit/ui-state.test.mjs tests/integration/ui-shell.test.mjs tests/helpers/dom.mjs package.json package-lock.json .github/workflows/ci.yml`；`git commit -m "feat: establish modular job workspace shell"`。

### E2: 简历预览、确认画像与目标管理

**Files:** Create public/js/pages/profiles.js、public/js/components/{profile-form,target-form}.js、tests/integration/ui-profiles.test.mjs。

**Interfaces:** Produces mountProfilesPage({root,api,store}):{destroy}；profile-form 发 confirmedProfile 输入，target-form 发 B3 SearchTarget 输入；使用 /api/v2/profiles/import-preview、profiles/revisions、targets。

- [ ] **Step 1 — 测试：**
```js
test('preview is editable and target city modes are explicit', async () => {
  const f=await profileUiFixture();
  await f.uploadSyntheticDocx();
  assert.equal(f.saveProfileCalls,0);
  assert.ok(f.warningText.includes('提取'));
  await f.editAndConfirm('已校正文本');
  assert.equal(f.lastSavedProfile.text,'已校正文本');
  await f.saveTarget({cityMode:'any'});
  assert.deepEqual(f.lastSavedTarget.cities,[]);
  assert.equal(f.lastSavedTarget.degreePolicy,'eligibility');
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/ui-profiles.test.mjs`，预期页面缺失。
- [ ] **Step 3 — 实现：** 导入预览和警告→用户校正→保存revision；画像显示手改字段、技能熟练度/证书/教育/届别/项目。目标保存方向/城市模式/岗位类型/来源/预算/引用revision，明确“不限/从画像取值/指定城市”和学历资格/最低要求语义。修改画像后提供保存岗位重新评分入口；版本引用与删除阻止原因可读。
- [ ] **Step 4 — 绿灯：** ui-profiles 通过；补测无文本PDF、上传错误/20MB、保存失败不显示成功、手改字段、旧revision可读、未选profile不能建目标、停用目标仍保留历史。
- [ ] **Step 5 — 提交：** `git add public/js/pages/profiles.js public/js/components/profile-form.js public/js/components/target-form.js tests/integration/ui-profiles.test.mjs`；`git commit -m "feat: manage confirmed resume profiles and search targets"`。

### E3: 岗位库、证据详情、关联与导入

**Files:** Create public/js/pages/jobs.js、public/js/components/{job-list,job-detail,job-filters,job-import,duplicate-compare}.js、public/js/format.js、tests/integration/ui-jobs.test.mjs。

**Interfaces:** Produces mountJobsPage({root,api,store}):{destroy}；formatSalary(salary):string、safeExternalUrl(value):string|null；job list 消费 queryJobs 的 items/total/page/pageSize，detail 消费 Job/observations/evaluations/application。

- [ ] **Step 1 — 测试：**
```js
test('job evidence and unsafe content render accurately', async () => {
  const f=await jobsUiFixture({title:'<img src=x onerror=alert(1)>'});
  assert.equal(f.root.querySelectorAll('img').length,0);
  assert.ok(f.root.textContent.includes('待核实'));
  assert.equal(formatSalary({min:200,max:300,unit:'day',currency:'CNY'}),'200–300 元/日');
  assert.equal(safeExternalUrl('javascript:alert(1)'),null);
  await f.openNotice(); assert.ok(f.root.textContent.includes('招聘公告'));
  await f.unlinkDuplicate(); assert.equal(f.visibleJobCount,2);
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/ui-jobs.test.mjs`，预期组件缺失。
- [ ] **Step 3 — 实现：** 推荐/待核实/公告视图，目标/城市/来源/资格/状态/日期筛选与搜索分页。详情展示JD、来源/首次发现/发布时间、投递链接、资格片段、评分分项/差距/完整度及版本；不同薪资单位分别显示。untrusted内容textContent；疑似重复并排关联/取消，无销毁融合。URL/JD导入调用 /imports，失败可见；排除岗位可通过筛选找回。
- [ ] **Step 4 — 绿灯：** ui-jobs 通过；补测资料不足/无来源日期/冲突证据/不同目标评价、filter分页、长JD、详情Esc关闭后焦点返回、链接HTTP(S)；真实宽窄屏检查留E7。
- [ ] **Step 5 — 提交：** `git add public/js/pages/jobs.js public/js/components/job-list.js public/js/components/job-detail.js public/js/components/job-filters.js public/js/components/job-import.js public/js/components/duplicate-compare.js public/js/format.js tests/integration/ui-jobs.test.mjs`；`git commit -m "feat: browse jobs with evidence and source provenance"`。

### E4: 工作台与投递进度

**Files:** Create public/js/pages/{workbench,applications}.js、public/js/components/{run-progress,application-form,application-board}.js、tests/integration/ui-workbench.test.mjs、tests/integration/ui-applications.test.mjs。

**Interfaces:** Produces mountWorkbenchPage({root,api,store}):{destroy}、mountApplicationsPage({root,api,store}):{destroy}；run-progress 使用 D4事件，application-form 发 {status,note,resumeRevisionId,appliedAt,followUpAt} patch。

- [ ] **Step 1 — 测试：**
```js
test('workspace reflects partial runs and real application saves', async () => {
  const f=await workbenchUiFixture();
  await f.startRun(); await f.emitPartialResult();
  assert.ok(f.root.textContent.includes('部分来源失败'));
  assert.equal(f.cancelButton.disabled,false);
  await f.clearApplicationNote();
  assert.equal(f.lastPatch.note,'');
  await f.failNextSave();
  assert.ok(f.root.textContent.includes('保存失败'));
  assert.equal(f.shownSavedToast,false);
});
```
- [ ] **Step 2 — 红灯：** ui-workbench/ui-applications 两文件预期页面缺失。
- [ ] **Step 3 — 实现：** 当前目标、未处理新增、待跟进、七天内明确截止日期与更新入口。显示真实来源覆盖/漏斗/预算/partial/degraded，取消按钮幂等、重启interrupted可重新更新，说明关闭页面任务继续。投递列表/看板共用API，状态中文标签与事件历史，保存备注/日期/简历版本；键盘提供状态下拉，无仅拖拽操作。跟进日期按用户本地日期显示，缺失日期不捏造。
- [ ] **Step 4 — 绿灯：** 两测试通过；补测无目标引导、seq重放不加新增、取消后已完成数据可见、状态失败保持旧值、切换列表/看板、跨时区日期、待跟进/截止日期不同口径。
- [ ] **Step 5 — 提交：** `git add public/js/pages/workbench.js public/js/pages/applications.js public/js/components/run-progress.js public/js/components/application-form.js public/js/components/application-board.js tests/integration/ui-workbench.test.mjs tests/integration/ui-applications.test.mjs`；`git commit -m "feat: track job updates and application follow ups"`。

### E5: 来源设置、预算与密钥界面

**Files:** Create public/js/pages/settings.js、public/js/components/{source-table,model-settings,backup-panel}.js、tests/integration/ui-settings.test.mjs。

**Interfaces:** Produces mountSettingsPage({root,api,store,desktopBridge}):{destroy}；source-table 读 /sources 并 probe/saveConfig；model-settings 只内存持有临时Key，桌面通过 E6 desktopBridge 保存/清除加密Key。

- [ ] **Step 1 — 测试：**
```js
test('settings distinguishes candidates and never persists temporary keys', async () => {
  const f=await settingsUiFixture();
  await f.enterKey('synthetic-secret');
  assert.equal(f.localStorageWrites,0); assert.equal(f.sessionStorageWrites,0);
  assert.equal(JSON.stringify(f.store.getState()).includes('synthetic-secret'),false);
  await f.probeEmptySource();
  assert.ok(f.root.textContent.includes('未取得有效样本'));
  assert.ok(f.root.textContent.includes('最近成功'));
  assert.ok(f.root.textContent.includes('本次尝试'));
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/integration/ui-settings.test.mjs`，预期设置页缺失。
- [ ] **Step 3 — 实现：** 来源开关/能力/目录归属/验证时间/统计/错误/截断，单源检查、手工站点验证、标准/广泛预算。模型规则/AI模式与兼容endpoint配置、调用/token统计，未配置价格不显示虚构费用。API脱敏，Key字段空白占位；用户备份/导出/恢复经校验结果显示，分享部署明确单工作区。
- [ ] **Step 4 — 绿灯：** ui-settings 通过；补测API错误、restricted/parse_error/empty差别、预算输入限额、未配置Key规则模式、desktop加密不可用、备份恢复校验失败、页面销毁清理临时Key。
- [ ] **Step 5 — 提交：** `git add public/js/pages/settings.js public/js/components/source-table.js public/js/components/model-settings.js public/js/components/backup-panel.js tests/integration/ui-settings.test.mjs`；`git commit -m "feat: configure source coverage and private model access"`。

### E6: CLI、桌面密钥、启动与打包兼容

**Files:** Create electron/preload.cjs、tests/integration/cli-compat.test.mjs、tests/unit/desktop-bridge.test.mjs；Modify src/cli.mjs、src/start-public.mjs、src/server.mjs、electron/main.mjs、tools/{build-desktop,fetch-electron,verify-package,test-desktop,test-deploy-assets}.mjs、Dockerfile、deploy/{nginx.conf,Caddyfile}、package.json、README.md。

**Interfaces:** 保留 CLI 旧 --resume/位置参数/--text/--cities/--keywords/--year/--no-intern/--all-years/--format/--out/--no-llm/--top。新增 `targets list`、`runs start --target <id> --rules`、`runs show <id>`、`applications set <jobId> --status <status>`、`sources probe <sourceId>`。desktopBridge 只暴露 {isAvailable(),saveKey(provider,key),deleteKey(provider),getKeyStatus(provider)}；读取明文Key仅主进程给模型客户端，不返回renderer。Electron window 与server实例均调用同一Context。

- [ ] **Step 1 — 测试：**
```js
test('legacy cli and public starter still produce usable service', async t => {
  const old=await runCliFixture(t,['--text',SYNTHETIC_RESUME,'--no-llm','--format','json']);
  assert.equal(old.code,0); assert.ok(JSON.parse(old.stdout).jobs);
  assert.equal((await runPublicStarterFixture(t)).health.status,'ok');
  assert.equal((await desktopSeedFixture(t)).loadedConfigMarker,'seed-data-dir');
  assert.equal((await desktopKeyFixture()).rendererReceivedPlainKey,false);
});
```
- [ ] **Step 2 — 红灯：** cli-compat/desktop-bridge 两测试，预期新子命令未实现，public启动器与配置种子反例失败。
- [ ] **Step 3 — 实现：** CLI所有路径接入Context，日志去stderr确保JSON stdout有效；传入参数语义保留，中英文列表分隔/相对cwd路径保留。start-public 显式调用已导出的 startServer；seed配置在读取前生效。Electron设置RJR_DATA_DIR后导入，safeStorage加密写独立凭据文件并检测可用性，IPC校验sender frame/provider/长度；加密不可用不自动改明文。包复制src/public/electron及所有新配置/ontology目录，生产依赖闭包含Acorn；ASAR/resedit直接开发依赖显式声明，下载器按打包所需ZIP校验而非只看exe。反代v2事件路径禁缓冲，MIME支持浏览器模块，共用version。
- [ ] **Step 4 — 绿灯：** 两测试及 `npm run test:desktop`、`npm run test:deploy`、`npm run verify:package` 通过；正式 `npm run dist:desktop` 并检查便携包启动、Key状态、外链HTTP(S)、数据目录、no-user-config-in-package。Docker构建/启动在可用环境执行并记录，缺工具不能写成通过。
- [ ] **Step 5 — 提交：** `git add electron src/cli.mjs src/start-public.mjs src/server.mjs tools/build-desktop.mjs tools/fetch-electron.mjs tools/verify-package.mjs tools/test-desktop.mjs tools/test-deploy-assets.mjs Dockerfile deploy/nginx.conf deploy/Caddyfile package.json package-lock.json README.md tests/integration/cli-compat.test.mjs tests/unit/desktop-bridge.test.mjs`；`git commit -m "feat: integrate cli desktop and deployment with workspace services"`。

### E7: 全流程、视觉检查和发布文档

**Files:** Create tests/e2e/workspace-flow.test.mjs、tests/e2e/migration-recovery.test.mjs、docs/reports/2026-10-05-v2-release-verification.md、docs/v2-upgrade-guide.md；Modify tools/run-e2e.mjs、tools/run-all-tests.mjs、.github/workflows/ci.yml、README.md、deploy/部署指南.md。

**Interfaces:** Consumes 所有应用服务与可控假源；e2e 在独立RJR_DATA_DIR启动真实HTTP服务，显式允许仅该本地服务连接，公网仍被guard禁止。发布报告记录实际命令/退出码/环境/包路径/限制。

- [ ] **Step 1 — 测试：**
```js
test('personal job workflow survives restart and exports human records', async t => {
  const f=await workspaceFlowFixture(t);
  await f.previewAndConfirmResume(); await f.saveTarget();
  const run=await f.updateJobsWithPartialSource(); assert.equal(run.status,'partial');
  await f.markApplied({note:'跟进',resumeRevisionId:f.profileRevisionId});
  await f.restart();
  assert.equal((await f.readApplication()).note,'跟进');
  assert.ok((await f.exportMarkdown()).includes('已投递'));
  assert.equal(f.publicNetworkCalls,0);
});
```
- [ ] **Step 2 — 红灯：** 两e2e文件运行，预期缺少完整串联/迁移恢复验证；失败必须指向真实行为而非套件漏执行。
- [ ] **Step 3 — 实现：** 完成导入→画像校正→目标→任务→部分结果→已投递→重启→导出全流程；补取消/断线重连/无Key/故障恢复。文档写启动/升级/备份/回退语义，渠道能力及可用状态引用C6报告，旧数据来源与输出目录明确；CI离线硬门槛、live probe独立不伪装稳定离线验证。
- [ ] **Step 4 — 绿灯与交付：** `npm run test:offline`、`node tools/test-v2.mjs --group e2e`、`npm run audit`、`npm run verify:package` 均实际通过。真实浏览器检查1440px和390px：五页、长中文标题/长JD、空状态、Tab/Enter/Esc、焦点返回、菜单与无横向溢出；Electron实际启动。用合成v1数据演练迁移/幂等/损坏备份拒绝，原业务数据集成前只预检并备份。最终独立代码审阅，修复具体问题后只重跑相关检查和必要全局gate。
- [ ] **Step 5 — 提交：** `git add tests/e2e docs/reports/2026-10-05-v2-release-verification.md docs/v2-upgrade-guide.md tools/run-e2e.mjs tools/run-all-tests.mjs .github/workflows/ci.yml README.md deploy/部署指南.md`；`git commit -m "test: verify workspace upgrade and document release"`。
