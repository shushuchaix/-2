# 实施决策与审查记录

对应已批准的设计和十九项实施计划：2026-10-09 UI、版本隔离和回收站。

## 已确认的实施边界

- 求职目标保存完整独立简历副本；来源信息只用于追溯。
- 岗位、评价、检索、投递和事件严格属于一个数据包；全版本去重逐包执行。
- 归档整包；72 小时到期，由五分钟检查或下次启动补清。
- 删除和转移控制登记持久保留；管理备份会过滤已永久删除记录。
- 全部测试采用合成临时数据；禁止外部请求和真实模型费用。
- 用户已取消完成后关机；交付后保持电脑开机。

## 实施决策

以下记录保留执行时的理由和风险；阶段性测试数字是当时证据，最终数字以 UI-ACCEPTANCE.md 为准。

- Task 1: Ruling: activate strict schema3 default only with completed service wiring in Task12; add explicit schema3 constructor/validator now while internal legacy schema2 path remains available — intermediate commits must retain a testable running application, and spec forbids publishing a mixed release — cost if wrong: temporary compatibility code could bypass ownership if not removed at activation; Task12 and final compatibility tests must prohibit that.
- Task 2: Ruling: shared-lock reads expose the cancellation monitor shutdown race; bring forward its Task6 drain fix, backed by a deterministic stalled-read regression — clearing an interval does not await its in-flight async callback — cost if wrong: final writes/temporary directory teardown can race.
- Execution: Ruling: developer proactive multi-agent direction takes precedence over the inline skill's no-implementer-subagent rule for the independent frontend phase; delegate Tasks13–17 as one continuous feature unit with fixed contracts, keep backend and final integration here — reduces prolonged serial migration work — cost if wrong: API/UI interface drift; final real-API and EXE tests remain required.
- Task 2: Ruling: extend Windows lock acquisition/release to bounded sharing-error retries, and close security test HTTP/startup/diagnostic resources before deleting its temporary directory; observed EPERM lock failure and ENOTEMPTY teardown in full regression, backed by RED/GREEN tests. Full offline final exit0, 508/508 tests, 17 tools pass, 7 explicit skips (.cache/ui-isolation-task2-final.log).
- Task 4: Ruling: isolate schema3 version implementation in package-version-service.mjs and delegate through existing factory, keeping explicit legacy2 adapter until Task12 activation; avoids mixing old shared-reference lifecycle with owned versions. Lifecycle delegates to Task9 trashService and is not published until that service is wired.
- Task 9: Ruling: own resume copies need independent revision IDs as well as stable recordIds to enforce legacy resumeRevisionId application binding. Task5 integration exposed source/copy ambiguity; added RED/GREEN assertion and assigned copy-<packageUUID>@1 in save/migration, provenance retains original source revision. Added trash-routes.mjs to keep main router concise; exact public contracts unchanged.
- Task 6/10: Ruling: prepare snapshot-root and snapshot-file UUIDs durably before writing immutable files, and include crash-orphan files in the purge intent before deleting them — interruption testing proved a successful file write followed by a failed main commit otherwise leaves private bodies untracked — cost if wrong: unregistered snapshot deletion must remain pending rather than guess ownership.
- Task 10/11: Ruling: apply authoritative ownership transfers before deletion filters in both managed backup sanitation and restore — deleting old owner L must preserve records moved to A, while deleting A must filter their old L backups — cost if wrong: cross-package data loss or resurrection.
- Task 10: Ruling: retain a hashed name reservation through filesystem verification and the final control commit — a main-package removal followed by control failure is still a pending deletion — cost if wrong: a name remains occupied until cleanup can be verified.
- Task 12: Ruling: enable schema3 strictly for production after bootstrap, retaining schema2 only in explicit internal compatibility fixtures — publishing a mixed global/personal ownership model would bypass isolation — cost if wrong: old software cannot safely open an upgraded data directory.
- Task 18: Ruling: preserve legacy renderer source as regression reference inside the repository, but deny its HTTP routes and exclude it from every distribution — pure legacy behavior tests remain useful while the new React behavior mapping is separately verified — cost if wrong: source-only tests can mask missing React coverage, so the delivery report must identify the actual React and EXE evidence.
- Execution: Ruling: aggregate final full-suite verification after independent frontend and backend units freeze, then run each task's specific completion command — concurrently written RED tests made intermediate whole-suite counts unsuitable as completion claims — cost if wrong: final gates must still cover every changed interface.
- Task12/19: Ruling: a prepared ownership transfer without a provably complete old deletion ledger prevents business readiness — hiding one legacy summary cannot prove whole-package deletion — cost if wrong: startup remains in maintenance until authoritative control can be repaired; authenticated safe logs still work.
- Task6: deterministic late wait snapshot-failure RED→GREEN uncovered and fixed swallowed terminal storage failures; waiting after task cleanup now returns safe snapshot_failed rather than an empty successful fallback.
- Task18: standalone login CSS includes its required theme/form styles after old renderer resources are denied; real HTTP regression proved the former @import references were missing.
- Task19: injected source list and probe must consume the same catalog; real HTTP RED404→GREEN200 with fake provider, preserving default custom-site production behavior.
- Final review: one fresh whole-feature reviewer (gpt-6-astra high) covered df3e765..f283750. With fixes, no Critical; Important: target monetary rescore ceiling bypass; running task lost after navigation; same-page diagnostic hash unsynchronized; actual rule evidence not rendered. Minor: profile menu offers unsupported enable/disable. Root accepts verified findings for one repair pass, each RED/GREEN, final offline + actual EXE gate. No second whole review cycle. Budget regression RED4/5 -> GREEN6/6, existing currency9/9; effective ceiling shared and caller-supplied accounting capped through physical retries.

