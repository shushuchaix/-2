# 求职工作台界面、版本隔离与回收站 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付使用真正 shadcn 组件的九页求职工作台，让每个版本及其子记录独立保存、整包回收，并在归档 72 小时后可靠永久清理。

**Architecture:** 保留 Node/Electron 服务与 JSON 原子存储，增加包所有权、稳定记录身份及不可被备份覆盖的持久控制状态。React 前端只操作经过服务端校验的版本范围。数据迁移、删除控制、界面及交付是同一项发布，不能发布混用旧全局投递与新包归属的中间版本。

**Tech Stack:** Node.js ESM、node:test、Electron；React、TypeScript、Vite、Tailwind、官方 shadcn Base UI、Lucide；React 测试使用 tsx + jsdom + React Testing Library，保留现有后端测试运行器。

**Spec:** [已批准书面设计](../specs/2026-10-09-ui-version-isolation-and-trash-design.md)，2026-10-09 用户批准；设计提交 `e8691bb`。

## Global Constraints

- 每个包有永久不复用的 UUID `packageId`；种类为 `profile`、`target`、`legacy_unassigned`。每个私有记录恰有一个 `ownerPackageId`，并有稳定、不复用的随机 `recordId`；事件、附件和私有快照同样拥有记录身份。
- 主文件固定路径 `workspace.v2.json` 保留，内容格式升级为 `schemaVersion: 3`。API 路径保持 `/api/v2`；所有业务读写验证包身份，全部目标仅提供带归属的只读汇总。
- 目标保存时复制完整简历正文、画像和修正信息；源简历的 ID 只作来源说明。新目标包默认没有旧目标的岗位、评价、检索和投递记录。
- 同种版本名称不可重复，回收站内名称仍占用；永久清理完成后释放名称。沿用现有名称规范、字段限制、保存幂等及原子验证，版本号高水位不回退。
- 全版本清理遍历全部版本，逐版本执行，包含停用和尚未到期的回收站包；不跨包合并个人记录，不改变归档期限，不覆盖冲突的人工记录。
- 生命周期为 `active → trashed → purge_pending → purged`。`enabled` 与包状态分开；恢复保留移入前的启停状态。
- `purgeAt = archivedAt + 72h`；重复归档不重置时间。满 72 小时后恢复接口拒绝恢复，即使文件清理尚未完成。运行期间每五分钟检查；启动先恢复死亡租约和中断运行，再补清理。
- 旧回收站的一次宽限期限取原期限与首次迁移时刻加 72 小时中的较晚值；重复迁移、失败重试、恢复同一旧备份不续期。
- `control/` 不作为业务备份恢复的替换对象；稳定身份、归属转移、归档期限、版本高水位和永久删除登记必须保留。控制状态损坏或初始化后关键文件缺失进入维护状态，不能初始化空登记。
- 清空处理整个回收站，页面筛选不改变范围；状态变化或新增包使旧预览失效。永久删除完成包括主 JSON、运行文件、上一版、已消费旧存储及应用管理备份，不能只完成 JSON 删除就报成功。
- 九页路由：`#/workbench`、`#/jobs`、`#/applications`、`#/profiles`、`#/targets`、`#/sources`、`#/logs`、`#/trash`、`#/settings`；正文 16px、次要文字不小于 13px、主要按钮至少 44px，动画 150–200ms 并支持 reduced-motion。
- 岗位默认每页 25 条，可选 50/100；搜索 250ms 防抖。验证 375/768/1024/1440 宽度与 Windows 125%/150% 缩放；使用浅色语义 token，采用设计第 4 节全部颜色，不增加主题功能或 GSAP。
- Vite root=`ui/`、publicDir=`false`、outDir=`public/app/`、base=`/app/`；仅清理这个输出目录。服务端 `/` 返回生成入口；Electron 加载根 URL 加 Hash。
- 保留登录资产、后端引用的共享纯模块、认证、CSP、contextIsolation 和根页面 sender 校验；生产无 Vite 服务、CDN、外部字体、内联脚本或放宽 CSP。
- 金额以元填写展示，保留用户当前 v4.1 模型与 10 元上限、0 元校验、规则模式不发送 Key；诊断只保存白名单技术元数据，不含个人正文、名称、关键词、凭据或私人路径。
- 预算沿用“每任务模型费用上限（元）”，`maxCostCny` 有效范围 0–10、最多两位小数；0 可保存，表示禁用模型调用。保持已保存 provider/model 实际标识，不将用户口头的“v4.1”直接改写为 API model 字符串；现有官方默认标识为 `deepseek-flash`，迁移保留已有配置，兼容模型继续沿用已核实价格/请求次数规则。
- 验收仅使用合成数据、临时 `RJR_DATA_DIR`、可注入时钟和禁止外部网络的 guard；禁止回落用户日常配置或凭据，不发起付费模型调用。
- 依赖实施时按官方文档/CLI 的真实兼容要求核实并锁定。构建及测试必须在 Node 20.20.2 上验证；如所选最新版不支持此版本，选择受支持版本，不以本机 Node 24 的成功代替 CI 兼容性。

## Review Focus

1. 中文、空白、大小写及回收站同名冲突：规范化后仍唯一，失败保留草稿，永久清理完成前不释放名称（任务 4、14、17）。
2. 已到 72 小时但定时器未执行，随后恢复归档前的备份：先登记清理，不能复活或延长期限；旧宽限重试不续期（任务 3、9、11）。
3. 旧投递从待归属包移动到 A、删除 A、恢复移动前备份：稳定记录及事件不能复活；B 主动复制的相同简历正文仍保留（任务 8、10、11）。
4. 快速切换版本、重复提交、375px 和缩放后的长中文名称：旧请求和事件不能覆盖新版本，错误可定位、抽屉焦点能返回、页面不溢出（任务 13–17、19）。
5. 生成资源缺失、CSP 拦截定位组件、非根旧链接及自测未设置目录：明确失败或正确重定向，真实 EXE 不访问用户配置、凭据和外部网络（任务 13、18、19）。

---

## 文件职责与任务边界

下列路径均相对项目根；任务内明确创建/修改。保留已有服务工厂，不做与本需求无关的目录重排。

| 文件 | 唯一职责 / 任务 |
|---|---|
| `src/domain/packages.mjs`、`package-ownership.mjs` | 包状态/时间、所有权及引用校验（1） |
| `src/domain/contracts.mjs`、`workspace-management.mjs`、`version-names.mjs`、`version-references.mjs` | schema3、包约束、名称与旧引用规则调整（1、4） |
| `src/infrastructure/storage/package-control.mjs` | 控制身份、转移、期限、高水位、删除登记的格式和原子存取（2） |
| `src/infrastructure/storage/repository.mjs`、`layout.mjs`、`atomic.mjs` | 共享锁事务、控制检查、上一版和快照过滤（2） |
| `src/infrastructure/storage/bootstrap-workspace.mjs`、`package-migration.mjs` | 启动前格式检查、稳定迁移和旧入口消费（3） |
| `src/infrastructure/storage/migrate-v1.mjs`、`upgrade-workspace.mjs` | 原迁移入口统一转入 bootstrap（3、12） |
| `src/application/workspace-service.mjs` | 简历包/目标包保存、独立副本、版本管理（4） |
| `src/application/job-service.mjs`、`import-service.mjs`、`export-service.mjs` | 包内岗位实例、投递及导入导出（5） |
| `src/application/run-service.mjs`、`evaluation-service.mjs`、`run-events.mjs`、`workspace-operations.mjs` | 包内任务/评分/事件、租约与取消等待（6） |
| `src/domain/job-duplicates.mjs`、`job-resolution.mjs`、`src/application/job-cleanup-service.mjs` | 逐包查重、预览和保守合并（7） |
| `src/application/legacy-assignment-service.mjs` | 待归属数据闭包检查与唯一移动（8） |
| `src/application/trash-service.mjs` | 整包回收/恢复、清空预览与到期裁决（9） |
| `src/application/purge-service.mjs`、`src/infrastructure/storage/purge-files.mjs` | 持久删除任务与受管理文件清理（10） |
| `src/infrastructure/storage/backup.mjs`、`backup-filter.mjs` | 管理备份净化与删除过滤（10），原备份验证与恢复顺序（11） |
| `src/application/context.mjs`、`trash-scheduler.mjs`、`src/infrastructure/storage/recovery.mjs` | 服务装配、恢复先后、五分钟检查与关闭（12） |
| `src/server/routes-v2.mjs`、`routes-v1.mjs`、`src/pipeline.mjs`、`store.mjs`、`cli.mjs` | 显式 scope 的 API 与旧入口拒绝/转换（5–12） |
| `ui/src/app/App.tsx`、`router.ts`、`VersionContext.tsx`、`ui/src/lib/api.ts`、`types.ts`、`desktop.ts` | 九页 shell、Hash/scope、请求和桥接（13） |
| `ui/src/components/FormFeedback.tsx`、`OperationFeedback.tsx`、`VersionActions.tsx`、`TargetPicker.tsx` | 统一错误、成功、忙碌和版本管理交互（13–17） |
| `ui/src/features/profiles/`、`targets/` | 简历导入与目标创建/管理（14） |
| `ui/src/features/workbench/`、`jobs/`、`applications/` | 日常求职三页与本版本详情/投递（15） |
| `ui/src/features/sources/`、`logs/`、`settings/` | 来源、业务历史/脱敏诊断、设置与维护（16） |
| `ui/src/features/trash/` | 回收站状态矩阵、整包确认/恢复/重试（17） |
| `ui/src/components/ui/`、`ui/src/styles.css`、`ui/index.html`、`ui/vite.config.ts`、`ui/tsconfig.json`、`ui/components.json` | 官方生成组件、主题、编译配置（13） |
| `tests/helpers/package-fixture.mjs`、`react-dom.mjs`、`react-fixture.tsx`、`tools/test-ui.mjs` | 隔离后端/React 夹具与 node:test TSX 子运行器（2–13） |
| `src/server.mjs`、`tools/build-ui.mjs`、`tools/build-desktop.mjs`、`verify-package.mjs`、`run-all-tests.mjs` | 新静态入口、统一构建与发布门槛（13、18） |
| `electron/self-test.mjs`、`self-test-network.mjs`、`main.mjs` | 打包后真实窗口、临时数据、合成依赖、主进程/渲染网络守卫（19） |
| `package.json`、`package-lock.json`、`.github/workflows/ci.yml`、`Dockerfile`、`.dockerignore`、`.gitignore` | 锁定依赖、CI/Docker 与构建资产规则（13、18） |
| `design-system/MASTER.md`、`docs/UI-ACCEPTANCE.md`、`README.md` | 设计 token/操作规范、验收证据与使用说明（13、19） |

