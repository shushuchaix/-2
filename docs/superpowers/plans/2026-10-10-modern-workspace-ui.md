# Modern Workspace UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付深蓝导航、浅色阅读区、青蓝细线的现代求职工作台，使版本归属、任务状态、岗位证据和下一步操作清晰可用。

**Architecture:** 保留 React 与 shadcn Base UI、现有服务端隔离及删除契约。将当前版本采集查询、活动状态和预算展示集中到小型呈现模块，再调整九页布局；不重建采集器、权限系统、回收站调度或账本。

**Tech Stack:** Node.js >=20、React 19.3、TypeScript 5.9、Tailwind 4.3、shadcn base-nova / Base UI 1.8、Electron 44.5；沿用 Testing Library + node:test、现有离线 Chromium 自测。

**Spec:** `docs/superpowers/specs/2026-10-10-modern-workspace-ui-design.md`。

状态：用户已在本会话通过推荐设计；**本实施计划待用户审阅，尚未据此修改产品**。执行方式沿用当前会话；已批准的来源效能与 Boss 九项计划继续独立执行。

## Global Constraints

- 保留九页、三组导航、精确 packageId + targetRevisionId、全部目标只读汇总；切换版本不得短暂展示旧版本数据或会话。
- 模型累计上限 10 元；0 元禁用模型。暂停、恢复、换批次不重置根活动账本；请求预算与模型费用上界必须说明各自含义。
- 默认预算复用 `public/js/validation-rules.js` 的 `collectionLimitsFor()`，实际活动以服务返回的 `collectionProgress.limits` 和 `collectionUsage` 为准；不改该共享计算规则。
- 目标简历副本独立；整包回收、恢复和永久删除复用现有服务。保留 72 小时、到期不可查看/恢复、启动补清、预览哈希和 409 重新预览。
- 同名占用直到永久删除完成；全版本去重逐版本执行。本计划不新增跨版本合并、私有数据共用或后台常驻清理。
- 使用本地资源与字体，保留 CSPProvider disableStyleElements 和 Base UI `render`；不新增组件库、远程字体、大型动画库或实时付费调用。
- 页标题 28px、区标题 18px、正文 16px、辅助 13–14px；交互区域至少 44px；动效 150–200ms，减少动效关闭非必要动画。
- CSS 宽度验收 1440 / 1024 / 768 / 375px；实际 Chromium DPR 验收 1 / 1.5 / 2，对应 100% / 150% / 200% 显示比例，报告不能声称修改了 Windows 系统设置。
- UI、日志和导出中的诊断继续使用白名单；不含简历正文、关键词、网页正文、凭据或私人路径。正常业务正文只在已授权版本界面展示。
- 所有测试使用合成数据与网络守卫；最终真实简历来源测试属于总任务，不在本 UI 测试中外发私人数据。

## Review Focus

1. A 版本延迟响应在切换 B 后返回：不得写入 B 的活动、岗位或会话；由 Task 2 的延迟响应测试和 Task 6 的窗口归属测试覆盖。
2. 根活动与子批次状态矛盾、取消后新开：根进度决定当前状态，旧结果不得残留；由 Task 2、4 覆盖。
3. 高模型分数但正文/时效/条件未知、仅沟通入口：首屏不能显示已核实推荐或已可投递；由 Task 5 覆盖。
4. 50 来源、多站点、关闭详情后再打开：请求数量不随卡片数膨胀，筛选/分页与失败草稿保留；由 Task 6 覆盖。
5. 回收详情打开期间到期、筛选后清空、409 和部分删除：清除正文，范围准确，不虚报成功；由 Task 9 覆盖。

## 文件与职责

