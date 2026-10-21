# Task9 成品自检与 ASAR 接线研究

日期：2026-10-10。基线：`92c034d`。本报告只读核对生产源码及现有测试；未实施产品变更，未运行真实网络、未读取账户材料或真实简历。主代理正在实施的 `electron/self-test-boss.mjs` 尚未作为本报告的验证对象。

## 现有接口与可复用结构

| 文件与行号 | 现有结构 / 接线用途 |
| --- | --- |
| `electron/self-test.mjs:249` | `runWorkspaceSelfTest({window,context,clock,controls,dataDir,networkGuard,...})`；`:264` 的 `check(name,ok,details)` 和 `:370` 的 `phase(name,fn)` 将断言写入成品报告。 |
| `electron/self-test.mjs:456` | 两个合成目标于此阶段建立，A 在 `:479` 重读后是最终修订，B 在 `:483` 创建。后续 Boss 阶段应使用这两个最终目标的 `{packageId,revisionId}`。 |
| `electron/self-test.mjs:903` | 原有归档/恢复阶段；永久清理于 `:923`，72 小时清理于 `:947`。新增 Boss 合成阶段可在归档前运行，但必须自行结束根活动、清除自己的合成会话。 |
| `electron/self-test.mjs:1006` | 现有成品最终断言 `networkGuard.report().externalRequests === 0`。Boss 合成 VM 无真实出站，不需要增加 Boss URL 放行。 |
| `electron/self-test-network.mjs:8` | `installSelfTestNetworkGuard({session,allowedOrigin})`；`:156` 可 attach Electron session；`:172` 仅有合成环回 origin；`:179` 有四条已批准社交合成 URL。不要通过扩展此 URL 白名单运行真实 Boss。 |
| `electron/collection/boss-page.mjs:4` | `validateBossOperation(operation)` 以 `buildBossOperation` 重建规范值，拒绝方法、URL、字段或参数偏移。 |
| `electron/collection/boss-page.mjs:32` | 固定 `pageRead(operation,id)` 仅调用原页 `window.$.ajax`；`:35–39` 缺原页 `ajaxSettings.beforeSend` 即失败；`:51–56` 使用固定 method/form/45 秒超时，未覆写 `beforeSend`。 |
| `electron/collection/boss-page.mjs:85` | `bossPageScript(operation,id)`；`:88` `bossAbortScript(id)`；`:91` `decodeBossPageResult(raw)` 限 6 MiB 并限制返回错误码。可在 VM 内执行生产模板。 |
| `src/sources/boss/protocol.mjs:14` | `buildBossOperation(input)`；搜索固定 POST `/wapi/zpgeek/search/joblist.json`，详情固定 GET `/wapi/zpgeek/job/card.json`；`:60` `parseBossResponse` 将 code36/37 等分类。 |
| `src/sources/adapters/boss.mjs:15` | `createBossProvider()`；`:17–25` 的临时引用 key 包括包、修订、会话、根活动、epoch、slice 和公开 ID。 |
| `src/sources/adapters/boss.mjs:27` | `read(ctx,operation)` 要求 `scope/ref/token/sessionRefs.boss/readService.readBoss`，调用前后检查 signal；provider 不执行 HTTP fallback。 |
| `src/sources/adapters/boss.mjs:50` | `listPage(site,query,page,ctx)` 产生 records 和 `discoveryPage`；`:97` 的 detail 仅在缺临时引用时重读原发现页，`:141` 清除引用。 |
| `src/application/content-read-service.mjs:6` | `createContentReadService({...})`；`:14` `setBrowser(browser)`；`:17` `readBoss(input)` 只委托 `browser.readBoss(input)`。 |
| `electron/collection/browser.mjs:23` | `createCollectionBrowser({BrowserWindow,session,ledger,egressProxy,sessionStore,offlineAllows,assertScope,...})` 可注入合成 Electron 窗口及 session。 |
| `electron/collection/browser.mjs:305` | `readBoss(input)` 验证 operation 后走原 owned-session 队列；风险检查在 `:42`，且在真正窗口预约之前执行。 |
| `electron/collection/browser.mjs:469` | 业务风险回应先 `sessionStore.setRisk`，再返回受控 JSON；`:321` `recoverBossSession(input)` 通过新同会话探针成功才 `clearRisk`。 |
| `electron/collection/browser.mjs:613` | `clearSession({scope,sessionRef})` 清连接、存储和缓存，再撤销引用；`:627` `closePackage(packageId)` 排空准备和窗口并调用 sessionStore cleanup；`:652` `stop()`；`:668` snapshot。 |
| `electron/collection/sessions.mjs:10` | `createCollectionSessions({dataDir,safeStorage,fsAdapter,clock})`；风险文件与加密材料分开。`:128` create；`:152` get；`:233` credential-free getStatus；`:243` setRisk；`:271` clearRisk；`:304` cleanupPackage；`:307` clear。 |
| `electron/collection/sessions.mjs:163–177` | 没有加密材料的重启也能从 `risk-stops.json` 恢复归属和风险。合成自检可令 safeStorage 不可用，并仍验证风险持久；无需在成品模块引入伪加密。 |
| `src/application/collection-service.mjs:55` | `createCollectionService({repository,operationGate,registry,ledger,clock,planner,readService,...})`；可复用 context 的真实 repository/gate/ledger，独立 Boss registry 和 planner。 |
| `src/application/collection-service.mjs:502` | `commitCollectionPage({ref,token,unitId,page,operationLease})`；`:519–531` 先检查真实 lease 与当前 epoch/slice/status，再入库。迟到写入必须在这一生产边界断言失败。 |
| `src/application/collection-service.mjs:637` | pause；`:640` cancel；`:643` wait；`:663` cancelPackageAndWait；`:702` stop；`:716` setReadService。 |
| `src/application/collection-service.mjs:722` | `withActivityContext(ref,callback)` 复用活动 ctx 并追踪 pending；`:740` `withDiagnosticContext({ref,requestId},callback)` 可在暂停根开诊断，但 terminal 根拒绝。 |
| `electron/main.mjs:466` | 创建生产 sessionStore；`:537–542` 恢复/清理/关闭 hooks；`:553` browser 组装；`:586–587` 接入 context/readService；`:590` 注册可信 IPC。 |