### 公共契约（后续任务使用同一命名）

以下是 JS 的 JSDoc / TS 的共享类型；接口写入 `ui/src/lib/types.ts` 时不得更名或放宽。现有岗位/简历字段沿用当前定义，此处只定义新增边界。

```ts
type PackageKind = 'profile' | 'target' | 'legacy_unassigned';
type PackageState = 'active' | 'trashed' | 'purge_pending' | 'purged';
type Scope = { packageId: string; targetRevisionId: string }; // 必须精确匹配
type ReadScope = Scope | { allTargets: true }; // 汇总只读
type Owner = { recordId: string; ownerPackageId: string };
type Counts = { profiles: number; targets: number; jobs: number; observations: number;
  evaluations: number; runs: number; applications: number; events: number; files: number };
type Package = { packageId: string; kind: PackageKind; versionId: string;
  versionName: string; enabled: boolean; state: PackageState; archiveId: string | null;
  archivedAt: string | null; purgeAt: string | null };
type Workspace3 = { schemaVersion: 3; revision: number; packages: Record<string, Package>;
  /* 现有集合全部带 Owner，投递改按独立 applicationId 索引 */ };
type Control = { formatVersion: 1; workspaceId: string;
  identityIndex: Record<'package'|'record', Record<string,string>>;
  ownershipTransfers: object; versionHighWater: object; archiveEpisodes: object;
  deletionLedger: object; purgeTasks: object; migrationJournal: object };
type Clock = { now(): Date }; // 复用 createFakeClock，非数字时间
type Lease = { id: string }; // 保留现有租约字段，新增包范围
type Preview = { workspaceRevision: number; planHash: string;
  candidates: { packageId: string; archiveId: string; purgeAt: string; counts: Counts }[];
  totals: Counts; packageCount: number };
type PurgeResult = { completed: string[]; pending: string[];
  failed: { operationId: string; code: string }[] };
```

`Workspace3` 的省略集合必须在任务 1 逐项保留并完整校验，不能按这个示意类型删除原有配置。控制登记中不放版本名称；清理未完成的名称占用留在主工作区管理项。

服务错误统一 `{code, message, fieldErrors?, diagnosticId?}`；HTTP 返回保留现有错误结构。固定错误码：`package_not_found`(404)、`package_archived`/`package_expired`/`package_purge_pending`/`package_scope_mismatch`/`package_operation_active`/`trash_preview_stale`/`legacy_ownership_ambiguous`(409)、`control_state_invalid`/`purge_file_failed`(503)。输入字段错误沿用现有 400；旧范围无法唯一转换用 `version_scope_required`(409)。

### 运行约定与依赖顺序

- 所有 `node` 命令使用已验证的 Node 20.20.2；本机路径 `.cache/node20-runtime/node-v20.20.2-win-x64/node.exe`。运行前核对 `node --version`，不得无意改用 PATH 中的 Node 24。
- 后端单文件：`node tools/test-v2.mjs --file tests/...test.mjs`；React：`node tools/test-ui.mjs --file tests/ui/...test.tsx`。运行器保持 `stdio: inherit`、临时目录和出站网络禁止，不移除失败断言来通过门槛。
- `packageFixture(t, options?)` 返回 `{repository, control, clock, reopen(), armFailure(phase)}`；任务 4 加 `workspaceService, twoTargets()`，5 加 `jobs, importService, exportService, ingest(scope,records)`，6 加 `runs, evaluations, eventHub`，7/8 加 `cleanup, assignment`，9–12 加 `trash, purge, backup, scheduler`。`twoTargets()` 返回 `{sourceProfile, a: Scope, b: Scope}`，使用合成正文和不同名称；`reopen()` 保持 dataDir/时钟、重建服务；故障在 fixture 准备完毕后才启用。每次 fixture 扩展都在相应任务实现，不引用未来未定义助手。
- `seedLegacy(t, {workspace, runs?, backups?})` 返回独立 dataDir，在任务 3 实现；`failOnce(fsAdapter, phase)` 在任务 2 提供一次故障注入，phase 枚举为 `control_commit|workspace_commit|previous_commit|snapshot_write|file_cleanup|backup_replace`。
- 所有任务均含独立测试周期；共同依赖：1→2→3→4→5→6，7/8 依赖 5/6，9 依赖 6/8，10 依赖 2/9，11 依赖 3/8/10，12 依赖 7/11。13 可独立建立可测试 UI shell；14–17 接入已完成服务；18/19 合并验证。沿用用户选择的当前会话执行，任务逐个提交，整项完成后一次独立分支审查。

## 第一阶段：数据所有权、迁移及业务隔离

### Task 1: schema3 与纯领域包约束

**Files:** Create `src/domain/packages.mjs`, `src/domain/package-ownership.mjs`, `tests/unit/packages.test.mjs`; Modify `src/domain/contracts.mjs`, `src/domain/workspace-management.mjs`, `tests/unit/test-runner.test.mjs`, `tests/helpers/fixtures.mjs`。

**Interfaces:** Produces `assertWorkspace(value): Workspace3`, `requirePackage(w, packageId, {access, now}): Package`（access=`business|trash_read|management`）、`assertScope(w, scope, now): Package`、`assertOwned(w, record, packageId): void`、`countPackageRecords(w, packageId): Counts`、`archiveDeadline(archivedAt): string`。

- [ ] **1. 写失败测试**：`schema3 validates every private collection and rejects cross-package references`，逐项覆盖 jobs/observations/evaluations/runs/applications/events/files，schema4 拒绝；纯时间测试断言：
  ```js
  test('72h boundary is exact UTC', () => {
    assert.equal(archiveDeadline('2026-10-09T00:00:00.000Z'), '2026-10-12T00:00:00.000Z');
    assert.throws(() => assertOwned(w, {...record, ownerPackageId: 'B'}, 'A'), {code: 'package_scope_mismatch'});
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/unit/packages.test.mjs`；预期缺少新模块/函数或所有权断言失败。
- [ ] **3. 实现上列签名**：新增包登记与所有 Owner；事件/文件不得漏校验；跨包仅允许来源说明/公开身份。更新 fixture 为 schema3，未来版本拒绝改为 4，保留损坏结构断言。
- [ ] **4. 运行通过**：同命令及 `node tools/test-v2.mjs --file tests/unit/test-runner.test.mjs`；两者全通过，不接受仅修改 schema 数字。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: define package ownership and schema3 contracts"`。

### Task 2: 持久控制状态与同锁存储事务

**Files:** Create `src/infrastructure/storage/package-control.mjs`, `tests/helpers/package-fixture.mjs`, `tests/integration/package-control.test.mjs`; Modify `src/infrastructure/storage/repository.mjs`, `layout.mjs`, `atomic.mjs`, `tests/helpers/repository.mjs`, `tests/integration/repository.test.mjs`。

**Interfaces:** Produces `openPackageControl({dataDir, fsAdapter, clock})` → `{read(): Promise<Control>}`；`repository.withMaintenanceTransaction(action, {operationLease?, bootstrap?: boolean}): Promise<T>`；action 接收 `tx={workspace, control, commitControl(next): Promise<void>, commitWorkspace(next): Promise<void>, readSnapshot(id): Promise<Snapshot>, writeSnapshot(id,snapshot): Promise<void>, removeManagedFile(fileId): Promise<void>}`；`reserveIdentity(tx,{namespace:'package'|'record',key:string}): Promise<string>` 持久分配/复用 UUID 并同步 tx.control。事务方法在已持有的工作区锁内执行，不再次取锁；只供内部服务使用，不暴露为 HTTP。保留 `read/mutateWorkspace/readRunSnapshot/writeRunSnapshot` 签名并统一控制检查。