| 单元 | 文件 | 职责 |
| --- | --- | --- |
| 视觉与外壳 | `ui/src/styles.css`、`ui/src/app/App.tsx`、`ui/src/hooks/use-mobile.ts`、`ui/src/components/ui/sidebar.tsx`、`tabs.tsx` | 唯一语义主题、九页导航、边界与命中区域 |
| 当前活动 | 新增 `ui/src/app/CollectionContext.tsx`、`ui/src/features/workbench/activity-view.ts`；修改 `ui/src/lib/types.ts` | 按版本共享读取、晚到响应隔离、状态投影 |
| 预算呈现 | 新增 `ui/src/lib/budget-view.ts`、`ui/src/components/BudgetSummary.tsx` | 默认/保存/活动预算投影与统一文案 |
| 岗位证据 | 新增 `ui/src/features/jobs/evidence-view.ts`、`EvidenceSummary.tsx` | 四项证据及入口行为，保留原文证据 |
| 来源管理 | 新增 `ui/src/features/sources/SourceDetailsSheet.tsx`、`SourceSettings.tsx`、`SiteProbeCard.tsx`、`source-view.ts` | 摘要列表与按需详情，现有操作迁入小文件 |
| 计数摘要 | 新增 `ui/src/components/RecordCounts.tsx` | 业务/整包计数的可读展示，不透传任意对象 |
| 验收证据 | 修改 `electron/self-test.mjs`、`tools/verify-desktop-self-test.ps1`；新增 `docs/verification/2026-10-10-modern-workspace-ui.md` | 新 EXE、九页、四宽度、三 DPR 的实际证据 |

现有功能文件及测试的精确范围在各任务列出。除以上测试、自测及呈现文件，本计划无需改动服务端业务或重新实现回收隔离。

## 执行顺序与共同门槛

Task 1 → Task 2 → Task 3 → Task 4；Task 5、6 在 Task 2/3 完成后可分别处理；Task 7、8 在 Task 1 完成后可独立处理；Task 9 依赖 Task 8 的计数组件；Task 10 汇总验收。
实现期间依授权使用现有 b70d 工作树；操作前查看当前差异，保护其他代理的来源改动。同一共享文件由当前任务负责人串行编辑。
每项 RED 必须来自缺失/错误的用户行为或实际几何，不以夹具、类型或网络错误冒充；旧测试已覆盖的契约直接复用，不复制服务端生命周期测试。
以下命令均在项目根目录运行；每项完成执行 `npm run typecheck:ui`，预期 exit 0。测试预期为 TAP `fail 0`，不锁死其他计划新增后的总测试数量。
每项 GREEN 后仅暂存该项文件并提交一个小提交；计划编写阶段不执行这些提交，`public/app` 只由构建工具生成。

---

### Task 1: 主题、导航与可读外壳

**Files:** Modify `ui/src/styles.css`、`ui/src/app/App.tsx`、`ui/src/hooks/use-mobile.ts`、`ui/src/components/ui/sidebar.tsx`、`ui/src/components/ui/tabs.tsx`；Test `tests/ui/shell.test.tsx`。

**Interfaces:** 保留 `App({api, desktop})`、`VersionProvider`、`buildHash()` 与 `TargetPicker`。导航链接增加 `aria-current="page"`；CSS 暴露 `.workspace-header`、`.workspace-reading`、`.workspace-decoration`，不改变路由协议。

- [ ] RED：新增 `current navigation is named and all-target context stays read-only`，断言当前导航可识别，切页保留精确 hash，全部目标没有可执行更新按钮。
  ```ts
  assert.equal(f.screen.getByRole("link", { name: "工作台" }).getAttribute("aria-current"), "page");
  assert.equal(f.screen.getAllByRole("link", { name: /^(工作台|岗位库|投递进度|简历管理|求职目标|招聘来源|运行日志|回收站|设置)$/ }).length, 9);
  ```
- [ ] 运行 `node tools/test-ui.mjs --file tests/ui/shell.test.tsx`，确认新增当前页标记断言失败；既有九页/归属测试保持。
- [ ] GREEN：设置 spec 的全部 token：sidebar `#0B1427/#DCEAF5`、选中 `#13263D/#7DD3FC`、背景 `#F4F7FB`、card 白、正文 `#102136`、辅助 `#53657A`、primary `#0369A1/白`、accent `#38BDF8/#082F49`、border `#D8E2ED`、ring `#0369A1`；成功 `#166534/#F0FDF4`、警告 `#92400E/#FFFBEB`、错误 `#B91C1C/#FEF2F2`。
- [ ] GREEN：224px 导航，<=768px 使用导航 Sheet，主区 max 1440px，阅读列 680–760px；版本名称优先，装饰 aria-hidden；Tabs 容器容纳 44px 触发器，图标操作有名称，焦点 2px/offset 3px。
- [ ] GREEN：150–200ms 局部反馈与 prefers-reduced-motion；字体本地 system-ui/Microsoft YaHei/PingFang SC，不添加闪烁、滚动揭示或循环动效。
- [ ] 复跑本项测试与类型检查；实际色彩/几何交给 Task 10 的 Chromium 检查，不能用 jsdom 宣称完成视觉验收。提交 `feat(ui): define modern workspace theme and navigation`。

