# React 界面与桌面发行验收

日期：2026-10-09。依据：已批准的 `docs/superpowers/specs/2026-10-09-ui-version-isolation-and-trash-design.md` 与 `docs/superpowers/plans/2026-10-09-ui-version-isolation-and-trash.md`，尤其 Task 13–19。

同日后续启动迁移修复的新增回归、完整离线门槛及重新构建产物记录见 [启动迁移修复](MIGRATION-HOTFIX-2026-10-09.md)。下文保留界面发布时的截图与证据。

本文件区分 React 行为测试、保留的旧模块测试、服务器资源检查和真实 Electron 验收。通过旧 `.test.mjs` 不等于新 React 页面已通过同一交互。jsdom 不证明 Chromium CSP、窗口几何、DPI 或实际加密桥接。

## 设计与组件来源

- 信息架构：九页按“日常求职 / 求职准备 / 系统管理”分组；页头选择准确 `packageId + targetRevisionId`，全部目标为只读汇总。详细变量与交互规定见 `design-system/MASTER.md`。
- UI UX Pro Max：使用本地 UX 检索 `desktop personal job workspace data table form error feedback navigation`，落实为提交过程反馈、失败保留草稿、就近错误、字段错误摘要和诊断入口。配色沿用批准的工作台设计。
- shadcn：官方 CLI `4.21.4` 实际初始化及添加组件；`ui/components.json` 记录 `style: base-nova`、`tsx: true`、`rsc: false`、`iconLibrary: lucide`。初始化是 `--base base --preset nova`，不是把 `base-nova` 作为 preset 参数。命令记录见 MASTER。
- `ui/src/components/ui/` 实际有 27 个生成的组件文件：alert、alert-dialog、badge、button、card、checkbox、collapsible、dialog、dropdown-menu、empty、field、input、label、select、separator、sheet、sidebar、skeleton、spinner、switch、table、tabs、textarea、toast、toggle、toggle-group、tooltip；另有生成的 `ui/src/hooks/use-mobile.ts`，合计 28 个生成文件。`toast` 使用 Base UI manager。
- Base UI `1.8.0`；React / React DOM `19.3.0`；Lucide `1.53.0`；Vite `7.3.7`、React plugin `5.2.0`；Tailwind / Vite plugin `4.3.3`；TypeScript `5.9.3`。安装的确切依赖由根和 `ui/package.json` 及 `package-lock.json` 固定。
- 本地系统字体栈：`system-ui, Microsoft YaHei, PingFang SC, sans-serif`。不依赖远程字体请求。`CSPProvider disableStyleElements` 与本地滚动条样式适配 Base UI；生产 CSP 的真实运行结果由最终 EXE 报告记录。
- 官方组件来源：`@shadcn` registry、`@base-ui/react`。源码通过正式组件的 Field / Select / Dialog / Sheet / AlertDialog / Toast 等构成页面，未以外观相似的自制空组件替代。

组件、版本、CLI 参数与设计检索的详细记录见 `design-system/MASTER.md`；本文件不把旧截图当作新界面验收。

## 旧 UI → 新 React 行为迁移表

“已覆盖”只指右列明确列出的实际行为。表中“保留”表示测试仍有价值，但其成功不能补充为 React 交互证据。纯 validation、API、状态解析断言按计划可以继续留 `.mjs`；旧业务 renderer 尚未全部从源码物理删除，服务器和发行包已收口为新入口与白名单资源。

### 导航、准备与版本