- [ ] **1. 写失败测试**：`initialized control missing is blocked`、`prepared identities survive failed main commit`、`previous file never rewrites deleted bodies`；每种原子写失败/重试都留存已持久身份：
  ```js
  test('prepared identity is reused after workspace commit failure', async t => {
    const f = await packageFixture(t); f.armFailure('workspace_commit');
    await assert.rejects(() => f.repository.withMaintenanceTransaction(async tx => {
      await reserveIdentity(tx,{namespace:'package',key:'synthetic'});
      await tx.commitWorkspace(tx.workspace);
    }));
    const id = await f.control.read().then(c => c.identityIndex.package.synthetic);
    assert.match(id,/^[a-f0-9-]{36}$/);
    await f.reopen();
    assert.equal((await f.control.read()).identityIndex.package.synthetic, id);
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/integration/package-control.test.mjs`；预期缺模块/事务接口或控制保护断言失败。
- [ ] **3. 实现接口**：布局增加 `control/state.json`、`control/initialized.json`。initialized 保存 workspaceId/格式及初始化阶段；先持久准备完整初始 control，完成后标记 initialized，不把中断初始化误当全新安装。已标记完成后缺失/校验失败必拒绝业务与恢复。控制更新先于业务提交，身份/高水位只增不回退；维护事务明确提交顺序，读取与上一版写入应用删除登记。快照包含 Owner，旧未分配快照只能通过迁移入口读取。实现 fixture 与故障注入助手。
- [ ] **4. 运行通过**：本任务测试、`repository.test.mjs`、`atomic-storage.test.mjs`；检查锁不嵌套、失败可诊断、没有自动空初始化或被删正文落入 previous。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: persist package control outside backup replacement"`。

### Task 3: 可重试旧数据迁移与一次宽限

**Files:** Create `src/infrastructure/storage/bootstrap-workspace.mjs`, `package-migration.mjs`, `tests/integration/package-migration.test.mjs`; Modify `migrate-v1.mjs`, `upgrade-workspace.mjs`（均在 storage）、`tests/helpers/package-fixture.mjs`, `tests/integration/migration.test.mjs`。

**Interfaces:** Consumes Task 2 transaction；Produces `bootstrapWorkspace({repository, clock}): Promise<MigrationReport>`、`normalizeBackupOwnership({workspace, snapshots, control, now}): {workspace: Workspace3, snapshots, control, report}`；报告 `{packageCount, counts: Counts, unassignedCount, warnings: string[]}`。身份键采用 kind+旧 revisionId+不可变内容摘要，归档旧实例键持久保存首次期限。

- [ ] **1. 写失败测试**：`ambiguous application is not cloned into all targets`、`immutable mapping ignores rename and enabled changes`、`target copies verified resume or becomes incomplete`、`migration rollback leaves legacy readable only by migration`；宽限测试：
  ```js
  test('legacy grace is granted once across retry and restore', async t => {
    const f = await seedLegacy(t, {workspace: oldArchivedWorkspace});
    const first = await migrateFixture(f, '2026-10-09T00:00:00.000Z');
    const retry = await migrateFixture(f, '2026-10-10T00:00:00.000Z');
    assert.equal(retry.packageId, first.packageId);
    assert.equal(retry.purgeAt, '2026-10-12T00:00:00.000Z');
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/integration/package-migration.test.mjs`；预期 bootstrap 未定义或归属/期限断言失败。
- [ ] **3. 实现签名**：bootstrap 在严格 schema3 read 前读取旧格式，升级前管理备份→持久身份准备→完整转换/校验→原子主提交→消费旧入口。`migrateFixture(f, at)` 在本测试文件内调用 bootstrap 并返回旧归档包。有依据才归目标，模糊投递/事件存唯一待归属包；记录历史身份映射。无效归档日期只首次生成持久实例并显示不可确认；失败重试不重新 mint UUID/宽限。控制初始化异常保持维护状态。
- [ ] **4. 运行通过**：本任务与 `migration.test.mjs`；包含 V1/V2、新安装、断点重启、旧快照缺失、同 revision 内容冲突拒绝、无效日期及重复恢复案例。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: migrate legacy data into stable isolated packages"`。

### Task 4: 保存版本、自有简历及名称占用

**Files:** Modify `src/application/workspace-service.mjs`, `src/domain/version-names.mjs`, `version-references.mjs`, `workspace-management.mjs`, `tests/helpers/package-fixture.mjs`, `tests/integration/workspace-service.test.mjs`, `version-management.test.mjs`; Create `tests/integration/target-owned-profile.test.mjs`。

**Interfaces:** Consumes ownership/control；Produces `saveProfile(input): Promise<ProfileVersion>`、`saveTarget(input,{submissionInput?}={}): Promise<TargetVersion>`（返回含 packageId/Owner/自有 `profileSnapshot`）、`updateVersion({packageId, revisionId, versionName?, enabled?})`、`listProfiles/listTargets`、`getProfileRevision(id)/getTargetRevision(id)`。`profileSnapshot` 含原文、结构化画像、修正、导入元数据、provenance 与新的 Owner；runtime 不查源简历。

- [ ] **1. 写失败测试**：保存 retry 幂等、独立副本、同种规范化重名、跨种名称允许、回收占名、purge_pending 仍占名、高水位恢复后不复用：
  ```js
  test('target resume is independent of its source', async t => {
    const f = await packageFixture(t); const {sourceProfile, a, b} = await f.twoTargets();
    const wa = await f.workspaceService.getTargetRevision(a.targetRevisionId);
    const wb = await f.workspaceService.getTargetRevision(b.targetRevisionId);
    assert.notEqual(wa.profileSnapshot.recordId, wb.profileSnapshot.recordId);
    assert.equal(wa.profileSnapshot.ownerPackageId, a.packageId);
    assert.equal(wa.profileSnapshot.provenance.profileRevisionId, sourceProfile.revisionId);
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/integration/target-owned-profile.test.mjs`；预期副本/包身份不存在。
- [ ] **3. 实现签名**：保存时在同一事务原子校验名称与分配身份/版本号，target 完整复制源数据；新增默认空子集。仅名称/启停可原地管理，业务配置另建版本。以任务 1 的包状态替代“引用非零永久不可删”规则，但生命周期操作交任务 9。扩展 fixture `twoTargets()`。
- [ ] **4. 运行通过**：本任务与 workspace-service/version-management/version-names 测试；明确覆盖中文、NFKC、首尾空格、大小写、现有长度上限，失败不新增版本或消费重复提交。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: save targets with independent resume snapshots"`。

### Task 5: 岗位、投递、详情、导入导出均按包隔离

**Files:** Modify `src/application/job-service.mjs`, `import-service.mjs`, `export-service.mjs`, `src/server/routes-v2.mjs`, `tests/helpers/package-fixture.mjs`, `tests/integration/job-service.test.mjs`, `job-membership.test.mjs`, `job-redirects.test.mjs`; Create `tests/integration/package-business-scope.test.mjs`。

**Interfaces:** Produces `queryJobs(filters & ReadScope)`、`getJob(jobId, scope)`、`getApplication(applicationId, scope)`、`updateApplication(applicationId, patch, scope)`、`updateJobApplication(jobId, patch, scope)`、`linkJobs(id,other,scope)`、`unlinkJobs(id,other,scope)`；`ingestRecords({runId, records, observedAt, scope, provenanceOperationId?})`；import `import(input,{scope, operationLease?,signal?})`；export `export({format,filters,scope: ReadScope})` 保留 `{filename,contentType,body}`。同公开岗位生成不同包内 jobId/applicationId。

- [ ] **1. 写失败测试**：相同岗位 A/B 不同状态/备注/分数/观察；detail/history/export 无另一包记录；错包 ID、归档包读取/写入拒绝；全部汇总逐行 owner 且不能写：
  ```js
  test('same posting has independent applications', async t => {
    const f = await packageFixture(t); const {a,b} = await f.twoTargets();
    const ja = (await f.ingest(a, [job()]))[0], jb = (await f.ingest(b, [job()]))[0];
    await f.jobs.updateJobApplication(ja, {status:'applied', note:'合成备注A'}, a);
    assert.notEqual(ja, jb);
    assert.notEqual((await f.jobs.getJob(jb,b)).application?.status, 'applied');
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/integration/package-business-scope.test.mjs`；预期全局共享状态或缺 scope 接口失败。
- [ ] **3. 实现签名**：普通查询默认 active 包，全部目标带每行包/版本；summary 不挑跨包最新分数。投递新独立 ID，岗位 endpoint 只转入本包投递，简历绑定只能是自有 snapshot。API `/jobs/:id/application` 与 `/applications/:id` 使用显式 scope，后者 ID 为 applicationId；旧无范围仅唯一可验证时转换，否则 409。导入、导出、links、redirect 全部同包校验。
- [ ] **4. 运行通过**：本任务及 job-service/membership/redirects/api-v2 测试；保留原导出转义/分页及准确版本事实断言，增加来源/资格筛选同范围断言。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: isolate jobs applications and exports by package"`。

### Task 6: 运行、评价、快照、事件流与活动租约隔离

**Files:** Modify `src/application/run-service.mjs`, `evaluation-service.mjs`, `run-events.mjs`, `workspace-operations.mjs`, `src/server/routes-v2.mjs`, `tests/helpers/package-fixture.mjs`, `tests/integration/run-service.test.mjs`, `run-events.test.mjs`, `evaluation-facts.test.mjs`, `workspace-operations.test.mjs`; Create `tests/integration/package-run-scope.test.mjs`。