### Task 2: 每版本共享活动查询与状态投影

**Files:** Create `ui/src/app/CollectionContext.tsx`、`ui/src/features/workbench/activity-view.ts`、`tests/ui/collection-context.test.tsx`；Modify `ui/src/lib/types.ts`、`ui/src/app/App.tsx`、`ui/src/features/workbench/WorkbenchPage.tsx`、`ui/src/features/workbench/CollectionProgress.tsx`。迁移 CollectionActivity 类型及消费者 import，不删已有 CollectionQuality 字段。

**Interfaces:**
- `CollectionProvider({api: ApiClient, children: ReactNode}): ReactElement` 放在 VersionProvider 内；`useCollectionActivity()` 返回 `{activity: CollectionActivity|null, loading: boolean, error: ApiError|null, lastFetchedAt: string|null, refresh(): Promise<void>, adopt(value: CollectionActivity, scope: Scope): void}`。
- `deriveActivityView(activity: CollectionActivity|null, slice: Record<string, unknown>|null): {rootId: string|null, status: string, label: string, phase: string|null}`；有根活动时 `collectionProgress.status` 权威，子批次只贡献当前阶段；无根时支持既有单次运行。

- [ ] RED：同一 App 头部与两消费者仅一次初始 `/collections`；无活动时创建任务能够发现新根；暂停根 + completed 子批次显示“已暂停，可继续”；延迟 A 请求释放后 B 不显示 A 的活动；没有 scope/全部目标不查询私人活动。
  ```ts
  assert.equal(f.apiCalls.filter(c => c.path === "/collections").length, 1);
  assert.equal(f.screen.queryByText("A_PRIVATE_ACTIVITY"), null);
  assert.equal(deriveActivityView(pausedRoot, { status: "completed" }).status, "paused");
  ```
- [ ] 运行 `node tools/test-ui.mjs --file tests/ui/collection-context.test.tsx`，确认共享消费者或状态测试有效失败；使用 deferred Promise，避免真实网络/计时等待。
- [ ] GREEN：一次当前版本请求，采集/暂停/待登录/额度不足状态每 2000ms 共享刷新，禁止重叠；终态停止轮询，操作后 refresh/adopt；切换 scope 或卸载 abort，按 generation 丢弃晚到响应。
- [ ] GREEN：使用服务 `/collections` 的倒序第一根记录，不将子批次当根；adopt 校验传入 scope 与当前选择。刷新失败保留同 scope 最后数据并标注最后成功读取时间，跨 scope 立即清空。
- [ ] GREEN：Workbench 原根活动轮询迁入 Context，头部/工作台共用；startRunOnce 提交成功与流 done 后 refresh，暂停/恢复/取消后 adopt 返回根，不能因初始无根或终态停轮询漏掉新活动。deriveActivityView 只使用与 activeSliceRunId 一致的子批次阶段。
- [ ] 复跑本项及 `tests/ui/shell.test.tsx`，类型检查；仅迁移类型时保留兼容 export，后续消费者逐项切换。提交 `refactor(ui): share scoped collection activity and status`。

### Task 3: 集中预算来源与展示

**Files:** Create `ui/src/lib/budget-view.ts`、`ui/src/components/BudgetSummary.tsx`、`tests/ui/budget-summary.test.tsx`；Modify `ui/src/features/targets/CreateTargetDialog.tsx`、`ui/src/features/workbench/RunOptions.tsx`、`ui/src/features/workbench/CollectionProgress.tsx`、`ui/src/features/workbench/WorkbenchPage.tsx`、`ui/src/features/settings/SettingsPage.tsx`；新增断言到 `tests/ui/targets.test.tsx`。

**Interfaces:** `BudgetInput={coverageMode?: "standard"|"broad", overrides?: Record<string,number>, modelBudget?: {maxCostCny?: number|null, maxModelRequests?: number}, activity?: CollectionActivity|null}`；`budgetView(input: BudgetInput): BudgetView`，输出包含 `source: "default"|"saved"|"activity"`、`limits: Record<string,number>`、`costMode: "cny"|"request_count"|"unknown"`、`usedCostCny/remainingCostCny: number|null`。`BudgetSummary({view: BudgetView, label: string}): ReactElement` 提供命名 section。