## 单次全分支审查

范围 df3e765..f283750，结论 With fixes；没有发现已证实的 Critical。

| 级别 | 已证实的问题                   | 处理                                                   |
| ---- | ------------------------------ | ------------------------------------------------------ |
| P1   | 重评入口越过目标费用上限       | 统一有效预算；传入客户端的物理请求、重试也遵守较小上限 |
| P2   | 导航返回后正在运行任务不可见   | 恢复已有任务与事件订阅；恢复期间禁止启动               |
| P2   | 日志同页链接未同步页签与筛选   | 同步路由参数并验证同页跳转与前进后退                   |
| P2   | 规则评价依据未显示             | 显示真实资格检查、评分组成、证据及缺口；历史同时显示   |
| P3   | 简历菜单出现必然失败的停用操作 | 仅目标显示启停菜单；满足用户操作可用要求               |

审查疑点 target.profileRevisionId 初始记录源版本，已追踪到运行、重评、投递采用独立副本，未形成源删除依赖，故不作为缺陷。

未判断真实招聘来源、付费模型的在线可用性；测试边界禁止这些请求。Docker 实际构建受本机 daemon 故障阻断，不能用静态检查冒充镜像成功。

## 实际桌面验收引出的修复

- Electron 42 起，offscreen 渲染默认 DPR=1；测试模式显式传入 deviceScaleFactor，并独立检查真实 DPR。正常窗口配置保持原行为。
- 实际 125% 缩放复现 Toast 的 100% 子高度与父容器自动高度反馈，产生 ResizeObserver loop。改为自然高度后源程序 53/53 通过；没有过滤或隐藏渲染错误。
- 简历菜单虽评为 P3，但用户明确要求操作有效，故在同一轮修复中去掉其不支持的启停入口。

## 第一轮源码门槛

- 修复提交：8e8bd6f（预算）及 92907dd（工作台、日志、评价依据、版本菜单、Toast和Windows测试清理）。
- 完整离线命令：Node 20.20.2 tools/run-all-tests.mjs --skip-network；实际 exit 0。
- 后端 623/623、React 68/68；套件18通过、0失败、7明确跳过。
- 六项跳过需要外网；verify-package在最终真实打包后独立运行，并由UI-ACCEPTANCE.md记录。
- 第一次整套 gate 的安全功能66/66，但Windows临时目录 rmSync 返回ENOTEMPTY；同目录随后为空。await异步rm加有界sharing重试后专项66/66与完整gate exit0。
- 最终Windows包和三个真实DPR的证据另见UI-ACCEPTANCE.md。

## 快速导航启动时序

- 真实 EXE 复现 POST 启动尚未提交就离开并返回，GET/runs先返回旧列表，后台第二个任务随后已创建。
- 不能仅修改自测等待“取消任务”就认为此真实路径修复；增加按Scope共享的启动等待，恢复查询等该启动提交完成，同时不同目标独立，旧页仍拒收迟到显示。
- 修复后需新的React门槛及最终EXE三DPR验证；最终证据记录于UI-ACCEPTANCE.md。

## 最终源码门槛

- App快速导航RED12/14→GREEN14/14，跨Scope迟到隔离及失败回读已验证。
- 最新完整离线：.cache/ui-isolation-release-verified.log，实际exit0，623/623后端、70/70React、18套件通过、0失败；跳过范围保持前述说明。

## Windows PowerShell 5 验收启动器

- 工具使用 UTF-8 BOM 保存源码，并明确以 UTF-8 读取无 BOM 的 JSON 报告，避免中文路径和结果在默认 ANSI 解码下损坏。
- 同一隐藏进程和输出重定向参数的微测试证明：未提前保留进程句柄且退出后 Refresh，会得到空 ExitCode；提前保留 Handle、等待退出并刷新输出、不调用 Refresh，则得到真实退出码 0。证据 `.cache/task19-powershell5-exit-probe.log`。
- 启动器仍要求非空退出码 0、合成报告零失败、真实 DPR 与目标相符、外部请求为 0 和截图文件存在；没有用报告中的通过数替代进程成功。