**Interfaces:** `startRun({scope,mode='rules',credentials={},operationLease?}): Promise<Run>`；`getRun(runId,scope): Promise<Run>`、`listRuns(filters & ReadScope): Promise<Run[]>`、`cancelRun(runId,scope): Promise<Run>`、`waitForRun(runId,scope): Promise<Run>`；`evaluate({scope,jobIds,mode,signal?,runId?,modelClient?,diagnosticContext?,operationLease?}): Promise<EvaluationResult>`；eventHub `publish(runId,type,payload,scope): Promise<void>`、`subscribe(runId,{scope,afterSeq?,onEvent,signal?}): Promise<() => void>`；gate `acquire(kind,{scope?,packageIds?,parentLease?,expectedWorkspaceRevision?,signal?})`、`withOperation(kind,options,action)`、`recover()` 保持返回租约方式，packageIds 覆盖资料库/待归属包操作，不用目标 Scope 伪装简历包。

- [ ] **1. 写失败测试**：删除源资料库后仍用自有 snapshot；A 任务/事件/取消不能以 B scope 操作；缓存包含 owner 且事实命中同 job；取消等待最后写入后才允许 archive：
  ```js
  test('run and event subscriptions reject another target', async t => {
    const f = await packageFixture(t); const {a,b} = await f.twoTargets();
    const run = await f.runs.startRun({scope:a});
    await assert.rejects(() => f.runs.getRun(run.runId,b), {code:'package_scope_mismatch'});
    await assert.rejects(() => f.eventHub.subscribe(run.runId,{scope:b,onEvent(){}}), {code:'package_scope_mismatch'});
    await f.runs.waitForRun(run.runId,a);
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/integration/package-run-scope.test.mjs`；预期遗漏包校验或源简历依赖断言失败。
- [ ] **3. 实现签名**：target snapshot 作为唯一运行画像；保持准确 run/version facts、规则资格及模型预算。存储/事件拥有稳定 Owner，归档后普通订阅拒绝且存量流结束。活动租约带 scope，取消过程不提前释放，维护 lease 仍不能改业务。API 写入 packageId+targetRevisionId；model Key 仅 AI/auto，从诊断剔除。
- [ ] **4. 运行通过**：本任务、run-service/events、evaluation-facts、workspace-operations、money-budget-wiring、diagnostics-boundaries；合成 provider/model，不访问公网。预算 10/0 元和 v4.1 配置不丢失。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: scope runs evaluations streams and operation leases"`。

### Task 7: 全版本去重逐包执行

**Files:** Modify `src/domain/job-duplicates.mjs`, `job-resolution.mjs`, `src/application/job-cleanup-service.mjs`, `src/server/routes-v2.mjs`, `tests/helpers/package-fixture.mjs`, `tests/integration/job-cleanup.test.mjs`; Create `tests/integration/package-dedup.test.mjs`。

**Interfaces:** cleanup `preview({packageIds?,allVersions=false}={}): Promise<DedupPreview>`；`apply({workspaceRevision,planHash,selectedGroupIds}): Promise<{packages: PackageDedupResult[], totals}>`。preview 分组含 packageId/archiveId/purgeAt；现有 groupId/planHash 保留，形成整项 revision 校验。Task 1 management access 仅在此专用接口允许未到期 trash 去重。

- [ ] **1. 写失败测试**：A 内三条归一、B 同岗位留存；人工状态冲突保护；disabled/未到期 trash 纳入、expired/pending 排除；preview 后再归档/到期则失效：
  ```js
  test('all-version dedup retains each owners records', async t => {
    const f = await packageFixture(t); const {a,b} = await f.twoTargets();
    await f.ingest(a, duplicatePostings(3)); await f.ingest(b,[job()]);
    const p = await f.cleanup.preview({allVersions:true}); await f.cleanup.apply(p);
    assert.equal((await f.jobs.queryJobs(a)).total,1);
    assert.equal((await f.jobs.queryJobs(b)).total,1);
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/integration/package-dedup.test.mjs`；预期跨包合并或 preview 缺包身份失败。
- [ ] **3. 实现签名**：复用保守公开 identity，在包内检查单位/岗位/城市/届别/批次/年份/类型/资格/正文冲突；确认 ID、具体详情 URL 或完整一致正文才合并。`duplicatePostings(n)` 在本测试文件生成确定重复 synthetic records。保留本包来源、观察、评价、投递事件及重定向；人工冲突不覆盖。提交重新检查未到期归档实例，无到期续期、副本跨包链接。
- [ ] **4. 运行通过**：本任务与现有 unit job-duplicates、integration job-cleanup/job-redirects；报告每包保留/合并/保护项及不明包独立计数。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: deduplicate jobs independently within every package"`。

### Task 8: 待归属旧记录唯一分配与持久转移

**Files:** Create `src/application/legacy-assignment-service.mjs`, `tests/integration/legacy-assignment.test.mjs`; Modify `src/server/routes-v2.mjs`, `tests/helpers/package-fixture.mjs`, `src/infrastructure/storage/package-control.mjs`。

**Interfaces:** assignment `list(): Promise<LegacyRecordSummary[]>`、`get(recordId): Promise<LegacyClosure>`、`preview({recordId,destination: Scope}): Promise<{workspaceRevision,planHash,recordIds,counts}>`、`move({recordId,destination,workspaceRevision,planHash}): Promise<{recordId,ownerPackageId,movedCounts}>`；所有转移保持原 recordId，主动复制的简历使用新 ID。

- [ ] **1. 写失败测试**：模糊记录不自动投到所有目标；不可分离事件/画像依赖拒绝；同记录并发分配只成功一次；转移原始身份留在 control：
  ```js
  test('assignment moves the whole closure without cloning events', async t => {
    const f = await assignmentFixture(t); const p = await f.assignment.preview({recordId:f.recordId,destination:f.a});
    await f.assignment.move({...p,recordId:f.recordId,destination:f.a});
    assert.equal((await f.assignment.list()).length,0);
    assert.equal((await f.repository.read()).applications[f.applicationId].recordId,f.recordId);
    assert.equal((await f.control.read()).ownershipTransfers[f.recordId].to,f.a.packageId);
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/integration/legacy-assignment.test.mjs`；预期服务缺失或唯一归属断言失败。
- [ ] **3. 实现签名**：先检查整个私有闭包能否完整迁移、目标 active 与自有画像关系；事务内写转移索引再提交业务 owner，失败续做不能复制。提供 GET `/legacy-records`、GET `/legacy-records/:recordId`、POST `/legacy-records/assignment-preview`、POST `/legacy-records/assign`。`assignmentFixture(t)` 在本测试文件组合 Task 3 seedLegacy 与 packageFixture，为一份旧投递生成带事件的待归属闭包。
- [ ] **4. 运行通过**：本任务、package-control/package-migration；验证待归属删除也整包、已分配记录仅一个可修改的归属，旧身份映射仍可过滤历史备份。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: assign legacy records through stable ownership transfers"`。

## 第二阶段：整包回收、可靠清理与备份恢复

### Task 9: 回收/恢复、状态矩阵与整个回收站清空预览

**Files:** Create `src/application/trash-service.mjs`, `tests/integration/trash-service.test.mjs`; Modify `src/application/workspace-service.mjs`, `src/server/routes-v2.mjs`, `tests/helpers/package-fixture.mjs`。

**Interfaces:** trash `archive({packageId,cancelActive=false}): Promise<Package>`、`restore({packageId,archiveId}): Promise<Package>`、`list({kind?,search?,sort?}={}): Promise<TrashRow[]>`、`get(packageId): Promise<TrashDetail>`、`preview({packageIds?,emptyAll=false,expiredOnly=false}): Promise<Preview>`、`validatePreview(tx, preview, now): Package[]`（锁内同步）；preview 必须明确选择一种范围，expiredOnly 仅供内部调度选择已到期 trashed 包，emptyAll 选择全部回收包，均不含 active。`TrashRow` 使用状态判别联合，pending 只给 operationId/安全计数，不返回正文/名称。工作区旧 lifecycle 方法转入此服务。

- [ ] **1. 写失败测试**：归档隐藏全部正常访问，恢复全子集并保持 enabled；重复归档不续期；busy 拒绝/取消等待；清空不受 kind/search 筛选且不含 active/disabled；preview 后新增包/恢复重归档拒绝：
  ```js
  test('restore rejects at exactly 72h even before sweep', async t => {
    const f = await packageFixture(t); const {a} = await f.twoTargets();
    const archived = await f.trash.archive({packageId:a.packageId});
    f.clock.advance(72*60*60*1000);
    await assert.rejects(() => f.trash.restore({packageId:a.packageId,archiveId:archived.archiveId}), {code:'package_expired'});
    assert.equal((await f.trash.list())[0].canReadBody,false);
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/integration/trash-service.test.mjs`；预期生命周期/边界保护缺失。
- [ ] **3. 实现签名**：归档实例/UTC 期限写 control+workspace；restore/preview 执行时重读并与归档实例比对。未到期 trash 只读展开、expired 仅管理元数据、pending 匿名任务、purged 无普通行。API GET `/trash`、GET `/trash/:packageId`、POST `/trash/archive`、`/trash/restore`、`/trash/preview`。取消并归档先等所属操作全部最后写入，失败维持 active。
- [ ] **4. 运行通过**：本任务及 package-business-scope/package-run-scope；时钟在期限前 1ms/恰好期限两侧，刷新预览与双点击测试通过。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: archive and restore complete version packages"`。