- [ ] RED：目标新建显示与共享计算一致的标准 24/400/4、广覆盖 50/1000/10；保存 overrides 700 请求展示 700；已存在活动保持自己的上限，不随新建模式切换；0 元不变成默认 10。
  ```ts
  assert.equal(budgetView({ coverageMode: "standard", overrides: {} }).limits.maxRequests, 400);
  assert.equal(budgetView({ coverageMode: "broad", overrides: {} }).limits.maxPagesPerQuery, 10);
  assert.equal(budgetView({ coverageMode: "standard", overrides: { maxCostCny: 0 } }).limits.maxCostCny, 0);
  ```
- [ ] 运行 `node tools/test-ui.mjs --file tests/ui/budget-summary.test.tsx`；同时在 `tests/ui/targets.test.tsx` 加新建预算用户可见断言，确认旧 12/120 文案的行为 RED。
- [ ] GREEN：直接复用 `collectionLimitsFor()`，不复制数字表。无活动时区分模式默认/已保存配置，有活动用根 limits/usage；未知费用显示“未提供”，不补 0；上界已含预留时不重复加预留费用。
- [ ] GREEN：无活动金额优先级为显式 overrides.maxCostCny（含 0）→ modelBudget.maxCostCny（含 null 的旧请求模式）→ 共享默认；有活动始终用根上限，不以新建/设置草稿覆盖它。全局旧请求次数预算不误合为采集资源限制。
- [ ] GREEN：0 元显示“模型调用已关闭”；没有金额账本的旧设置保留请求次数模式，不把 null 偷换为金额 10；设置尚未保存的草稿标“待保存”，不表示已生效。
- [ ] GREEN：四处共同使用 BudgetSummary；默认最大站数与当次实际规划数量分开，保留费用上界并非服务商账单及继续不重置说明。此任务不修改 API/账本或放宽 cap。
- [ ] 复跑本项、targets、collection-workbench、settings 四测试文件与类型检查；root 使用 3.20/10 仍显示 6.80 剩余且恢复后不变。提交 `refactor(ui): centralize budget presentation`。

### Task 4: 工作台统一活动与下一步

**Files:** Modify `ui/src/features/workbench/WorkbenchPage.tsx`、`ui/src/features/workbench/CollectionProgress.tsx`、`ui/src/features/workbench/RunSummary.tsx`、`ui/src/app/App.tsx`；Test `tests/ui/workbench.test.tsx`、`tests/ui/collection-workbench.test.tsx`。

**Interfaces:** 使用 Task 2 的 useCollectionActivity/deriveActivityView 与 Task 3 的 BudgetSummary；CollectionProgress 保留现有 pause/resume/cancel/limits 参数与 API 调用，作为唯一活动卡；RunSummary 仅展示终态批次结果与覆盖明细。

- [ ] RED：取消后重新启动/恢复仅显示新状态，旧“任务已取消”不出现；同一根暂停即使子批次 completed 仍可继续；恢复双击只 POST 一次，并使用原 activityId/剩余账本。
  ```ts
  assert.equal(f.screen.queryByText("任务已取消"), null);
  assert.equal(f.screen.getAllByRole("region", { name: "当前采集活动" }).length, 1);
  assert.equal(f.apiCalls.filter(c => c.path.endsWith("/resume")).length, 1);
  ```
- [ ] 分别运行 workbench 与 collection-workbench 文件，确认旧结果残留/重复活动卡有效 RED，保留已存在的断线重连与临时密钥清除测试。
- [ ] GREEN：利用 Task 2 已接线的共享 Context；新 child/root 切换清空旧 outcome，头部与卡片使用同一状态投影，历史结果明确日期与归属。
- [ ] GREEN：主操作与目标摘要置顶，进度/结果随后，高级请求计数和额度编辑折叠；改动不破坏 startRunOnce、流重连或临时密钥生命周期。
- [ ] GREEN：使用真实 `CollectionQuality` 展示四项证据、validNewUnique、knownRequests 和 unknownRequestUpperBound；缺字段显示未统计，已知分母指标与未知上界分列，无包含关系漏斗或伪覆盖率。
- [ ] GREEN：源失败/人工验证显示受影响来源，区分完成、部分成功、预算耗尽、取消、失败；成功提示服务确认后出现，失败保留已取得结果和日志入口。
- [ ] 复跑两文件与类型检查，验证新活动 UI 不同时出现“运行中/取消”；提交 `feat(ui): clarify collection progress and recovery`。