| 计划旧测试                                         | 新 React 测试与实际行为                                                                                                                                                                                                                                                                                                                                                                    | 保留 / 尚未直接迁移的范围                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/integration/ui-shell.test.mjs`              | `shell.test.tsx`：`shell exposes nine destinations and exact target in the hash`；`all targets selection remains a read-only summary after navigation`。`jobs.test.tsx`：`a hash navigation restores job filters without changing its owner scope`。                                                                                                                                       | 原五页变为批准的九页；实际 HTTP root / 旧路径 / CSP 检查在 `react-entry.test.mjs`，不能算 React DOM 测试。浏览器完整刷新和后退的真实窗口行为另由 EXE 验收。                                                  |
| `tests/unit/ui-state.test.mjs`                     | `jobs.test.tsx`：旧 A 请求迟到不能覆盖 B；`workbench.test.tsx`：`switching target aborts the old stream and rejects its late progress and completion`，真实切换 B 后释放旧 A 的 progress、done 和哨兵文本，并断言旧 signal 已 abort。`settings.test.tsx`：恢复失败仍保留 A，成功清空选择且重读版本；在 jobs/logs/workbench 往返不再显示旧记录或发送无范围业务查询。                        | UTF-8 分片 NDJSON、解析错误、身份认证与取消的纯 API / state 断言继续保留，不声称它们已经变为新的 React 流解析测试。                                                                                          |
| `tests/integration/ui-profiles.test.mjs`           | `profiles.test.tsx`：`corrected profile facts and original parser metadata are saved as a named independent version`；`extraction failure keeps source text and exposes a readable file error`。`targets.test.tsx`：`target wizard saves preferences and budget and selects the returned exact package`。                                                                                  | 已直接断言人工修改专业、overrides、原 parserVersion、正文、版本名称、submissionId、方向、预算及保存后目标名称。旧“选定城市 / 学历策略”的全部组合并未逐一转为新 React 场景。                                  |
| `tests/integration/ui-profile-validation.test.mjs` | `profiles.test.tsx`：短正文在预览前阻断、失败保留正文；`a selected valid resume file takes priority over pasted text in the React preview request` 验证真实 FileReader 请求只含 filename/base64；`invalid resume file type and size stay at the file field even with valid pasted content` 验证无效类型和超过 20 MB 不被有效粘贴正文绕过。`targets.test.tsx`：缺方向留在原步骤、不发保存。 | 年份、小数、空可选字段、城市模式、招聘类型、未知 source ID 的完整验证矩阵仍由共享 validation / 后端及旧测试验证；目前没有将所有旧表单输入组合一一重演为 React。                                              |
| `tests/integration/ui-record-validation.test.mjs`  | `applications.test.tsx`：版本内 PUT、保存失败保留备注；`jobs.test.tsx`：社交线索缺正文不提交、服务端拒绝仍保留草稿；`sources.test.tsx`：失败保存保留开关和诊断链接。                                                                                                                                                                                                                       | 备注长度、日期边界、清空可选日期仍保留共享验证。登录继续使用保留的 login renderer，原登录行为测试保留；它不是 React 页面。人工关联 ID 的旧交互没有新 React 直接场景。                                        |
| `tests/integration/ui-version-management.test.mjs` | `profiles.test.tsx` / `targets.test.tsx`：重名草稿保留、重试使用同一 submissionId。`version-actions.test.tsx`：重命名空名称不写入、只有 PATCH 完成才显示成功；精确目标 revision 停用 / 归档，归档清除 hash 选择并刷新回收站数量。`targets.test.tsx`：目标详情读取自有 snapshot，不请求已删除来源简历。`trash.test.tsx`：按确切 archiveId 恢复且禁止重复提交。                              | 旧“来源简历归档阻止目标继续运行”已被批准的独立副本关系替代，不能照搬该旧语义。Unicode 名称边界由 domain / 服务端测试保留。简历与目标所有 enable/disable/rename/archive 的失败组合仍未逐一扩展为 React 场景。 |

### 日常求职、费用、岗位与投递

| 计划旧测试                                   | 新 React 测试与实际行为                                                                                                                                                                                                                                                                                                                       | 保留 / 尚未直接迁移的范围                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/ui-workbench.test.mjs`    | `workbench.test.tsx`：首次三步引导；规则更新只发准确 Scope 且不带 Key；临时模型 Key 提交后清除，切换版本丢弃未发送草稿；非法 Key 在请求前阻断；取消等待最终事件。                                                                                                                                                                             | 已直接验证运行的 nested counts 与结果反馈。旧未归属历史由新 logs 的 Scope 和 legacy assignment 流程承接；不把历史记录放入所有目标。                                                             |
| `tests/integration/ui-run-limits.test.mjs`   | `workbench.test.tsx`：`terminal progress uses real backend counters and explains page limits and monetary fallback`，实际 raw=593、deduplicated=282、shortlisted=197 显示为采集 / 保存 / 候选，分页上限与规则回退分别说明，不误报“结果未覆盖全部来源”。                                                                                       | listing-only、unknown qualification、来源请求预算耗尽、同 diagnostic ID 归组等细分提示的全部旧渲染断言尚未分别迁入 React；共享诊断规则与后端 coverage 测试继续保留。                            |
| `tests/integration/ui-model-money.test.mjs`  | `settings.test.tsx`：默认实际模型 `deepseek-flash`、10 元；-1 在本地阻断；0 元原样保存并解释不调用模型，不发送 Key，保留 maxModelRequests。`targets.test.tsx`：10 元目标预算保存。`workbench.test.tsx`：显示费用上界 ¥1.25 / ¥10 及回退。                                                                                                     | 完整的兼容模型 / 清除金额 / 多次保存 / 两位小数等边界仍由现有验证和 monetary 后端测试覆盖；这些旧模块结果不等于新 React 多次保存组合已实测。                                                    |
| `tests/integration/ui-jobs.test.mjs`         | `jobs.test.tsx`：真实 hash 恢复筛选；默认 25 与 250ms 防抖；`job pagination supports fifty and one hundred rows and resets the page in its exact scope` 实际选择 50、下一页、再选 100，断言页码重置、总数及准确 Scope / 筛选；旧 A 迟到请求拒收；本版本完整事实 / 评价历史 / 资格说明；汇总先进入所属版本才能编辑；CSV 导出保留筛选和 Scope。 | 恶意岗位文本、工资单位、无效 URL、查询失败时保留旧列表的全部旧交互尚未分别转为 React 场景；不以“详情已显示”替代这些断言。高级筛选来源名称与移动 card / Table 内容一致仍须配合真实窗口结果核查。 |
| `tests/integration/ui-applications.test.mjs` | `applications.test.tsx`：`application editor saves its owning version and keeps a failed note draft`；`application records the target-owned resume copy and its valid offer status`，断言 offer、copy-A@1 与准确版本请求；分页跨过首屏并保留 Scope。                                                                                          | “清空已有备注”与所有状态 / 日期编辑组合尚无单独 React 场景；失败保留补充内容已直接验证。                                                                                                        |
| `tests/integration/ui-review.test.mjs`       | `jobs.test.tsx` 与 `workbench.test.tsx`：精确 revision、迟到响应拒收、切换 abort 和迟到旧流 progress/done 拒收。`settings.test.tsx`：旧记录完整查看失败阻断分配预览、预览后只移动到一个确切 destination。                                                                                                                                     | 原待确认人工关联 panel 改由新待归属维护入口承接；该流程不是全目标共用投递。两个目标含同一个公开岗位时各自编辑投递的完整往返场景主要由包级后端测试验证，新 React 尚无同岗位双目标完整场景。      |
| `tests/integration/ui-job-cleanup.test.mjs`  | `settings.test.tsx`：逐包 totals / counts；保护项 checkbox 禁用，apply 只提交允许 groupIds；allVersions=true；409 要求新预览。`trash.test.tsx`：整体预览不受简历筛选影响、取消不 purge、原样提交服务端 Preview、partial 结果按 completed/pending/failed 显示。                                                                                | 旧岗位实例 ID 重定向后的 React 详情和独立 recommendation/qualification 全部组合尚无直接场景。去重与永久删除是不同操作，不能互相替代其测试证据。                                                 |