### Task 10: 持久永久清理与安全文件范围

**Files:** Create `src/application/purge-service.mjs`, `src/infrastructure/storage/purge-files.mjs`, `backup-filter.mjs`, `tests/integration/package-purge.test.mjs`; Modify `src/infrastructure/storage/package-control.mjs`, `repository.mjs`, `backup.mjs`, `src/server/routes-v2.mjs`, `tests/helpers/package-fixture.mjs`。

**Interfaces:** Consumes Task 3 `normalizeBackupOwnership`；purge `execute(preview: Preview,{reason:'manual'|'empty'|'expired',operationLease?}): Promise<PurgeResult>`、`resumePending({operationLease?}={}): Promise<PurgeResult>`、`getStatus(operationId): Promise<PurgeTaskView>`；TaskView `{operationId,phase,counts,nextRetryAt?,code?}`，匿名。`planPackageFiles({layout,workspace,control,packageId}): FilePlan`；`removeManagedFiles({layout,filePlan,fsAdapter}): Promise<FileResult>`；`filterBackup({workspace,snapshots,control,now}): {workspace,snapshots}`；`sanitizeManagedBackup({archivePath,control,operationLease}): Promise<BackupSanitizeResult>`（counts/完成或安全错误），作为调用者维护步骤不额外取同一锁。ledger 记录 packageId+全所属 recordIds+archiveId+匿名阶段，任务计划关联 file recordId。

- [ ] **1. 写失败测试**：在 intent/main/previous/snapshot/legacy/backup 清理节点逐个失败再重启；pending 不可访问/恢复、仍占名；所有文件完成前不报 completed；空候选无租约/revision 变化；路径穿越/符号链接拒绝：
  ```js
  test('file failure remains pending and resumes after restart', async t => {
    const f = await purgeFixture(t,{failPhase:'file_cleanup'});
    const r = await f.purge.execute(await f.trash.preview({emptyAll:true}),{reason:'empty'});
    assert.equal(r.completed.length,0); assert.equal(r.pending.length,1);
    await f.reopen(); const retry = await f.purge.resumePending();
    assert.equal(retry.completed.length,1); assert.equal((await f.trash.list()).length,0);
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/integration/package-purge.test.mjs`；预期不存在持久 purge 或错误地报告完成。
- [ ] **3. 实现签名**：同锁独占 lease→重新校验 preview/time/activity→持久 intent+recordIds→移除主正文保留名称管理项→清理文件→验证→purged 释放名；reason=expired 还须重新确认每包期限已到，不能当作 empty。各阶段幂等、失败重试不吞错、不创建删除前长期全备份；旧所属由转移索引识别，不能按全局正文 hash 擦除其他副本。管理备份先验证原 hash，再 normalize/filter 所属内容，重算正文/快照/manifest hash 后原子替换，保留其他包；此任务即完成净化，不能等恢复任务才补上。FilePlan 只认 layout 内已验证管理文件，realpath/lstat 检查目录祖先和符号链接；锁不嵌套。`purgeFixture` 在本测试文件创建含运行文件/上一版/旧文件/管理备份的合成回收包。API POST `/trash/purge`、`/trash/retry`、GET `/trash/operations/:operationId`。
- [ ] **4. 运行通过**：本任务、package-control/trash-service；每步重启结果一致，B 包所有字段/依据不变；损坏或不能证明归属的文件保持 pending 并给安全错误，不能宣称全删。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: purge package bodies and managed files with durable retries"`。

### Task 11: 备份净化、到期先裁决与恢复防复活

**Files:** Create `tests/integration/package-backup-restore.test.mjs`; Modify `src/infrastructure/storage/backup.mjs`, `backup-filter.mjs`, `purge-files.mjs`, `package-migration.mjs`, `tests/helpers/package-fixture.mjs`。

**Interfaces:** Consumes Task 10 `filterBackup/sanitizeManagedBackup`、Task 3 `normalizeBackupOwnership`；保留 `createBackup({repository,clock,workspaceSnapshot}): Promise<BackupResult>`、`validateBackupArchive(archive): ValidatedBackup`、`restoreBackup({repository,archivePath,operationLease}): Promise<RestoreResult>`，返回结构沿用当前 backup 模块。filter 匹配稳定 recordId、旧身份映射与转移，未知归属拒绝；manifest 校验原始输入先于修改。

- [ ] **1. 写失败测试**：恢复不能覆盖 control/high-water/name reservation/未到期本机归档；旧 V1/V2 映射重复可识别；先验证 hash，后过滤，快照从未先落盘；到期未 sweep 的旧 active 备份；移动后删除再恢复旧备份：
  ```js
  test('backup restore cannot reactivate expired local archive', async t => {
    const f = await backupFixture(t); const archivePath = await f.backupBeforeArchive();
    await f.trash.archive({packageId:f.a.packageId}); f.clock.advance(72*60*60*1000);
    await f.restore(archivePath); // 故意没有调用 scheduler
    assert.equal((await f.repository.read()).packages[f.a.packageId],undefined);
    assert.equal((await f.control.read()).deletionLedger[f.a.packageId].phase,'purged');
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/integration/package-backup-restore.test.mjs`；预期旧恢复先写 snapshots/覆盖归档的断言失败。
- [ ] **3. 实现签名**：restore 在同一独占操作内先查当前+control 期限，登记并续做清理（向 purge 传入现有 operationLease，不重新申请独占租约或嵌套存储锁；未完成阻止恢复，不撤销名占用），然后 normalizeBackupOwnership/filterBackup、校验依赖、准备全部干净 snapshots/主 JSON 后落盘。备份带来的身份准备与高水位也先持久 commitControl，主提交失败复用，不回退。已有未到期归档实例以本机为准，仅 trash.restore 可取消。复用已完成的管理备份净化；损坏/不明输入明确拒绝。`backupFixture(t)` 在本测试文件构造合成备份/restore 助手，并将 Task 8 fixture 的种子内容抽取到 tests/helpers/package-fixture.mjs，禁止跨测试文件 import，验证 Review Focus 3 与相同正文独立副本。
- [ ] **4. 运行通过**：本任务及 migration-recovery/package-purge/legacy-assignment；覆盖坏 hash、backup_replace 失败、旧归档重复恢复不续期、控制丢失恢复拒绝、删除名称可重用但 UUID/版本不重用。外部备份不物理改写，但本机恢复必须过滤。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: prevent deleted and expired records from returning through backups"`。

### Task 12: 启动补清理、调度关闭与 V1/CLI 边界

**Files:** Create `src/application/trash-scheduler.mjs`, `tests/integration/package-startup.test.mjs`; Modify `src/application/context.mjs`, `src/infrastructure/storage/recovery.mjs`, `migrate-v1.mjs`, `upgrade-workspace.mjs`, `src/server/routes-v1.mjs`, `routes-v2.mjs`, `src/pipeline.mjs`, `store.mjs`, `cli.mjs`, `src/server.mjs`, `tests/helpers/api-fixture.mjs`, `tests/integration/api-v1-compat.test.mjs`, `cli-compat.test.mjs`。

**Interfaces:** `createTrashScheduler({trash,purge,clock,timers,diagnostics})` → `{start(): void, sweep(): Promise<PurgeResult>, stop(): Promise<void>}`；context 暴露 `trashService,purgeService,assignmentService` 与 `close(): Promise<void>`。`recoverWorkspace(repository,{operationGate})` 完成后才 `resumePending/sweep`；业务启动 ready 等待控制/迁移/恢复完成。兼容统一 `resolveLegacyScope(input,workspace): Scope`，不能唯一确定则抛 version_scope_required。

- [ ] **1. 写失败测试**：关闭三天后启动补清、死亡 lease 先恢复、未到期回收包不被 sweep 删除、其他包活动任务延期、无候选不改 revision、timer 每 300000ms；V1 旧文件/CLI/export/details 均不能读回删除正文：
  ```js
  test('startup recovers dead operations before expired purge', async t => {
    const f = await startupFixture(t); await f.reopen();
    assert.deepEqual(f.order.slice(0,3),['bootstrap','recoverOperations','resumePurge']);
    assert.equal((await f.trash.list()).length,0);
    await f.scheduler.stop(); assert.equal(f.timers.activeCount,0);
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/integration/package-startup.test.mjs`；预期新 startup/scheduler 不存在或旧入口绕过控制。
- [ ] **3. 实现签名**：统一 bootstrap→operation recovery→中断运行恢复→pending purge→到期 sweep→服务 ready；初始化控制异常只允许 health/白名单诊断/维护提示。sweep 只执行 `trash.preview({expiredOnly:true})` 与 reason=expired，不调用 emptyAll；五分钟 timer 可注入且不重叠。停止新批次、等待当前提交，强退靠持久 task。V1/store/pipeline loadRun/list/tracking/delete 全部经过 scope+ledger，停止旧已消费文件 fallback；不支持的旧个人业务明确拒绝。`startupFixture` 在测试文件提供记录顺序和手动 timers；api fixture 注入 clock/model，结束先 context.close/server close/diagnostics drain 再删目录。
- [ ] **4. 运行通过**：本任务、recovery/workspace-operations/api-v1-compat/cli-compat/api-v2；既有认证、请求限制、来源适配/诊断也不绕过。阶段一/二完成后跑 `node tools/test-v2.mjs` 全套，修复实际失败再开始界面接入。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: recover trash cleanup at startup and guard legacy entrypoints"`。