### Task 5: 岗位证据摘要、列表与详情顺序

**Files:** Create `ui/src/features/jobs/evidence-view.ts`、`ui/src/features/jobs/EvidenceSummary.tsx`；Modify `ui/src/features/jobs/JobsPage.tsx`、`ui/src/features/jobs/JobDetailsSheet.tsx`、`ui/src/features/jobs/RecruitmentEvidence.tsx`、`ui/src/features/jobs/job-view.ts`；Test `tests/ui/jobs.test.tsx`、`tests/ui/recruitment-evidence.test.tsx`。

**Interfaces:** `evidenceView(row: JobItem): EvidenceView` 返回 `items: {key: "body"|"opening"|"application"|"qualification", label: string, state: "verified"|"unknown"|"unavailable", reason: string|null}[]`、`conflicts: string[]` 及 `entryLabel: "前往投递"|"查看入口（待核验）"|"打开沟通入口"|null`。`EvidenceSummary({view: EvidenceView, compact?: boolean}): ReactElement`；引用已有来源字段，不生成业务事实。

- [ ] RED：100 分且 bodyVerified=false/openingStatus=unknown/qualification=unknown 时首屏显示待核验与缺失项，分数不成为已核实推荐；仅沟通入口不能显示前往投递。
  ```ts
  assert.equal(f.screen.queryByRole("link", { name: "前往投递" }), null);
  assert.ok(f.screen.getByRole("region", { name: "岗位证据摘要" }));
  assert.ok(f.screen.getByRole("tab", { name: "岗位原文" }));
  ```
- [ ] 分别运行 jobs 与 recruitment-evidence 文件，确认旧首屏结构/入口标签 RED；额外检查 closed 与 unknown 分开、冲突不被分数消除。
- [ ] GREEN：列表突出岗位/企业、城市、资格与三个招聘证据，分数辅助；详情先摘要/条件结论/四证据/操作，再原文、评价依据、来源与核验历史 Tabs。
- [ ] GREEN：原有字段片段、页码/行号、时间与冲突保留；未知不用 0/通过替代。显示服务推荐结论时附证据缺口，不在前端重算领域评分。
- [ ] GREEN：核验活动使用 Task 2 Context，适用活动/预算条件遵循当前已批准服务；不复活旧“必须采集中”的限制。识别 `fact.platformEvidence.entry.kind === "communication"`，未知/失效入口标签与 `recruitmentEvidence.applicationStatus` 一致；仅有 safeExternalUrl 校验通过的对应 URL 才显示入口链接，保留平台观察独立说明。
- [ ] GREEN：记录投递仍可人工操作，成功刷新所属版本；底部按钮预留内容空间。全部目标仍需“进入所属版本”后操作，不能擅自为汇总页查询私有活动。
- [ ] 复跑两文件、applications 既有保存测试与类型检查；1440/375 首屏顺序由 Task 10 实际几何及截图验收。提交 `feat(ui): put recruitment evidence before scoring`。

### Task 6: 来源摘要、折叠配置与单次查询

**Files:** Create `ui/src/features/sources/source-view.ts`、`ui/src/features/sources/SourceDetailsSheet.tsx`、`ui/src/features/sources/SourceSettings.tsx`、`ui/src/features/sources/SiteProbeCard.tsx`；Modify `ui/src/features/sources/SourcesPage.tsx`、`ui/src/features/sources/SiteDialog.tsx`、`ui/src/features/sources/CollectionSessionDialog.tsx`；Test `tests/ui/sources.test.tsx`、`tests/ui/social-sessions.test.tsx`。

**Interfaces:** `SourceFilters={query:string, category:string, enabled:"all"|"enabled"|"disabled", health:string, page:number}`；`sourceRows(sources:SourceSummary[], sites:SourceSite[], filters:SourceFilters): {items: SourceSummary[], total:number}`，来源页每页 20。`SourceDetailsProps={api:ApiClient, desktop:DesktopAdapter, source:SourceSummary|null, sites:SourceSite[], activity:CollectionActivity|null, scope:Scope|null, onClose():void, onChanged():void}`；`SourceDetailsSheet(props:SourceDetailsProps):ReactElement`；scope=null 仅可读目录，站点每页 20。