## 自检的最小接线建议

主代理提出的 `runBossSelfTest({context,targets,clock,dataDir})` 可以放在独立生产自检模块，由既有 `phase` 调用，并把返回的安全断言逐条交给 `check`。入口首先要求 `dataDir/.rjr-self-test` 存在，全部持久数据继续写在该合成目录下。

1. 用真实 `createCollectionService`、`createCollectionLedger`、`createCollectionSessions`、`createContentReadService`、`createBossProvider`，复用 `context.repository` 和 `context.operationGate`，两个目标分别使用真实持久根。为合成服务注入明确的 Boss 单元、公开合成记录和固定返回 JSON，不改 context 原有 registry。
2. 将 Fake BrowserWindow/session/egress 实现直接置于自检模块。模板由 VM 执行生产 `bossPageScript`，VM 的 `$` 合成 ajax 必须实际调用自己的 beforeSend，并通过合成 session 的 `onBeforeRequest` 走生产 `createPagePolicy` 授权。单纯从 executeJavaScript 返回预制 JSON 可以证明生命周期，但不能证明页内固定 Ajax 和方法/参数许可。
3. `loadURL` 的初始导航和 ajax 都走生产 webRequest callback；请求对象包括 `method/resourceType/webContentsId`，POST 表单还要包含原始 form body，使生产许可识别规范 form。synthetic egress 的 grant/revoke/snapshot 可记录动作，不能创建真实 socket。
4. 两目标至少各执行两页，至少一个 JD；公开 ID 可以相同，以 ownerPackageId、revision 成员和事实引用验证没有串版本。检查持久 cursor/workspace 无 `securityId/lid`。临时 readRef 保留在 provider 实例内。
5. 风险返回 code37 环境异常，验证持久 sessionStore 重建后同会话列表和 JD 都在预约前拒绝，另一目标仍可读；普通 `setState` 不解除闩锁。调用 clearSession 或 closePackage 后旧引用再次读取拒绝。
6. hold Ajax 后取消根活动，观察生产 `bossAbortScript`、窗口 dispose 和 permit revoke；释放迟到 success 后，根仍 cancelled，owned jobs/observations 不增加。额外用真实 `commitCollectionPage` 传原 token/lease 断言旧 epoch 或失效 lease 拒绝，覆盖“无法保存”而不只是“read Promise 已 reject”。
7. finally 中停止合成 collection service、browser，清会话；返回仅安全计数和状态，不返回 JSON 正文、临时安全引用、material 或绝对路径。原成品 guard 保持启用，最终外网零请求检查继续成立。

已有测试提供边界模型：`boss-browser.test.mjs:30` VM Ajax+abort，`:74` 缺钩子零发送，`:92` 操作绑定许可，`:166` 可注入 browser harness，`:240` 双分区，`:280` 零预算/上下文销毁，`:298` 取消迟到响应，`:326` readService 无 fallback；`boss-collection.test.mjs:240` 真实根续页累计账本；`boss-session-risk.test.mjs:169` 风险预约前阻塞且不影响另一版本，`:236` 队列中持久闩锁。

## 源码与 ASAR 逐文件匹配

`tools/verify-package.mjs:152` 的 `verifyPackageArchive({archivePath,root})` 当前只有 required presence、生产 npm dependency 闭包、UI 引用和隐私排除。`:165` 的文本 read 转 UTF8，不能用作字节级散列。应在 required presence 校验后新增生产源码匹配清单，以 `fs.readFileSync(path.join(root,file))` 和 `asar.extractFile(archivePath,...)` 的原始 Buffer 分别 SHA256，失配报相对路径，并将 `{file,sha256}` 数组放入 report。不要散列精简后的 package.json 来要求与开发 package.json 相同。