## 第三阶段：shadcn 九页界面

### Task 13: 可构建 shell、真实组件与 React 测试入口

**Files:** Create `ui/index.html`, `ui/vite.config.ts`, `ui/tsconfig.json`, `ui/components.json`, `ui/src/main.tsx`, `ui/src/styles.css`, `ui/src/app/App.tsx`, `router.ts`, `VersionContext.tsx`, `ui/src/lib/api.ts`, `types.ts`, `desktop.ts`, `ui/src/components/FormFeedback.tsx`, `OperationFeedback.tsx`, `TargetPicker.tsx`, `ui/src/components/ui/`（CLI 生成）, `tests/helpers/react-dom.mjs`, `react-fixture.tsx`, `tools/test-ui.mjs`, `tools/build-ui.mjs`, `tests/ui/shell.test.tsx`, `tests/ui/feedback.test.tsx`, `design-system/MASTER.md`; Modify `package.json`, `package-lock.json`, `src/server.mjs`, `tests/integration/ui-shell.test.mjs`, `tests/unit/ui-state.test.mjs`, `static-payload.test.mjs`。

**Interfaces:** `parseRoute(hash): RouteState`、`buildHash(route): string`；RouteState 为 `{page: 九个页面名之一, selection: ReadScope|null, filters: Record<string,string>}`。`VersionProvider({api,children})`、`useVersionContext(): {scope: Scope|null,allTargets:boolean,select(selection: ReadScope|null):void,generation:number}` 区分明确版本/全部只读/未选择；`createApiClient(options): ApiClient` 保留现有 request/events 错误/断流/诊断语义；`createDesktopAdapter(bridge?): DesktopAdapter`；`FormFeedback({errors,onFocusField})`、`OperationFeedback({result,busy})`。React fixture `renderApp(t,{apiHandler,route?,desktopBridge?})` 返回 `{screen,user,apiCalls,selectTarget,unmount}`，每次 use cleanup/act；`syntheticApi(path,options)` 同文件提供九页初始合成响应，apiCalls 每条记 `{path, options, body?, scope?}`。将 ApiClient/DesktopAdapter 的 TS 结构按保留纯模块导出及此处类型定义逐项写入 types.ts，不用 any 绕过 scope。

- [ ] **1. 核实并锁定前端/测试依赖**：使用官方 engines/doc 和 shadcn CLI 核对 React、Vite、Tailwind、Base UI、tsx、jsdom、RTL 与 user-event 在 Node 20.20.2 上兼容，记录锁定版本与实际 components.json，不使用未验证 preset。
- [ ] **2. 建立可执行测试运行器**：实现 `tools/test-ui.mjs --file`，以 `node --import ./tests/helpers/network-guard.mjs --import tsx --import ./tests/helpers/react-dom.mjs --test <validated file>` 独立子进程执行；jsdom globals 先于 React DOM 加载，显式 RTL cleanup。只发现 tests/ui 下 test.tsx，保持路径校验/临时目录/stdio inherit；加载器成功的空 smoke 用于区分 harness 错误与功能 RED。
- [ ] **3. 写失败测试**：九页三分组、Hash 刷新/返回、空/汇总只读、切换旧 response/stream 拒收、Toast 只在提交后显示、字段错误 summary 焦点和 Portal 可查：
  ```tsx
  test('shell exposes nine named destinations and preserves target scope', async t => {
    const f = await renderApp(t,{apiHandler:syntheticApi,route:'#/jobs?packageId=A&targetRevisionId=t1%401'});
    assert.equal(f.screen.getAllByRole('link',{name:/工作台|岗位库|投递进度|简历管理|求职目标|招聘来源|运行日志|回收站|设置/}).length,9);
    assert.equal(f.screen.getByRole('combobox',{name:'当前目标'}).textContent?.includes('合成目标A'),true);
  });
  ```
- [ ] **4. 运行失败**：`node tools/test-ui.mjs --file tests/ui/shell.test.tsx`；预期缺 App/导航断言失败，不能把 loader 配置失败当功能 RED。
- [ ] **5. 实现上述 shell/feedback 接口及构建**：通过实际 `shadcn info/docs/search` 和官方 registry 初始化 Base UI+Lucide，组件依类型使用，Base Toast 不混用 Sonner，Select/ToggleGroup 不混用 Radix props。主题逐项采用设计 token，记录 MASTER 而不直接保存营销落地页推荐。保留共享 API/validation/diagnostic 纯模块；AbortController+generation 同时防迟到。`tools/build-ui.mjs` 导出 `buildUi(): Promise<void>`，先 typecheck 后 Vite，仅写 public/app。服务器根入口/已支持旧路径 302/资源 404，缺 bundle 明确启动错误，保持原 CSP；生产验证定位组件后采用最小兼容配置。每页临时 Empty 可导航，后续任务填入功能。
- [ ] **6. 运行通过**：shell/feedback TSX 与 static-payload/ui-state 测试，`npm run build:ui`（新增脚本）通过；生成入口无内联 JS/CDN，base=/app/，未知资源 404、`/jobs` 重定向 `/#/jobs`，登录与共享模块仍可读。DOM 不替代真实窗口几何/CSP 验收。
- [ ] **7. 提交**：暂存本任务 Files，`git commit -m "feat: build a shadcn workbench shell with scoped navigation"`。

### Task 14: 简历导入与目标创建两页

**Files:** Create `ui/src/features/profiles/ProfilesPage.tsx`, `ImportProfileDialog.tsx`, `ui/src/features/targets/TargetsPage.tsx`, `CreateTargetDialog.tsx`, `TargetDetailsSheet.tsx`, `ui/src/components/VersionActions.tsx`, `tests/ui/profiles.test.tsx`, `targets.test.tsx`; Modify `ui/src/app/App.tsx` 及映射到这两页的旧测试。

**Interfaces:** 页面均接收 `{api: ApiClient}`；`VersionActions({version,onChanged})` 仅传精准 packageId/versionId；目标创建 payload 保留现有偏好/来源/预算及 submissionId，保存后服务器返回完整新包再选中；查看自有简历不去读取 sourceProfileId。

- [ ] **1. 写失败测试**：上传/粘贴→校正→命名，失败保留草稿；目标选择简历→偏好→来源预算→摘要；重名字段错误、重试仅保存一次、rename/enable/archive 每次成功反馈：
  ```tsx
  test('duplicate name keeps creation draft and focuses the field', async t => {
    const f = await renderApp(t,{apiHandler:duplicateNameApi,route:'#/targets'});
    await openAndFillTarget(f,{name:' 消防目标 ',keyword:'合成岗位偏好'}); await f.user.click(f.screen.getByRole('button',{name:'保存目标'}));
    assert.match(f.screen.getByRole('alert').textContent!,/名称/);
    assert.equal((f.screen.getByLabelText('版本名称') as HTMLInputElement).value,' 消防目标 ');
    assert.equal(f.screen.queryByText('目标已保存'),null);
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-ui.mjs --file tests/ui/targets.test.tsx`、`profiles.test.tsx`；预期缺页面/表单或错误反馈断言失败。
- [ ] **3. 实现签名**：复用 FieldGroup/Field/FieldError、Dialog、Sheet、DropdownMenu；busy 阻止重复，失败 inline+可跳 summary，保存成功 toast。源简历移入回收站提示“已保存目标中的独立副本保持可用”，计数只算其包。目标管理不覆盖旧配置。`openAndFillTarget` 和 `duplicateNameApi` 在本测试文件定义，不导入真实简历/关键词。
- [ ] **4. 运行通过**：本任务及迁移的 profiles/profile-validation/version-management/record-validation 行为测试；明确保留个人校正优先、文件类型/大小/提取错误以及名称 Unicode 边界断言。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: separate resume import and target preparation workflows"`。

### Task 15: 工作台、岗位库与投递进度三页

**Files:** Create `ui/src/features/workbench/WorkbenchPage.tsx`, `RunOptions.tsx`, `ui/src/features/jobs/JobsPage.tsx`, `JobDetailsSheet.tsx`, `JobFilters.tsx`, `ui/src/features/applications/ApplicationsPage.tsx`, `ApplicationEditor.tsx`, `tests/ui/workbench.test.tsx`, `jobs.test.tsx`, `applications.test.tsx`; Modify `ui/src/app/App.tsx` 及相关旧 UI 测试。

**Interfaces:** 页面 `{api}` 消费统一 context Scope/ReadScope；`JobDetailsSheet({jobId,scope,onClose})`、`ApplicationEditor({applicationId,scope,onSaved})`；工作台只在明确 scope 下发起更新/评价/取消，取消进度等最终服务结果。