- [ ] RED：合成 50 来源×10 站点，初始只挂载 20 摘要且没有未打开详情的配置输入；共享 `/collections` 初始一次，搜索唯一来源、关闭再打开保留筛选/页码。
  ```ts
  assert.equal(f.apiCalls.filter(c => c.path === "/collections").length, 1);
  assert.equal(f.screen.queryByLabelText("已知公开文章/帖子链接（每行一个）"), null);
  assert.equal(f.screen.getAllByRole("button", { name: "查看来源配置" }).length, 20);
  ```
- [ ] 运行 sources 文件，确认旧全部展开/每站点查询 RED；social-sessions 加 A→B 切换后不可保留 A 会话窗口操作的归属断言。
- [ ] GREEN：保留 `/sources` 目录读取一次，将旧卡片配置/探针迁入详情组件；搜索/类别/启用/健康筛选和分页在目录上实现，不声称新增服务端分页。
- [ ] GREEN：目录摘要默认挂载，展开才挂载配置/会话状态；SiteProbeCard 不 useQuery collections，活动由 Task 2 传入。分类来自实际来源/站点元数据，缺分类为未分类。
- [ ] GREEN：目录共享与版本配置分开说明，ready 标为近期探针状态，正文/入口能力与核验时间分别显示；失败的来源独立错误/日志入口，不遮盖正常来源。
- [ ] GREEN：来源保存失败保留草稿；关闭再打开保留当前 scope 的 `{enabled:boolean, urls:string, accounts:string}` 非敏感草稿，不新增确认弹窗。换版本清空详情与草稿，不缓存临时密钥或付费确认；平台窗口、人工验证、风险暂停保持现有受控接口。
- [ ] 复跑两文件与类型检查；人工检查首屏 DOM 和请求记录，确认无按站点倍增的活动查询。提交 `refactor(ui): organize source configuration on demand`。

### Task 7: 简历、目标与输入反馈

**Files:** Modify `ui/src/features/profiles/ProfilesPage.tsx`、`ui/src/features/profiles/ImportProfileDialog.tsx`、`ui/src/features/targets/TargetsPage.tsx`、`ui/src/features/targets/CreateTargetDialog.tsx`、`ui/src/features/targets/TargetDetailsSheet.tsx`、`ui/src/components/FormFeedback.tsx`、`ui/src/components/OperationFeedback.tsx`；Test `tests/ui/profiles.test.tsx`、`tests/ui/targets.test.tsx`、`tests/ui/feedback.test.tsx`。

**Interfaces:** 保留所有导入、校正、保存、VersionActions 参数；OperationFeedback 新增可选 `busyLabel?: string`，默认保持兼容。技术编号收进有名称的 Collapsible，用户名称为主，不新增名称检查接口。

- [ ] RED：主版本卡不铺 revisionId；展开“技术信息”才可查看；server 名称错误作用于提交的名称，编辑成新名称后旧错误不能再次覆盖，成功清除错误。
  ```ts
  assert.equal(f.screen.queryByText("目标版本 · t-existing@1"), null);
  assert.equal(nameInput.getAttribute("aria-invalid"), "false"); // 编辑为新名称，旧响应晚到后
  assert.equal(f.apiCalls.filter(c => c.options.method === "POST" && c.path === "/targets").length, 1);
  ```
- [ ] 分别运行 targets/profiles/feedback 文件，确认技术标识或旧字段错误 RED；复用同名唯一、重复提交、目标自有副本现有测试。
- [ ] GREEN：导入与校正分区、版本摘要名称/资料/更新状态/启用清楚；目标方向地区与绑定副本可读；填写项目分组，沿用错误摘要聚焦和保留草稿。
- [ ] GREEN：把服务端字段错误绑定当前提交草稿/名称；输入变化清除对应旧错误，不将晚到响应写到另一版本；正在写入时防重复提交，业务成功回调仍处理已提交版本。
- [ ] GREEN：busyLabel 说明具体动作，服务确认后才播报一次成功；失败留在对应区域与日志入口，不给普通可逆编辑额外确认。
- [ ] 复跑三文件及 `tests/ui/version-actions.test.tsx`，类型检查；确认停用/回收仍使用既有服务。提交 `feat(ui): clarify resume and target version forms`。

### Task 8: 投递、日志与设置的语义摘要

