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

## 2026-10-10 来源效能补充与实测修复

- 使用现有持久活动、版本事实、预算账本、操作租约和取消令牌。新增内部prepare只准备暂停根，不发请求或开启自动刷新；相同准备请求的模式、计划或额度变化明确拒绝。
- 从collection-service提取record-enrichment，并以内部受控上下文复用。诊断不另建请求或模型额度；投递先核验、附件保留行证据，前后检查生命周期。新增major-evidence仅统一大学和91job明确专业字段映射，不引入另一套采集框架。
- 来源测试先零请求识别缺模板、登录与外部费用阻断，再按provider轮询、用本地自有画像选择详情。未补正文进入原队列；超时归因复用诊断白名单，取消后拒绝写入。
- 大学全文与明确入口保留；页头专业支持分行并记录原文位置。91job无新入口时保留旧入口，多个候选仍未知。专业编码、大类、相关专业及未知sourceExpiry继续保守处理。
- 条件解析升级conditions-3；旧评价保留历史但不复用为当前。显式失败状态以及可识别的旧大学截断正文不能被完整标记覆盖。原213条实测事实已在外网守卫下本地重评，来源/附件/模型和费用增量均0。
- 独立审阅三项问题均以真实RED后修复并由同一审阅者复核：旧拆岗内部截断、准备请求额度不一致、专业标签分行遗漏。该审阅只覆盖本补充代码，未认领新版UI或真实平台通过。
- 首批98站矩阵保留历史成绩；180累计请求已耗尽，追加请求授权仍待答。Boss需要本版本专用首次登录，缺模板和未实测平台不标已接通。现代UI设计已通过，实施计划待审阅；新UI尚未实施。
- 旧GitHub CI请求间隔失败按生产问题处理：异步预约时间早于回调真正进入，繁忙事件循环可使同域回调连续启动。纯注入时钟先取得真实RED，再增加每域待进入预约，起始时间只在信号检查后的回调入口记录；即时取消不消耗间隔。原计时断言保留，HTTP关联25/25通过，独立审查无阻塞问题。生产变更后重新进行完整门禁、构建和三DPR验收。
- 实际EXE的动态worker自测揭露代理连接重置未被局部处理。将上游及下游错误绑定到请求，DNS和拨号阶段也可取消，CONNECT在准备阶段即登记归属；失败握手保留502契约。同一客户端的后续请求继续可用。新增5项真正行为RED，代理10/10及worker/protocol关联15/15通过；最终EXE仍需新包验证。
- 桌面自测等待超时后，使用本轮Start-Process保留的句柄和PID清理该合成进程树，再重抛原错误；不按应用名称结束进程。清理仅为best-effort，脚本解析和独立范围审查通过。
- 设置保存采用现有串行队列：私有config先暂写，workspace提交后才发布内存配置；普通workspace异常时补偿旧config，原不存在则删除新文件。补偿失败返回固定409/settings_rollback_failed并阻止本会话后续保存，日志仅白名单元数据。6项真实RED后通过，设置/预算/诊断关联21/21。此改进不保证断电时两个文件的原子事务或跨进程并发，补偿失败须处理存储并恢复配置后重新启动。
- 来源探针返回同样需要隐私边界：global/scoped两处均将issues投影为已知错误代码、当前来源/站点、retryable布尔及规范日志编号，不返回上游message或任意扩展字段。真实合成canary验证响应、workspace和诊断均不含原文；此次缺陷是临时响应，不能据此推断历史持久日志发生泄漏。
- 三个旧来源仅将原生岗位字段或明确正文容器当作完整证据。实习僧需要岗位UUID及description字段同时匹配，就业桥用真实DOM结束边界，智联需要原生jobDetail。整页兜底仍可留作诊断但不算完整正文；这三源及大学拆岗升级legacy-adapter-3，旧三源parser1/2须重新核验，人工核验正例保持。
- 招聘PDF同时检查原生文字和实际绘制图像，图像区域通过既有本地OCR、坐标归一及原生回声去重取得证据；没有可信图像文字保持pending。附件解析升级recruitment-attachments-2；旧PDF缓存不自动复活，预算或刷新失败时撤销旧完整标记，新提取成功后由既有补全路径恢复。图片含logo或复杂裁剪可能保守待核验；可信文字不能保证逐单元格准确率。
- 刷新、更新和爬取时间不替代发布日期。明确datePublished才能保留旧发布日期字段；平台refreshTime、refresh、updateTime、dateLastCrawled按原字段保留extra，缺少发布证据时留空。不全局将旧publishTime映射为publishedAt，也不以新鲜日期替代截止、当前在招及投递证据。
- 实际EXE截图复核发现续采仍显示旧批次取消结论。暂停会结束旧slice，界面收到done(cancelled)；成功resume的新activeSlice必须清除独立outcome，再订阅新批次事件。修复仅该状态重置，不改变布局；新4项用户可见回归先取得3通过/1真实失败，再4/4通过，失败续采及新批次completed/partial结果保留，独立只读复核通过。成品自检新增对应负断言，旧84/84三DPR为修复前历史基线。
- 最后产品完整离线983/983业务、84/84UI，18套件通过/0失败/7明确跳过；类型、PowerShell解析及差异检查通过。新增EXE断言首轮误用exec造成DPR1实际exit1，改为同作用域js后6/6隔离及独立复核通过，再次重建133.2秒退出0。最终包10434文件/52依赖/207精确源码哈希/OCR32；实际DPR1/1.25/1.5各85/85、原生进程均exit0，外发及自动下载0、CSP/渲染器错误为空。主代理实际截图确认旧取消文字消失。现代UI与全来源线上仍按各自待办独立验收。