- [ ] **1. 写失败测试**：首次准备三步、运行阶段/计数/结果故障链接；25/50/100 页、250ms 搜索取消、高级筛选来源名；两版本同岗位独立投递、summary 无编辑，长中文 cards/Sheet 信息一致：
  ```tsx
  test('late results cannot overwrite a newly selected version', async t => {
    const f = await renderApp(t,{apiHandler:deferredJobsApi,route:'#/jobs'});
    await f.selectTarget(a); await f.selectTarget(b); resolveOldA();
    await waitFor(() => assert.equal(f.screen.queryByText('A的岗位'),null));
    assert.equal(f.screen.getByText('B的岗位').textContent,'B的岗位');
    assert.equal(f.apiCalls.at(-1).scope.packageId,b.packageId);
  });
  ```
- [ ] **2. 运行失败**：上述三 TSX 单文件命令；预期新页面未实现或 scope 竞态断言失败。
- [ ] **3. 实现签名**：工作台单主要操作与规则/模型选项；规则模式不取/发 Key，模型使用临时输入/固定桥接。岗位 Table/移动 Card 展示设计列，Sheet 仅本包事实与评价。投递 ToggleGroup 看板/列表、侧栏编辑且有按钮/键盘状态变更，不依赖拖动。查询在 debounce 后 abort+generation 守卫；本测试文件提供 deferredJobsApi/resolveOldA 及合成 a/b。
- [ ] **4. 运行通过**：三文件及迁移的 workbench/run-limits/jobs/applications/review/job-cleanup UI 覆盖；cancel、断流重连、分页 total、exact targetRevisionId 与 toast 后刷新保持。移动几何交任务 19。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: simplify daily search job review and application tracking"`。

### Task 16: 来源、日志、设置与旧数据维护三页

**Files:** Create `ui/src/features/sources/SourcesPage.tsx`, `SiteDialog.tsx`, `ui/src/features/logs/LogsPage.tsx`, `DiagnosticDetails.tsx`, `ui/src/features/settings/SettingsPage.tsx`, `LegacyAssignmentPanel.tsx`, `DedupDialog.tsx`, `tests/ui/sources.test.tsx`, `logs.test.tsx`, `settings.test.tsx`; Modify `ui/src/app/App.tsx` 及相关旧 UI 测试。

**Interfaces:** 页面 `{api}`；`LegacyAssignmentPanel({api,onChanged})` 用 assignment preview/move；`DedupDialog({api,allVersions,onCompleted})` 用管理 preview/apply；日志 business tab 消费 ReadScope，system tab 只读白名单诊断。目录/Key 经 Task 13 desktop adapter。

- [ ] **1. 写失败测试**：来源新增/启停/保存保留失败草稿与诊断链接；日志只含当前版本历史而 system 无个人字段；设置 v4.1/10/0 元、无 Key 规则模式、备份操作/目录错误；待归属只能选一个目标，全版本去重包括未到期 trash：
  ```tsx
  test('settings retains yuan budget and explains failed source update', async t => {
    const f = await renderApp(t,{apiHandler:settingsApi,route:'#/settings'});
    assert.equal((f.screen.getByLabelText('每任务模型费用上限（元）') as HTMLInputElement).value,'10');
    assert.equal((f.screen.getByLabelText('模型名称') as HTMLInputElement).value,'deepseek-flash');
    await saveBudget(f,-1); assert.equal(f.screen.queryByText('设置已保存'),null);
    assert.match(f.screen.getByRole('alert').textContent!,/费用|预算|0.*10/);
  });
  test('zero yuan is saved and disables model calls', async t => {
    const f = await renderApp(t,{apiHandler:settingsApi,route:'#/settings'});
    await saveBudget(f,0);
    assert.ok(f.apiCalls.find(c=>c.body?.budgets?.maxCostCny===0));
    assert.ok(await f.screen.findByText('设置已保存'));
  });
  ```
- [ ] **2. 运行失败**：sources/logs/settings TSX 单文件命令；预期新页未实现或单位/范围断言失败。
- [ ] **3. 实现签名**：来源独立页显示状态/最近成功失败与 probe 反馈；日志 tabs 业务/系统，safe counts/errorId 可筛选导出。设置 tabs 模型预算/数据备份/版本维护；备份失败不声称恢复完成，所有版本清理有逐包报告。旧记录完整查看→唯一目标预览→移动，不显示虚假“所有版本已投递”。测试文件提供 settingsApi/saveBudget 合成助手。
- [ ] **4. 运行通过**：新三页及迁移 settings/settings-validation/model-money/diagnostics/run-limits/job-cleanup/form-feedback 覆盖；system 日志和错误中个人路径/关键词/Key 哨兵不存在，清理报告冲突项清晰。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: separate sources logs and workspace maintenance pages"`。

### Task 17: 回收站页面与准确逐项结果

**Files:** Create `ui/src/features/trash/TrashPage.tsx`, `TrashDetailsSheet.tsx`, `PurgeConfirmDialog.tsx`, `tests/ui/trash.test.tsx`; Modify `ui/src/app/App.tsx`, `VersionContext.tsx`, `VersionActions.tsx`, `OperationFeedback.tsx`（所在路径见文件职责）。

**Interfaces:** `TrashPage({api})`、`TrashDetailsSheet({packageId,onClose})`、`PurgeConfirmDialog({preview,onConfirm,onCancel})`；confirm 原样传 Preview，不按当前筛选重新推导范围。pending poll 使用 operationId，只在任务活动时进行并在 unmount/切换取消。

- [ ] **1. 写失败测试**：全部/目标/简历/待归属、时间/搜索，未到期详情与恢复、expired 禁正文/恢复、pending 匿名重试、清空整个回收站准确计数、取消不执行、双点击只一次、旧 preview 409 刷新要求：
  ```tsx
  test('empty confirmation includes all trash despite the current filter', async t => {
    const f = await renderApp(t,{apiHandler:trashApi,route:'#/trash'});
    await f.user.click(f.screen.getByRole('tab',{name:'简历版本'}));
    await f.user.click(f.screen.getByRole('button',{name:'清空整个回收站'}));
    assert.match(f.screen.getByRole('alertdialog').textContent!,/3 个版本/);
    await f.user.click(f.screen.getByRole('button',{name:'取消'}));
    assert.equal(f.apiCalls.filter(c=>c.path==='/trash/purge').length,0);
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-ui.mjs --file tests/ui/trash.test.tsx`；预期页面/状态判别不存在。
- [ ] **3. 实现签名**：按服务状态矩阵渲染，不从缓存渲染 expired/pending 正文；confirmed manual/empty 用同一 purge 接口。提示精确区分已回收/已恢复/清理待重试/永久删除完成；失败提供诊断与 retry，名字不能提前释放。当前目标归档即清 scope、终止请求/流；恢复不自动启动任务。AlertDialog 说明整包与子数量并保证焦点；trashApi 在测试文件给跨种三包合成数据。
- [ ] **4. 运行通过**：本任务、shell/targets/settings UI；经过 72h 重新读取 state 无恢复按钮，partial result 显示 completed/pending/failed 各自结果，已 purged 行消失且侧栏数量刷新。
- [ ] **5. 提交**：暂存本任务 Files，`git commit -m "feat: add a complete recycle-bin management interface"`。

## 第四阶段：统一构建、真实 EXE 与交付

### Task 18: CI、Docker、桌面包与旧前端收口

**Files:** Modify `tools/run-all-tests.mjs`, `tools/build-ui.mjs`, `tools/build-desktop.mjs`, `tools/verify-package.mjs`, `tools/test-deploy-assets.mjs`, `tools/test-desktop.mjs`, `.github/workflows/ci.yml`, `Dockerfile`, `.dockerignore`, `.gitignore`, `package.json`, `package-lock.json`; Create `tests/integration/ui-build-assets.test.mjs`；删除已由新测试覆盖的旧业务渲染模块，保留登录和后端共享纯模块。

**Interfaces:** `buildUi(): Promise<void>` 接入 build/test/dist；npm scripts 新增 `build:ui`、`test:ui`、`typecheck:ui`。offline runner 顺序为前端 build/typecheck→旧离线工具→后端 tests→React tests；失败非零。verify-package 检查 index 引用的真实 bundle/chunk/CSS 和生产依赖闭包，而非旧页面 JS 名单。