**Files:** Create `ui/src/components/RecordCounts.tsx`；Modify `ui/src/features/applications/ApplicationsPage.tsx`、`ui/src/features/applications/ApplicationEditor.tsx`、`ui/src/features/logs/LogsPage.tsx`、`ui/src/features/logs/DiagnosticDetails.tsx`、`ui/src/features/settings/SettingsPage.tsx`、`ui/src/features/settings/LegacyAssignmentPanel.tsx`、`ui/src/features/settings/DedupDialog.tsx`；Test `tests/ui/applications.test.tsx`、`tests/ui/logs.test.tsx`、`tests/ui/settings.test.tsx`。

**Interfaces:** `RecordCounts({counts: Record<string,unknown>, kind: "package"|"run", label: string}): ReactElement`；package 仅九个 Counts 字段，run 仅已知计数字段，数值 0 与未提供区分。其他业务详情按实际 kind 显示已有字段，不将任意对象传给 JSON 展示。

- [ ] RED：日志 first view 显示阶段/结果/日期与“采集 3 / 保存 2”，无需读取 raw JSON；旧记录分配/去重预览显示可读范围与计数，不用 ID 作为岗位名称。
  ```ts
  assert.ok(f.screen.getByRole("region", { name: "运行结果摘要" }));
  assert.equal(f.screen.queryByText(/"raw":\s*3/), null);
  assert.equal(f.screen.queryByText("PRIVATE_DIAGNOSTIC_SENTINEL"), null);
  ```
- [ ] 分别运行对应三文件，确认旧 JSON first view RED；保留日志 hash/浏览器历史/导出及投递所属简历副本的既有测试。
- [ ] GREEN：RecordCounts 使用中文 dt/dd；未知字段不冒充已知含义。日志技术 ID、白名单计数 JSON 放“技术详情”，复用 safeDiagnostic，保留排障信息。
- [ ] GREEN：设置按模型费用、目录、备份恢复、迁移分组；分配预览按实际 kind 显示名称/来源/时间与计数。去重预览显示版本、保留/删除条数及原因；现 API 未给岗位标题时显示“岗位标题未提供”，编号留技术区，不额外跨版本补抓正文。
- [ ] GREEN：投递看板保持“当前页”分组，分页总量与列计数分开；375px 单列，桌面列不强迫九列横向铺开，操作成功/失败明确且保留备注草稿。
- [ ] 复跑三文件与类型检查；JSON 技术区不能包含私人 sentinel，备份预览与恢复契约保持。提交 `feat(ui): present readable business and diagnostic summaries`。

### Task 9: 回收站呈现、范围与到期反馈

**Files:** Modify `ui/src/features/trash/TrashPage.tsx`、`ui/src/features/trash/TrashDetailsSheet.tsx`、`ui/src/features/trash/PurgeConfirmDialog.tsx`；Test `tests/ui/trash.test.tsx`；消费 Task 8 的 RecordCounts。

**Interfaces:** 保留 Preview/PurgeResult、purgeAt、scope 与 API；详情中新增 `<section aria-label="版本内容摘要">`，按 kind 呈现已有资料、目标和子数据计数，技术编号折叠，不改变 allowed/定时到期检查。

- [ ] RED：未到期详情可读而无整对象 JSON；打开期间越过 purgeAt 后摘要与正文清除；已有 409/全范围/部分失败用例在新布局仍正确。
  ```ts
  assert.ok(f.screen.getByRole("region", { name: "版本内容摘要" }));
  assert.equal(f.screen.queryByText(/"profileSnapshot"/), null);
  assert.equal(f.screen.queryByText("PRIVATE_BODY_SENTINEL"), null); // 到期后
  ```
- [ ] 运行 `node tools/test-ui.mjs --file tests/ui/trash.test.tsx`，确认旧 raw JSON 摘要 RED；时间推进用合成时间与受控时钟，不读取或删除真实回收内容。
- [ ] GREEN：列表显示种类/名称/子集计数/时间/剩余时间，未到期/已到期/清理中/失败可重试分别可读；purge_pending 只匿名操作元数据。
- [ ] GREEN：详情沿用原 allowed 和取消晚到请求；到期隐藏业务内容并取消恢复。确认窗使用 RecordCounts，清空显式整个回收站；409 必须重新预览，部分结果说明完成与剩余，未完成删除不释放名称。
- [ ] 复跑本项与类型检查；不触碰 scheduler、storage、purge、backup 代码，不新增 72h 业务测试副本。提交 `feat(ui): clarify trash scope and cleanup outcomes`。

### Task 10: 生产构建、实际 Chromium 与新 EXE 验收

