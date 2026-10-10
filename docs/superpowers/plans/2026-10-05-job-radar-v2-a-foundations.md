# Job Radar v2 A: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可信的测试基础，修复身份、网页载荷、简历和技能匹配的已复现问题。

**Architecture:** 领域规则以纯函数提取；已有入口通过兼容包装消费同一规则。先用合成反例建立会失败的断言，再逐项实现。

**Tech Stack:** Node >=20 ESM、node:test/assert、Acorn、现有 pdfjs-dist。

**Spec:** [设计](../specs/2026-10-04-job-radar-v2-design.md)；共用类型见 [主计划](2026-10-05-job-radar-v2.md)。

## Global Constraints

- Node >=20；生产代码继续使用 ESM；前端采用原生 ES modules 与 CSS。
- 测试使用独立临时数据目录和合成样例，禁止访问原项目业务目录。
- 离线测试在请求层禁止真实网络调用；联网探针显式运行。
- 未知事实保留 unknown；未知 URL 参数保留；不执行远端脚本。
- PDF/DOCX/TXT/MD 保留；上传上限 20MB；不引入 OCR。

## Review Focus

1. 离线套件意外通过 fetch/http/https 出站：A1 guard 必须让子进程非零退出。
2. 明确招聘编号相同但标题/城市变更：A2 应更新同一岗位的观察，不新造岗位。
3. Nuxt IIFE 表面像数据而内部赋值/getter：A3 拒绝并无副作用。
4. DOCX 未引用页眉、异常 ZIP 偏移/膨胀：A4 不混入正文，不无限解压。
5. PDF 双栏且文本对象乱序、中文紧邻 C++：A5 保持栏序；A6 保留词义。

---

### A1: 契约与真正离线的测试运行器