以下是本次功能安全接线应显式匹配的精确生产文件。它包含五个 Boss 功能文件及相关服务，不将 tests/tools/evals fixture 纳入成品依赖：

```text
electron/main.mjs
electron/preload.cjs
electron/self-test.mjs
electron/self-test-network.mjs
electron/self-test-boss.mjs
electron/collection/boss-page.mjs
electron/collection/browser.mjs
electron/collection/sessions.mjs
electron/collection/network-policy.mjs
electron/collection/ipc.mjs
src/sources/boss/protocol.mjs
src/sources/boss/records.mjs
src/sources/boss/cities.mjs
src/sources/adapters/boss.mjs
src/sources/adapters/shared.mjs
src/sources/registry.mjs
src/sources/planning.mjs
src/sources/catalog.mjs
src/sources/catalog/platforms.json
src/application/context.mjs
src/application/content-read-service.mjs
src/application/collection-service.mjs
src/application/collection-ledger.mjs
src/application/collection-refresh.mjs
src/application/source-service.mjs
src/application/workspace-operations.mjs
src/application/package-runtime-service.mjs
src/domain/collection.mjs
src/domain/packages.mjs
src/infrastructure/collection/egress-proxy.mjs
src/infrastructure/http/scheduler.mjs
src/infrastructure/http/public-url.mjs
src/infrastructure/storage/repository.mjs
src/infrastructure/storage/atomic.mjs
src/infrastructure/storage/lock.mjs
src/infrastructure/storage/package-control.mjs
src/infrastructure/diagnostics/log.mjs
src/infrastructure/lifecycle/resource-shutdown.mjs
public/js/validation-rules.js
```

Task9 同时交付任务5–8，应再匹配这些既有生产变更：

```text
src/application/job-verification-service.mjs
src/application/evaluation-service.mjs
src/domain/recruitment-evidence.mjs
src/domain/collection-quality.mjs
src/sources/adapters/ncss.mjs
src/sources/adapters/official-announcements.mjs
src/sources/catalog/public-notices.json
src/sources/content-queue.mjs
src/sources/discovery.mjs
src/llm/prompt-registry.mjs
src/llm/prompts.mjs
src/llm/validation.mjs
src/match/article.mjs
```

这是应明确验字节的功能文件清单，不声称枚举 registry/context 所有传递 imports。真实生产装配在 `tools/build-desktop.mjs:205–207` 已完整递归拷贝 electron/src/build；生产 npm 依赖由 `prodClosure` 保证。此接线不需要新增 npm 生产依赖。UI 源码不在包内，其构建资产继续使用已有 `validateUiAssets` 校验，不强求 TSX 与生成 JS 字节一致。

隐私现状：`verify-package.mjs:169–184` 已排除 data/control/cache/logs/credentials/tests/tools/ui 等；`:215–222` 仅识别三类凭据形状。若补用户级 SDK 绝对路径检查，应检查打包源码文本中的绝对用户目录形式并报安全错误，测试使用合成路径；不要读取真实用户 SDK 或配置文件来构造基准。

## Package 测试建议

最小位置是 `tests/integration/ui-build-assets.test.mjs:40` 的现有 `packageFixture(t)`，其 stage/asar/npm 闭包/UI 资源已完整，无需另建重型成品 fixture。现有 `runtime` 在 `:12–38` 为旧 presence 清单；`:49` 只写 stage，因此加入 hash 校验后应将每个明确散列文件的相同合成 Buffer 同时写到 source root 和 stage。可以导出并复用清单来生成 fixture，但测试故障样本应明确点名关键文件。

- 正例：全清单存在且每文件字节一致，verify 返回匹配数和 SHA256。
- 缺文件：删 `src/sources/boss/protocol.mjs`，verify 非0并报相对路径。
- 篡改服务：只改 stage 的 `src/application/collection-service.mjs` 或 `electron/collection/sessions.mjs`，verify 非0并指出 mismatch；源 root 保持原字节。
- 篡改新增契约：只改 stage 的 `src/llm/prompt-registry.mjs`，同样被拒绝，保证扩展交付清单确实参与匹配。
- 用户级工具路径：在包内允许的合成源码放假用户 SDK 绝对路径，应触发明确隐私拒绝。

保留现有 `:218` 缺 UI chunk / transitive npm dependency 负例、`:241` 私密目录与旧 renderer 排除负例。测试只创建合成临时 package，全部可离线完成。

## 验证范围

报告核实的是当前源码结构与接口边界，未执行测试、打包、EXE 或真实 Boss 平台验收。合成 Ajax 自检证明包内协议/隔离/取消/持久风险的接线；线上登录、原站业务语义和真实数据质量应由 Task9 的独立真实验收报告陈述。