### 来源、日志、设置与反馈

| 计划旧测试                                          | 新 React 测试与实际行为                                                                                                                                                                                                                                                                                                                                                                        | 保留 / 尚未直接迁移的范围                                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/ui-settings.test.mjs`            | `sources.test.tsx`：来源开关失败草稿、candidate 空样本保留最近成功、公开 URL 校验与服务端字段拒绝、probe 更新可用目录计数。`settings.test.tsx`：桌面目录经 bridge，恢复失败保留准确 Scope，恢复成功清旧上下文并刷新版本。`workbench.test.tsx`：临时 Key 不持久。                                                                                                                               | 桌面 Key save/status/delete 的真实加密验证由 EXE / bridge 单元测试负责；React 当前直接验证空 Key 不调用 IPC、目录失败可见以及不向 API 请求私人路径。                             |
| `tests/integration/ui-settings-validation.test.mjs` | `settings.test.tsx`：-1 预算本地阻断、服务端字段错误留草稿、不提前成功、空 Key 阻断；`sources.test.tsx`：私人 URL 阻断 / ID 服务端拒绝草稿；`jobs.test.tsx`：社交正文必填与失败草稿。                                                                                                                                                                                                          | 所有 endpoint、空金额、备份扩展名/大小、超长导入备注、编辑中重复站点 ID 等输入边界可继续由共享 validation 保留；不把旧 renderer 的 pending 双击测试算作新表单 React 双击已覆盖。 |
| `tests/integration/ui-diagnostics.test.mjs`         | `logs.test.tsx`：业务历史准确 Scope，旧响应不能覆盖新版本；系统详情只取白名单，正文 / Key / 路径 / 关键词 / 任意 message 哨兵均不出现；错误 ID 校验；完整导出保留筛选 / Scope、去掉列表 limit、重复点击只有一次下载；维护模式须服务端确认才读取未附版本范围的安全诊断（仍需正常认证）。`harness.test.tsx`：maintenance 路径是 `/api/maintenance` 且认证同源，diagnostic transport 保留 Scope。 | 异常刷新保留旧日志、折叠后任务完成失效、日志 panel 卸载后迟到响应及同一 task 导出竞态的完整旧组合尚无独立 React 场景。回收站轮询的卸载 abort 已覆盖，不能借用为日志 panel 证明。 |
| `tests/integration/form-feedback.test.mjs`          | `feedback.test.tsx`：`field error summary focuses the invalid control`，点击摘要使焦点进入输入且 aria-invalid=true。`version-actions.test.tsx`、`trash.test.tsx`：提交完成前无成功消息、重复恢复只一次；设置 / 来源 / 简历 / 目标 / 投递测试：失败保留输入且无虚假成功；CSV / 日志导出确认生成和下载。                                                                                         | blur 清理相关错误、映射 Select 字段与 malformed date 的完整组合保留共享验证；实际 Portal 几何、Esc、焦点返回和 Toast 位置由 EXE 验收，不能由 jsdom 宣称完成。                    |

## 新回收站额外回归

`tests/ui/trash.test.tsx` 覆盖七项直接交互：

1. `empty confirmation covers all trash despite profile filter and cancel never purges`。
2. `expired and pending rows cannot reveal private body or restore`。
3. `stale preview blocks repeat purge and asks for a new preview`。
4. `purge result distinguishes completed pending and failed without claiming all success`。
5. `unexpired trash restores the exact archive episode once after server commits`。
6. `pending completion refreshes trash and visible versions`。
7. `pending polling aborts on page unmount and ignores late completion`。

这些测试消费服务端状态，不用前端时间猜测恢复权限。真实 72 小时裁决、重启补清理、备份去除已删除记录和控制状态维护模式由后端包级测试验证；实际 EXE 使用显式合成时钟推进 72 小时并执行到期清理服务，不将这一步称为进程重启。

## 行为覆盖记录的边界

- 上述迁移表已经逐个核对计划的 17 个旧测试文件及实际新测试标题 / 请求 / DOM 断言；并非把所有旧用例数改记为 React 用例数。
- 本次补测纠正了标题超过实际断言的问题：旧“断流重连并拒绝迟到旧事件”拆为独立重连测试与真实旧流注入测试；恢复测试增加了失败保留 A、成功清选择、重读版本、旧岗位 / 运行哨兵不再出现以及无无范围查询的断言。
- 新 React 未直接覆盖的交互明确列于右栏。共享纯验证可以保留；需要新交互或真实窗口证明的项目不能因旧模块通过就免除门槛。最终验收负责人应核实这些范围由哪项新增测试 / EXE 检查承接，或保留为明确交付限制。
- 对两版本同公开岗位的隔离，后端包级 Scope 测试与新 React 迟到结果测试分别证明不同层次；它们不自动构成完整的双目标 UI 投递流程证明。

## Task 18：统一构建与发行门槛证据

### 独立审查后的定点修复

- 岗位详情的当前和历史规则评价均显示 `qualification.checks`、`components`、`evidence` 与 `gaps`；合成夹具不提供 `reasons`，直接验证当前与历史依据、学历原文、评分和缺口。毕业届要求的数组也按 `2026、2027` 显示。岗位单文件 RED 7/8 → GREEN 8/8，日志 `.cache/ui-job-evidence-red.log`、`.cache/ui-job-requirement-red.log`、`.cache/ui-job-requirement-green.log`。
- 工作台在进入准确版本时读取已有活跃任务并重新连接事件流；读取中或失败时禁止重复启动，切换版本拒收旧读取。实际 App 导航与合成事件流 RED 8/12 → GREEN 12/12，日志 `.cache/review-workbench-resume-red.log`、`.cache/review-workbench-resume-green.log`。
- 真实 EXE 又复现了“启动请求尚未提交 → 离开工作台 → 返回”的异步窗口；不能以等待提交后再测试替代修复。新 `pending-start.ts` 按 ApiClient 与准确 Scope 保存待提交响应 Promise，提交与读 / SSE 的页面取消分开，返回同版本先等待提交、再读取任务；失败响应后也重新核实后台任务，其他版本互不等待。真实 App RED 12/14 → GREEN 14/14：`.cache/review-workbench-pending-red.log`、`.cache/review-workbench-pending-green.log`。源码 Chromium 延迟提交的确定性 RED 报告：`.cache/rjr-self-test-source-5b6c9e2c60a4478e80c57222ff089bd3/desktop-self-test.json`。最终 EXE 同时验证待提交与已运行的两种导航情形。
- 日志同页链接同步页签、诊断编号和已应用筛选，真实历史前进 / 后退恢复状态；手动切换页签同步 hash、保留未应用草稿，再次点击相同错误编号也可打开诊断。两阶段定点 RED 5/7 → GREEN 7/7、RED 7/8 → GREEN 8/8，日志 `.cache/review-logs-route-red.log`、`.cache/review-logs-route-green.log`、`.cache/review-logs-tabs-red.log`、`.cache/review-logs-tabs-green.log`。
- 简历版本菜单仅提供适用于简历的操作；启用 / 停用只出现在目标版本。先等待菜单实际打开再断言，RED 1/2 → GREEN 2/2，日志 `.cache/ui-profile-menu-red.log`、`.cache/ui-profile-menu-green.log`。
- 125% Chromium 实测曾报告 `ResizeObserver loop completed with undelivered notifications`；定位为 Toast Content 的 `h-full` 与高度测量互相反馈，改为 `h-auto` 后不屏蔽错误。源码真实 125% 运行 53/53，CSP / 控制台 / 渲染器错误及外部请求均为 0：`.cache/rjr-self-test-source-0189724d545d426e89f9656952d7e9c1/desktop-self-test.json`。最终发行 EXE 的三个独立缩放进程见 Task 19。

测试全部使用合成 API / 文件 / 临时目录；未运行真实招聘来源、付费模型或对用户所有版本的清理。截图展示隔离配置与合成记录，不代表用户的实际数据或配置状态。

| 检查                         | 实际证据                                                                                                                                                                                                                                     | 结果                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 最终完整离线门槛             | `.cache/ui-isolation-release-verified.log`：typecheck / Vite build、后端 **623/623**、React **70/70**；18 套件通过、0 失败、7 明确跳过（6 外网，1 实际包另验）                                                                               | exit 0                       |
| React 生产构建               | `tools/build-ui.mjs` 先严格 typecheck，再 Vite；固定 `publicDir:false`、`base:/app/`。最新 EXE 构建再次执行；实际 3 JS、1 CSS 资产                                                                                                           | exit 0                       |
| 认证、HTTP、资产与 ASAR 边界 | `tests/integration/ui-build-assets.test.mjs` 6/6；生产 password auth / 真实 cookie、匿名业务 401、入口与 chunk 存在、未知资源 404、旧路径兼容跳转、缺资产 / 依赖与私有文件拒绝。隔离资产构建不删除 public 兄弟文件                           | 6/6                          |
| 服务器新入口与登录 CSS       | `react-entry.test.mjs` 的 root / 旧路径 / 404 / CSP、独立 login stylesheet、确切包操作 HTTP 检查                                                                                                                                             | 计入 623 后端测试            |
| 部署静态检查                 | `.cache/task18-deploy-final.log`：固定两阶段 Node 20.20.2、builder 输入、runtime 白名单、生产入口及 CSP                                                                                                                                      | 84/84                        |
| 桌面 Node 合成检查           | `.cache/task18-desktop-source-final.log`：合成目录、真实静态文件 / health、PDF 文本加载、无模型 Key 或外部来源                                                                                                                               | 27/27；不代替 EXE            |
| 最新 Windows 构建            | `.cache/task18-desktop-build-final.log`：84.4s；EXE 234.4 MiB、ASAR 97.5 MiB、完整目录 418.4 MiB；版本 2.0.0                                                                                                                                 | exit 0                       |
| 最新发行包检查               | `.cache/task18-package-verify-final.log`：9979 files、3 JS、1 CSS、33 生产依赖；data / control / cache / credentials / tests / 旧 renderer 排除                                                                                              | exit 0                       |
| Docker 实际 build/run        | Docker Desktop 隐藏启动两次；daemon 29.5.3 短暂可用后退出，自身日志报 Inference manager `dockerInference` socket remove 权限 / 路径错误。LinuxEngine pipe 连接阶段 build exit 1；没有成功镜像或容器 smoke。没有修改全局配置或清理系统 socket | **环境限制：镜像未实测成功** |

早期 `.cache/task18-offline-full.log`、`.cache/ui-isolation-release-final.log` 的非零结果保留，不能当作最终 GREEN。前者暴露当时在途代码问题，后者在全部业务断言通过后遭遇 Windows 临时目录 ENOTEMPTY；最终工具以有界异步 FS 重试清理，完整 verified 日志为 exit 0。此前 68 项 React 的 GREEN 是历史门槛，最终为 70 项。

额外真实 React 行为证据：设置恢复 9/9（`.cache/task19-restore-reset.log`）、岗位分页 8/8（`.cache/task19-pagination.log`）、简历文件优先级 / 大小 / 类型 6/6（`.cache/task19-profile-files.log`）；工作台流竞态的早期 8/8 随后扩展到最终待提交导航 **14/14**。

## Task 19：真实 EXE 与截图

最终文件：`dist/简历岗位雷达-win32-x64/简历岗位雷达.exe`。完整目录需一同保留；不能只复制 EXE。本次发行源码为 `daa1061`，构建以后未修改生产字节。

| 文件               |    字节数 | SHA-256                                                            |
| ------------------ | --------: | ------------------------------------------------------------------ |
| EXE                | 245765632 | `973E04DA55A5250A7ECA4A71015C3E1554C2C3EDDBD7EA2CAD4286AFC52BAEF5` |
| resources/app.asar | 102211107 | `322D476D0BD06085439E5F22AE06223043860B6DF971399F5242E14918425256` |

### 三个独立发行 EXE 进程

`powershell.exe -NoProfile -File tools/verify-desktop-self-test.ps1` 通过 Task 19 完成 wrapper 执行，最终 `.cache/task-19-completion.log` **exit 0**；[三进程输出](assets/ui-acceptance/process-verification.txt)保存去掉私人绝对路径后的完整进程输出。三个进程有不同 PID 和不同新临时业务目录，没有修改用户系统 DPI。

| 比例 / PID   | 实际 Chromium DPR | 断言 / 退出码 | 原始报告                                                                           | 可分享副本                                                         |
| ------------ | ----------------: | ------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 100% / 82700 |                 1 | 57/57，exit 0 | `.cache/rjr-self-test-exe-aa14910864a849ae8c2a1273d9fc8a4c/desktop-self-test.json` | [100% JSON](assets/ui-acceptance/scale-100/desktop-self-test.json) |
| 125% / 86960 |              1.25 | 57/57，exit 0 | `.cache/rjr-self-test-exe-01928223359242e9ad2246b9e394c78f/desktop-self-test.json` | [125% JSON](assets/ui-acceptance/scale-125/desktop-self-test.json) |
| 150% / 83556 |               1.5 | 57/57，exit 0 | `.cache/rjr-self-test-exe-a5b3b0861a814780be1e42ffd82099c5/desktop-self-test.json` | [150% JSON](assets/ui-acceptance/scale-150/desktop-self-test.json) |

每个报告均为 `synthetic:true`、`network.externalRequests:0`、CSP violation / 控制台错误 / renderer error **0**。Node fetch / HTTP / HTTPS / net / TLS / WebSocket 与 Chromium HTTP / WS 的严格实际 127.0.0.1 origin 保护已在读取配置和凭据之前安装。环境和默认目录不能回落到日常数据；显式目录拒绝非测试目录、已有数据与 junction / symlink。生产没有测试 IPC，也不 import 被打包排除的 tests/helpers。

三个进程分别实际操作九页；简历预览纠正与保存、独立目标副本、目标启停 / 重命名、规则更新 / 重新评价、当前与历史依据、延期提交后快速导航、活跃任务恢复 / 取消、版本切换、投递、逐版本去重、源简历永久删除后目标仍可运行、整包归档 / 恢复、清空部分失败与续清理、72 小时到期清理均由实际提交后的仓库结果验证。模型服务只作合成注入；实际窗口的更新和重新评分采用规则模式，不声称完成真实或付费模型调用。

设置页实际验证合成 Key save / status / delete、磁盘不含该明文 Key、固定目录桥接和非法路径拒绝；外链 / 打开目录仅记录 intent，不访问外部网站或打开用户目录。维护模式与真实重启补清理由后端及 desktop startup 测试验证；EXE 的 72 小时用显式主进程时钟推进并调用清理服务，不冒称重启。

源码运行与发行运行分别保留：最终默认源码 Chromium `.cache/rjr-self-test-source-3a37464db4fc45849e3eee83c43b9630/desktop-self-test.json` 57/57；最终 125% 源码 `.cache/rjr-self-test-source-272044df0e35401b8162bcf53d306ff9/desktop-self-test.json` 57/57。两者不代替上表真实 EXE。

### 真实窗口几何与可复核截图

每个进程在岗位库、设置页各检查一组请求宽度 375 / 768 / 1024 / 1440，再独立放大字体 125%；均无 document 横向溢出。768 的 Table 列在自身容器内横向滚动；整页不溢出。小屏使用岗位 Card，长中文换行；实际 Select 弹层在视口内、Esc 后焦点返回，Sheet 焦点位于弹层，错误 summary 接收焦点。Toast 保留正常测量，未屏蔽 ResizeObserver 或 CSP 错误。

| 请求 CSS 宽度 | 100% 实际宽 | 125% 实际宽 | 150% 实际宽 |
| ------------: | ----------: | ----------: | ----------: |
|           375 |         375 |     **374** |     **374** |
|           768 |         768 |         768 |         768 |
|          1024 |        1024 |        1024 |        1024 |
|          1440 |        1440 |        1440 |        1440 |

Windows 的最小宽限制先把 requested 375/374/373/372 全夹到 actual 376；仅自测 `minWidth:0` 后，原生 DPI 的 requested 375/374 分别量化为 actual 376/374。一次仅自测 frameless 试验仍相同，故最终恢复原生 frame，生产最小宽继续 375。校正器按 1px 有界邻值搜索，768 / 1024 / 1440 必须精确；只有 375 使用更窄的真实 374（±1px），不改写成 375。JSON 的 `requestedWidth`、`nativeRequestedWidth`、`width`、`dpr`、`attempts` 保留全部采样。

尺寸 RED 报告保留在 `.cache/rjr-self-test-source-fa10dc1a19c74b138cb760761ed89ff0/desktop-self-test.json`（minWidth 夹住）、`.cache/rjr-self-test-source-b9cf5392828d49f888cb29f08818e560/desktop-self-test.json`（min0 原生量化）、`.cache/rjr-self-test-source-597c8ca7c0f94d2195cf242d7a213147/desktop-self-test.json`（frameless 仍量化）、`.cache/rjr-self-test-source-32fd3b784bae4c1bbc5d9cb36961aca0/desktop-self-test.json`（一次跳 2px 越过 768 的有效邻值）。最终三 EXE 报告全部 GREEN。

Electron 42+ 的 offscreen 设备比例默认 1，不会自动沿用显示比例参数；本项目仅自测显式设置 OSR deviceScaleFactor，并在真实 Chromium 读取 DPR 核实。[Electron breaking changes](https://github.com/electron/electron/blob/main/docs/breaking-changes.md?plain=1)、[WebPreferences offscreen](https://github.com/electron/electron/blob/main/docs/api/structures/web-preferences.md)、[offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)。

PR 随附 3 个原始合成 JSON 与 16 张代表性 PNG，合计约 1.96 MiB；只包含合成数据，没有个人简历、凭据、私人路径或网页正文。原始每进程 9 张截图保留在各自临时目录。已实际视觉检查 125% 的 374px Card、150% 的 768px Table / 1440px Table 及字体放大截图，标题 / 表单 / 按钮可读，页面无横向溢出。

- [默认 375px 设置页](assets/ui-acceptance/scale-100/ui-375-1.png)
- [默认 1440px 岗位库](assets/ui-acceptance/scale-100/jobs-1440-1.png)
- [125% 小屏岗位 Card：实际 374px](assets/ui-acceptance/scale-125/jobs-375-1_25.png)
- [125% 精确 1024px](assets/ui-acceptance/scale-125/jobs-1024-1_25.png)
- [150% 精确 768px Table](assets/ui-acceptance/scale-150/jobs-768-1_5.png)
- [150% 精确 1440px Table](assets/ui-acceptance/scale-150/jobs-1440-1_5.png)
- [150% 进程另加字体 125%](assets/ui-acceptance/scale-150/ui-font-125.png)

### Windows 自带 PowerShell 工具适配

保留真实退出码判定：缺失或非 0 都失败，不以 JSON 通过替代进程状态。PS5 的三项问题分别最小修复：脚本 UTF-8 BOM、JSON 显式 `-Encoding UTF8`、启动后先保留 Process.Handle，已退出后完成重定向等待且不 Refresh 清除状态。相同 Redirect 微进程实测无保留句柄 + Refresh 时 ExitCode=null；保留句柄后为 0。

原始失败证据 `.cache/task19-powershell5-launch-red.log`、`.cache/task19-powershell5-json-red.log`、`.cache/task19-powershell5-exit-red.log`；只读解析 GREEN `.cache/task19-powershell5-launch-green.log`、`.cache/task19-powershell5-json-green.log`；退出码 RED / GREEN `.cache/task19-powershell5-exit-probe.log`。最终上表三个真实 EXE 都由 Windows 自带 `powershell.exe` 运行，输出 `SELF_TEST_EXIT=0`。

## 交付确认

本次完整离线、发行资产 / 依赖检查与真实 EXE 三比例门槛已通过。一次独立全分支审查的四项 Important 与一项 Minor 均已修复；真实 EXE 随后发现的快速导航问题也经过确定性 RED / GREEN 和最终三个进程验证。审查 / 决策详细记录见 `docs/IMPLEMENTATION-DECISIONS.md`。

保留上文旧 → 新迁移表的直接覆盖边界、Docker 环境限制与真实 375→374 的 DPI 舍入事实。没有使用旧版测试数字或旧 EXE 截图冒充本次验收；未操作用户真实清理、分配或备份恢复，完成后保持电脑开机。