## 缩放验收窗口的尺寸约束

- 125% 的四次真实采样请求宽度 375、374、373、372，CSS innerWidth 始终为 376，DPR 为 1.25。解除自测的最小宽度限制后，实际宽度仍在 374 和 376 间切换，证明还存在原生窗口在该 DPR 下的尺寸量化。完整失败报告保留真实采样，不能将这种测试窗口约束误报为页面溢出。
- 尺寸处理只应用于显式 self-test；普通窗口仍采用 375 最小宽度、原生边框和既有配置。报告记录实际 CSS 宽度及 DPR，不能将实际宽度改写成预期数字。最终采用的窗口配置和结果见 UI-ACCEPTANCE.md。
- 仅自测无边框的单次诊断仍得到 374/376，故撤回无边框试验，最终保持原生边框。375 名义宽度优先精确校正；125% 无法得到奇数宽时仅接受更窄的实际 374，并记录请求值、实测值及完整采样。768、1024、1440 保持精确要求，不跨越响应断点放宽断言。

## 逐项完成门槛记录

以下为各任务实际成功命令的最后一次记录；完整离线和真实 EXE 证据另见 UI-ACCEPTANCE.md。

```text
Task 1: complete (commits df3e765..20f0bd7, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-v2.mjs --file tests/unit/packages.test.mjs → # duration_ms 86.8353)
Task 2: complete (commits 20f0bd7..b09a162, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-v2.mjs --file tests/integration/package-control.test.mjs → # duration_ms 692.2353)
Task 3: complete (commits b09a162..2e06b3c, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-v2.mjs --file tests/integration/package-migration.test.mjs → # duration_ms 643.5917)
Task 4: complete (commits 2e06b3c..23629b4, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-v2.mjs --file tests/integration/target-owned-profile.test.mjs → # duration_ms 1116.2888)
Task 5: complete (commits 40ea08d..f7ab71a, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-v2.mjs --file tests/integration/package-business-scope.test.mjs → # duration_ms 3258.2227)
Task 6: complete (commits 40ea08d..f7ab71a, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-v2.mjs --file tests/integration/package-run-scope.test.mjs → # duration_ms 4558.7688)
Task 7: complete (commits 40ea08d..f7ab71a, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-v2.mjs --file tests/integration/package-dedup.test.mjs → # duration_ms 1394.863)
Task 8: complete (commits 40ea08d..f7ab71a, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-v2.mjs --file tests/integration/legacy-assignment.test.mjs → # duration_ms 2869.3189)
Task 9: complete (commits 23629b4..f7ab71a, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-v2.mjs --file tests/integration/trash-service.test.mjs → # duration_ms 2842.0031)
Task 10: complete (commits 40ea08d..f7ab71a, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-v2.mjs --file tests/integration/package-purge.test.mjs → # duration_ms 4978.2091)
Task 11: complete (commits 40ea08d..f7ab71a, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-v2.mjs --file tests/integration/package-backup-restore.test.mjs → # duration_ms 3024.137)
Task 12: complete (commits 40ea08d..8e8bd6f, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-v2.mjs --file tests/integration/package-startup.test.mjs → # duration_ms 1848.3258)
Task 13: complete (commits 40ea08d..92907dd, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-ui.mjs --file tests/ui/shell.test.tsx → # duration_ms 2467.9002)
Task 14: complete (commits 40ea08d..92907dd, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-ui.mjs --file tests/ui/targets.test.tsx → # duration_ms 3853.6044)
Task 15: complete (commits 40ea08d..bdf5816, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-ui.mjs --file tests/ui/workbench.test.tsx → # duration_ms 6352.859)
Task 16: complete (commits 40ea08d..92907dd, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-ui.mjs --file tests/ui/logs.test.tsx → # duration_ms 5130.4569)
Task 17: complete (commits 40ea08d..92907dd, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/test-ui.mjs --file tests/ui/trash.test.tsx → # duration_ms 13291.0367)
Task 18: complete (commits 40ea08d..daa1061, tests: .cache/node20-runtime/node-v20.20.2-win-x64/node.exe tools/verify-package.mjs → Package verified: 9979 files, 3 JS assets, 1 CSS assets, 33 production dependencies.)
Task 19: complete (commits 40ea08d..daa1061, tests: powershell.exe -NoProfile -File tools/verify-desktop-self-test.ps1 → SELF_TEST_PASS=57 SCALE=1.5 REPORT=.cache\rjr-self-test-exe-a5b3b0861a814780be1e42ffd82099c5\desktop-self-test.json)
```