**Files:** Create src/domain/contracts.mjs、tests/helpers/{fixtures,network-guard,clock}.mjs、tests/unit/test-runner.test.mjs、tools/test-v2.mjs；Modify package.json、tools/run-all-tests.mjs、tools/test-fontmap.mjs、tools/test-font-stability.mjs；Create tests/fixtures/fonts/*.json（确定性字体映射样本）。

**Interfaces:** Produces 主计划的实体/枚举与 assertWorkspace(value):Workspace、assertSourceRecord(value):SourceRecord、createEmptyWorkspace():Workspace；fixtures 的 job(overrides={}):SourceRecord、profile(overrides={}):ConfirmedProfile（即 ProfileRevision.profile 的结构）、target(overrides={}):SearchTarget、createTempDir(t):Promise<string>；createFakeClock(start):{now,advance,sleep}。test-v2 支持 --file <path>、--group unit|integration|e2e、--list。

- [ ] **Step 1 — 测试：** tests/unit/test-runner.test.mjs 中加入下面断言；runner helper 用子进程运行脚本、返回 {code,stdout,stderr}。
```js
test('offline guard rejects native network and discovers nested tests', async () => {
  assert.equal((await runGuarded('fetch("https://example.com")')).code, 1);
  assert.equal((await runGuarded('import("node:https").then(h=>h.get("https://example.com"))')).code, 1);
  assert.ok((await listTests()).includes('tests/unit/test-runner.test.mjs'));
  assert.throws(() => assertWorkspace({schemaVersion:3}), /schema/i);
});
```
- [ ] **Step 2 — 红灯：** `node --test tests/unit/test-runner.test.mjs`，预期缺少 contracts/runner 或网络 guard 断言失败。
- [ ] **Step 3 — 实现：** 定义契约与校验；runner 递归发现测试、为每次执行创建独立 RJR_DATA_DIR，preload guard 拦截 fetch/http/https/net/tls；允许显式测试内注入本地 transport。旧字体测试改用保存的合成映射与未知字符断言，真实抓取移入显式 probe。npm test:offline 同时运行旧离线套件和 v2 测试，不无条件 exit(0)。
- [ ] **Step 4 — 绿灯：** `node tools/test-v2.mjs --file tests/unit/test-runner.test.mjs` 和 `npm run test:offline`，预期退出 0，网络 guard 的子进程退出 1；清理仅处理自己创建的绝对临时目录。
- [ ] **Step 5 — 提交：** `git add src/domain/contracts.mjs tests/helpers tests/unit/test-runner.test.mjs tests/fixtures/fonts tools/test-v2.mjs tools/run-all-tests.mjs tools/test-fontmap.mjs tools/test-font-stability.mjs package.json`；`git commit -m "test: establish v2 contracts and offline test discovery"`。

### A2: 强身份、保守关联与来源生命周期

**Files:** Create src/domain/{identity,lifecycle}.mjs、tests/unit/identity.test.mjs、tests/unit/lifecycle.test.mjs；Modify src/util/text.mjs。

**Interfaces:** Consumes SourceRecord；Produces canonicalizeSourceUrl(url,policy):string、resolveJobIdentity(record):{key,strength,aliases}、relateJobs(a,b):{relation:'same'|'possible'|'distinct',reasons:string[]}、deriveLifecycle({previous,observations,coverage,detailEvidence,now}):{state,evidence,deadlinePassed}。旧 jobKey/dedupeJobs 同步使用该规则。

- [ ] **Step 1 — 测试：** identity.test.mjs 和 lifecycle.test.mjs 固定复现及缺席规则。
```js
test('identity protects level city and pid', () => {
  for (const [a,b] of conflictingPairs) assert.equal(relateJobs(a,b).relation,'distinct');
  assert.notEqual(canonicalizeSourceUrl('https://x.example/j?pid=2',{}),
                  canonicalizeSourceUrl('https://x.example/j?pid=3',{}));
  assert.equal(relateJobs(sameIdOldCity,sameIdNewCity).relation,'same');
});
test('missing results and one 404 never close a job', () => {
  assert.notEqual(deriveLifecycle(emptyRun).state,'closed');
  assert.equal(deriveLifecycle(single404).state,'inaccessible');
  assert.equal(deriveLifecycle(explicitClosed).state,'closed');
});
```
- [ ] **Step 2 — 红灯：** 分别运行 `node tools/test-v2.mjs --file tests/unit/identity.test.mjs` 与 lifecycle.test.mjs，预期函数缺失/当前误合并。
- [ ] **Step 3 — 实现：** 招聘编号在 source/雇主作用域内优先；不同编号/城市/届别/类型/职级阻止模糊合并；无编号跨源仅 possible。剥离已知追踪参数，保留未知、签名、路由 hash；公司未知不模糊合并。lifecycle 只在相同覆盖范围比较，空结果/失败/低分不关闭；显式证据与 deadlinePassed 分开。
- [ ] **Step 4 — 绿灯：** 两个测试退出 0；conflictingPairs 必含 Java I/II、北京/上海、pid 2/3、不同届别；另测已知 utm 删除、C++ 保留、unknown 公司。
- [ ] **Step 5 — 提交：** `git add src/domain/identity.mjs src/domain/lifecycle.mjs src/util/text.mjs tests/unit/identity.test.mjs tests/unit/lifecycle.test.mjs`；`git commit -m "fix: preserve job identity and evidence based lifecycle"`。

### A3: 远端数据静态解析

**Files:** Create src/util/static-payload.mjs、tests/unit/static-payload.test.mjs、tests/fixtures/payloads/*.txt；Modify src/util/html.mjs、package.json、package-lock.json。

**Interfaces:** Produces parseStaticPayload(expression,{maxBytes=1048576,maxNodes=50000,maxDepth=100}={}):unknown；extractNuxtData(html) 继续返回可解析数据或 null，并能由来源获取结构化解析问题。

- [ ] **Step 1 — 测试：** 在 static-payload.test.mjs 读取合成表达式。
```js
test('parses bound literal IIFE without executing code', () => {
  assert.deepEqual(parseStaticPayload('(function(a){return {title:a};})("工程师")'),{title:'工程师'});
  for (const input of hostilePayloads) assert.throws(() => parseStaticPayload(input));
  assert.equal(globalThis.__rjrDesignProbe,undefined);
  assert.throws(() => parseStaticPayload(deepPayload,{maxDepth:10}), /limit|depth/i);
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/unit/static-payload.test.mjs`，预期静态解析模块缺失。
- [ ] **Step 3 — 实现：** 执行时查官方 Acorn 当前兼容版本，以 `npm install --save-exact acorn@<核实版本>` 锁定。只解释字面量/数组/普通对象/IIFE 参数绑定/受限 return；任意调用、全局对象、赋值、getter、import、原型键拒绝。替换 new Function 路径；超限报告解析失败。
- [ ] **Step 4 — 绿灯：** 上述测试退出 0；hostilePayloads 覆盖全局赋值、Object constructor、getter、__proto__、动态 import；`rg -n 'new Function|eval\\(' src/util` 无远端执行路径。
- [ ] **Step 5 — 提交：** `git add src/util/static-payload.mjs src/util/html.mjs tests/unit/static-payload.test.mjs tests/fixtures/payloads package.json package-lock.json`；`git commit -m "fix: statically parse remote embedded data"`。

### A4: DOCX 顺序与多部件提取

**Files:** Create src/resume/{docx,zip}.mjs、tests/unit/docx.test.mjs、tests/fixtures/resume/docx-*.docx、tests/helpers/resume-files.mjs；Modify src/resume/extract-text.mjs。

**Interfaces:** Produces readDocx(buffer):{text,warnings}、readZipEntries(buffer,{maxExpandedBytes=41943040}):Map<string,Buffer>；extractResumeText(buffer,filename) 扩展返回 {text,format,warnings,parserVersion}，旧 text/format 保留。helper makeDocx(parts):Buffer 生成合成 ZIP。

- [ ] **Step 1 — 测试：**
```js
test('docx keeps inline order and only referenced headers', async () => {
  const r = await extractResumeText(makeDocx(inlineAndHeaderParts),'sample.docx');
  assert.match(r.text,/姓名\s+张三\s+Java/);
  assert.ok(r.text.includes('test@example.com'));
  assert.ok(!r.text.includes('UNREFERENCED'));
  assert.throws(() => readZipEntries(badOffsetZip),/ZIP|offset/i);
  assert.throws(() => readZipEntries(expansionZip,{maxExpandedBytes:32}),/limit|size/i);
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/unit/docx.test.mjs`，预期当前段内顺序/页眉断言失败。
- [ ] **Step 3 — 实现：** 在 XML token 原位置输出 tab/br、段落和表格同行分隔；解码数字实体；根据正文关系读取实际引用页眉页脚。ZIP 中央目录/本地头/压缩方式/条目与累计大小校验，限制解压实际输出，拒绝异常路径。清洗不重新拼接本已分隔字段。
- [ ] **Step 4 — 绿灯：** DOCX 测试退出 0；另覆盖多表格、中文实体、截断文件、未知压缩、空正文、20MB 输入拒绝，引用外部部件不抓取。
- [ ] **Step 5 — 提交：** `git add src/resume/docx.mjs src/resume/zip.mjs src/resume/extract-text.mjs tests/unit/docx.test.mjs tests/helpers/resume-files.mjs tests/fixtures/resume`；`git commit -m "fix: preserve docx text order and referenced parts"`。

### A5: PDF 阅读顺序和明确警告

**Files:** Create src/resume/pdf-layout.mjs、tests/unit/pdf-layout.test.mjs、tests/fixtures/resume/pdf-*.json；Modify src/resume/extract-text.mjs。

**Interfaces:** Produces orderPdfItems(items,pageSize):{text,warnings}；items 消费 pdfjs 的 str/transform/width/height/hasEOL；沿用 A4 提取结果形状。

- [ ] **Step 1 — 测试：**
```js
test('pdf shuffled columns preserve reading order', () => {
  assert.equal(orderPdfItems(twoColumnsShuffled,{width:600,height:800}).text,
               '左栏第一行\n左栏第二行\n右栏第一行\n右栏第二行');
  assert.ok(orderPdfItems([],{width:600,height:800}).warnings.includes('no_extractable_text'));
  assert.ok(orderPdfItems(ambiguousLayout,{width:600,height:800}).warnings.includes('reading_order_uncertain'));
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/unit/pdf-layout.test.mjs`，预期模块缺失。
- [ ] **Step 3 — 实现：** 按坐标识别行与栏，单栏保持上下阅读，双栏先左后右；跨栏标题单独处理。不确定布局提供警告，预览允许用户改；继续使用 pdfjs 且关闭其 eval。
- [ ] **Step 4 — 绿灯：** 测试退出 0；另有单栏、跨栏标题、同一行分离文本、空白图片页夹具；实际合成 PDF 通过 extractResumeText 得到一致结果。
- [ ] **Step 5 — 提交：** `git add src/resume/pdf-layout.mjs src/resume/extract-text.mjs tests/unit/pdf-layout.test.mjs tests/fixtures/resume`；`git commit -m "fix: reconstruct pdf column reading order"`。

### A6: 技能词条与专业族

**Files:** Create src/domain/skills.mjs、src/domain/ontology.json、tests/unit/skills.test.mjs；Modify src/util/skills.mjs、src/match/score.mjs。

**Interfaces:** Produces findSkillEvidence(text,skillIds):{skillId,matchedText,start,end,relation:'exact'|'alias'|'related'}[]、majorRoleFit(profile,record):{status,reasons}。旧 matchedKeywords(job,keywords) 和 majorFit(job,profile) 调用同一词条边界。

- [ ] **Step 1 — 测试：**
```js
test('skill boundaries preserve distinct meanings', () => {
  assert.equal(findSkillEvidence('JavaScript CAD CET',['java','c']).length,0);
  assert.deepEqual(findSkillEvidence('熟悉Java与C++开发',['java','cpp']).map(x=>x.skillId),['java','cpp']);
  assert.notEqual(majorRoleFit(fireSafetyProfile,cybersecurityJob).status,'matched');
  assert.equal(findSkillEvidence('了解Spring',['java']).some(x=>x.relation==='exact'),false);
});
```
- [ ] **Step 2 — 红灯：** `node tools/test-v2.mjs --file tests/unit/skills.test.mjs`，预期词条模块缺失/原 substring 误命中。
- [ ] **Step 3 — 实现：** 规范词条 ID 与显式别名、关联分开；英文单词和 C++/C# 用专属边界，支持中文紧邻英文；专业/岗位族映射覆盖软件、消防安全、航空制造与职能，不把相关技能自动视为掌握。
- [ ] **Step 4 — 绿灯：** skills 测试及现有证书/消防/专业离线断言通过；相关词只提供弱关联证据，不能用于必备技能 pass。
- [ ] **Step 5 — 提交：** `git add src/domain/skills.mjs src/domain/ontology.json src/util/skills.mjs src/match/score.mjs tests/unit/skills.test.mjs`；`git commit -m "fix: match skills and majors with explicit evidence"`。