- [ ] **1. 写失败测试**：缺 app 资源、未知资源 404、supported old path 到 root hash、login/shared module 保留、构建不清 public 兄弟文件、包排除 data/control/cache/logs/credentials/tests：
  ```js
  test('app build preserves backend validation and serves only real assets', async t => {
    const f = await apiFixture(t,{authRequired:true}); const root = await f.callAuthenticated('/');
    assert.match(root.text,/\/app\/assets\//);
    assert.equal((await f.call('/app/assets/missing.js')).response.status,404);
    assert.equal((await f.call('/login')).response.status,200);
    assert.ok(await fs.stat('public/js/validation-rules.js'));
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/integration/ui-build-assets.test.mjs` 与当前 package/deploy 断言；预期旧入口/bundle 检查不匹配。本任务扩展 `apiFixture(t,{authRequired:true})` 与 `callAuthenticated`，使用合成账号/session 保留生产认证行为，不能将 login 断言改为 auth none 模式凑通过。
- [ ] **3. 接入构建与验证**：Docker 增 builder（dev deps+UI build）后复制生成产物到生产层，调整 .dockerignore 使 builder 有 tools/ui 输入但运行层无私有数据。CI Node 固定兼容 20.20.2，npm ci ignore-scripts 后离线 build/test；Electron 打包先 build 并检查 bundle，复用 prodClosure 不重写。按照下表移植旧 UI 行为断言后再移除旧 renderer；不再向外提供绕过新包范围的旧业务页。
- [ ] **4. 运行通过**：`npm run test:offline`、`npm run build:ui`、`node tools/test-deploy-assets.mjs`、`node tools/test-desktop.mjs`、`node tools/build-desktop.mjs`、`node tools/verify-package.mjs` 逐一 exit 0。若本机有 Docker，再构建/启动合成卷 smoke；无 Docker 明确记录未运行，不宣称镜像实测。每个失败先按 systematic-debugging 定位，充分验证后停止无关扩测。
- [ ] **5. 提交**：暂存本任务 Files 与已迁移旧测试，`git commit -m "build: ship one frontend across offline CI Docker and Electron"`。

### Task 19: 真实 EXE 隔离自测、界面验收及说明

**Files:** Create `electron/self-test.mjs`, `electron/self-test-network.mjs`, `tests/unit/desktop-self-test-isolation.test.mjs`, `docs/UI-ACCEPTANCE.md`; Modify `electron/main.mjs`, `tests/unit/desktop-bridge.test.mjs`, `desktop-directories.test.mjs`, `tools/test-desktop.mjs`, `tools/verify-package.mjs`, `README.md`。

**Interfaces:** `prepareSelfTestEnvironment({explicitDataDir?,tempRoot}): {dataDir,cfg,dependencies,cleanup}` 强制合成配置，无用户 fallback；`installSelfTestNetworkGuard({session,allowedOrigin}): {dispose}` 同时阻断 Node/Chromium 出站；`runWorkspaceSelfTest({window,context,clock,dataDir}): Promise<SelfTestReport>`。仅 `--self-test` 主进程可用时钟注入/合成服务，不新增生产测试 IPC，不 import 打包排除的 tests/helpers。

- [ ] **1. 写失败测试**：selftest 未传 RJR_DATA_DIR 自动独立临时业务目录、显式目录必须测试目录且拒绝已含日常数据、env/配置/credentials 不能回落；Node fetch/http/https/net/tls 与 renderer HTTP/WS 都禁止外部来源：
  ```js
  test('self-test isolation is established before configuration and credentials', async t => {
    const isolatedTmp = await createTempDir(t), realDataSentinel = path.join(isolatedTmp,'forbidden-daily-data');
    const env = prepareSelfTestEnvironment({tempRoot:isolatedTmp});
    assert.notEqual(env.dataDir,realDataSentinel);
    assert.equal(env.cfg.deepseek.apiKey,'');
    assert.equal(env.dependencies.catalog.every(site=>site.providerId.startsWith('synthetic')),true);
    await assert.rejects(()=>env.dependencies.requestFactory()('https://external.invalid'),/offline_network_forbidden/);
  });
  ```
- [ ] **2. 运行失败**：`node tools/test-v2.mjs --file tests/unit/desktop-self-test-isolation.test.mjs`；预期缺 selftest 环境 API，或当前业务目录回落保护断言失败。
- [ ] **3. 实现签名并更新真实窗口自测**：在 loadConfig/server/credential 初始化前确定临时业务目录；registry/catalog/request/model/clock 全部合成注入，session.webRequest 只允许实际 localhost origin（本地 UI data/blob 按现有必要功能验证），外链打开仅记录 intent 不访问。主进程时钟推进并调用 purge，生产桥接 sender pathname 仍 `/`。实际点击九页、导入/创建/启停/重命名、更新/评分/取消、切换、投递、逐包去重、归档/恢复/清空/到期；源简历删除后目标仍可跑。检查 CSP violation/console/error，合成 Key save/status/delete 和安全目录桥接；Dialog/Sheet 焦点、Esc、错误 summary、长中文与 375/768/1024/1440 截图。在独立 EXE 进程分别以 `--force-device-scale-factor=1.25`、`1.5` 验证 Windows 渲染比例，另测字体放大；不修改用户系统缩放，不把 jsdom 尺寸断言当 DPI 实测。UI 成功须由提交结果验证，不能只检查按钮存在。
- [ ] **4. 运行通过并写证据**：重新构建后用隐藏 `Start-Process -WindowStyle Hidden` 启动新 `dist/简历岗位雷达-win32-x64/简历岗位雷达.exe --self-test`，限制等待单次不超过 60 秒，读取指定临时 report+截图；检查全部断言通过、外部请求为 0、包验证通过。有程序占用则先完成其他检查，再提示具体占用进程，不能强杀用户工作。执行 verification-before-completion 与一次独立全分支代码审查，修复有效问题后只重测具体风险及必需发布门槛。README 说明九页流程、版本副本隔离、三天/离线补清理、清空范围、待重试/维护、外部备份边界与新 EXE 位置。
- [ ] **5. 提交**：暂存本任务 Files 与验收文档，`git commit -m "test: verify isolated desktop package lifecycle and new interface"`；按既有 PR 更新授权推送/更新已附 PR，附具体离线与 EXE 证据，不能用旧 494/41 结果代替本次验证。

## 既有 UI 测试的迁移对应

以下旧 `.test.mjs` 含用户行为回归，逐条移植到 `tests/ui/` 并在提交说明注明对应；纯 validation/API/state 断言可以继续留 mjs。不能一删了之或只检查静态 JSX 字串。

| 旧测试（`tests/integration/` 下） | 接收文件 / 必保留行为 |
|---|---|
| `ui-shell`, `ui-state`（后者在 unit） | shell：导航、Hash、context、清空选择/备份后 store 重置 |
| `ui-profiles`, `ui-profile-validation`, `ui-record-validation`, `ui-version-management` | profiles/targets：校正、版本名称、禁重复、准确旧版本管理、失败草稿、归档后 availability |
| `ui-workbench`, `ui-run-limits`, `ui-model-money` | workbench/settings：临时 Key 清除、金额元/0 校验、阶段计数/覆盖提示、取消/断流 |
| `ui-jobs`, `ui-applications`, `ui-review` | jobs/applications：筛选、准确事实、评价、投递、summary 无写入、请求竞态 |
| `ui-job-cleanup` | settings/jobs：预览、冲突保护、旧 preview 失效、逐包结果 |
| `ui-settings`, `ui-settings-validation`, `ui-diagnostics`, `form-feedback` | sources/logs/settings/feedback：错误 summary、保存成功、来源错误、诊断导出白名单、bridge |

## 设计覆盖与交付门槛

| 设计节 | 任务 |
|---|---|
| 1–2 用户目标与选定架构 | 1–19；统一发布边界 |
| 3 九页导航/上下文/各页操作 | 13–17、19 |
| 4 token/组件/无障碍/反馈 | 13–17、19 |
| 5 包所有权/接口/源简历副本 | 1–6、8、12 |
| 6 全版本逐包去重 | 7、16、19 |
| 7 整包回收/72h/预览/活动任务 | 9–10、12、17 |
| 8 控制/文件/备份/恢复边界 | 2、10–12、18 |
| 9 旧迁移与一次宽限 | 3、8、11–12 |
| 10 构建/根路径/CSP/EXE | 13、18–19 |
| 11 错误与 13 项验收 | 1–19；故障、隔离、恢复、UI 与真实包均有测试 |
| 12 统一交付 | 阶段间只内部提交，最后通过 gate 再发布 |

最终证据必须包括：本次完整离线结果、前端 typecheck/build、包检查、真实新 EXE report、关键截图、已迁移测试映射和已知限制。自动源探针和真实模型不属于这次门槛。不得运行对用户所有版本的真实清理来“验收”；用户数据只由正常升级迁移流程处理，破坏性测试全在合成目录。

## 计划自审与审阅状态

本计划由主执行者 inline 自审：逐节映射设计、检查单步可执行性、核对 scope/身份/事务/预览接口命名、将五项 Review Focus 绑定到测试，并检查文档比例。子代理仅提供现有文件和工具接口的只读定位，没有代替计划自审。

已明确补入容易遗漏的入口：V1/CLI/旧快照、pending 名称占用、恢复前到期裁决、移动记录的旧备份身份、初始化控制丢失、Docker builder、React Portal globals、真实 EXE 双层网络 guard。自审修正管理备份净化的依赖（归入永久删除任务）、恢复复用父租约、全部目标/未选择的区分，以及预算 0 元应可保存且禁用调用；保留现有每任务预算和实际 model 标识。未安排与需求无关的模型调用或真实数据删除。

**实施状态：用户已批准，十九项任务的专项完成门槛均通过。** 本次完整离线为后端 623/623、React 70/70；最终新 EXE 在 100%、125%、150% 三个独立进程各 57/57、退出码 0。原计划的复选步骤保留供对照，逐项成功命令与实施偏差记录见 [实施决策](../../IMPLEMENTATION-DECISIONS.md)，实际包、截图、测试迁移边界及 Docker 环境限制见 [验收报告](../../UI-ACCEPTANCE.md)。现有 PR 更新与最终交付状态以验收报告为准。完成后保持电脑开机。