**Files:** Modify `electron/self-test.mjs`、`tools/verify-desktop-self-test.ps1`；Create `docs/verification/2026-10-10-modern-workspace-ui.md`；如需要新增自测用合成记录，放现有 self-test 隔离数据目录内，不接触正式库。

**Interfaces:** 保留 `--self-test`、隔离 RJR_DATA_DIR 与 network guard；PS script 默认 Scales 改为 `@(1, 1.5, 2)`，合法集合保留 1.25。报告记录每张 `{page,width,actualWidth,dpr,file}` 与检查结果。

- [ ] RED：运行现有脚本 `& .\tools\verify-desktop-self-test.ps1 -Scales @(2)`，当前应拒绝 `Unsupported verification scale`；扩展报告检查要求九页×四宽度，旧报告缺失矩阵必须失败，不能跳过 200% 验收。
- [ ] GREEN：自测覆盖 9 页×1440/1024/768/375，在每个 DPR 中记录真实 innerWidth/devicePixelRatio 与 PNG；任何量化到 374/376 的窄屏记实际值，检查导航断点而非伪造 375。矩阵使用正常合成版本，在永久删除测试前捕获；不得把已 purge 身份写回。
- [ ] GREEN：检查 document scrollWidth 无页面溢出、表格仅容器横滚、Tabs/主要图标按钮命中至少 44px、375 浮层不出窗、弹窗 Esc 关闭并归还焦点、底部操作不遮挡焦点/最后内容。
- [ ] GREEN：用实际 computedStyle 计算对比度：普通文字 >=4.5:1，大字及必要控件边界/焦点 >=3:1；核对正文、当前导航、主按钮与警告。减少动效下数据仍可见；录制源搜索/详情、恢复、高分低证据、字段失败、到期/409/部分删除的合成交互。
- [ ] 执行 `npm run test:ui`、`npm run typecheck:ui`、`npm run build:ui`，预期各 exit 0；检查生产 CSP 与构建资产 `node --test tests/integration/ui-build-assets.test.mjs`，预期 fail 0。
- [ ] 执行 `npm run test:offline`，预期 fail 0；只为具体失败修复和重跑相关项，稳定后完成一次全量门槛，不重复无理由全量测试。
- [ ] 执行 `npm run dist:desktop`，预期 exit 0；随后 `& .\tools\verify-desktop-self-test.ps1 -Scales @(1, 1.5, 2)`，每份报告 Exit=0、failed=0、synthetic=true、externalRequests=0，实际 DPR 与请求值差 <=0.02。若正式软件占用发行文件，请用户保存后关闭该软件，再重建，不终止其他进程。
- [ ] 逐页查看 108 张矩阵截图，并检查关键弹窗/失败状态截图，修复遮挡、文字、对比及滚动；截图不包含真实简历。报告记录新 EXE 绝对路径、SHA256、命令/结果、三份 JSON 和截图目录、未完成项。
- [ ] 审查单次最终差异及必要修复；新 EXE 与报告一致后提交 `test(ui): verify modern workspace across sizes and display scales`。PR/交付仍由主任务统一处理，不关机。

## 自审结果与交接

- Spec 覆盖：主题/三方案选定与布局 Task 1；上下文 Task 2；预算 Task 3；工作台 Task 4；岗位 Task 5；来源 Task 6；版本表单 Task 7；其余语义摘要 Task 8；回收站 Task 9；响应/视觉/新 EXE Task 10。
- 接口检查：CollectionActivity 迁入 types，保留 CollectionQuality；所有消费者使用同一个 Context。预算只投影既有共享规则，未定义另一份服务端预算；Counts/Preview/PurgeResult 沿用现有类型。
- 失败类检查：Review Focus 五项各有明确测试；0/null/预留、全部目标只读、名称晚到错误、日志私人 sentinel 另外在对应任务覆盖。
- 范围检查：不重复原九项采集计划，不重做版本隔离或 72h 清理；已实现行为复用既有测试，新呈现与共享状态有独立 RED→GREEN。
- 可执行性：精确文件、接口、断言、单文件命令与结果均已给出；三 DPR 支持缺口已明确。设计批准来自本会话，设计文件旧状态文字不构成重复审批要求。

本计划交主代理展示给用户审阅。沿用已选择的当前会话实施，计划审阅通过后再开始上述产品修改；原已批准来源效能九项工作继续。
