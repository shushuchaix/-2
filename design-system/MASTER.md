# 简历岗位雷达界面系统

实施依据：已批准的 `2026-10-09-ui-version-isolation-and-trash-design.md`。这是个人求职桌面工作台；颜色、信息架构与交互沿用该书面设计。

## 信息架构

| 分组     | 页面     | 主要动作                           |
| -------- | -------- | ---------------------------------- |
| 日常求职 | 工作台   | 更新当前目标的岗位，观察运行并取消 |
| 日常求职 | 岗位库   | 筛选、查看事实和评价、记录投递     |
| 日常求职 | 投递进度 | 看板或列表，修改本版本记录         |
| 求职准备 | 简历管理 | 上传或粘贴、校正、命名保存         |
| 求职准备 | 求职目标 | 选择简历、偏好、来源预算、摘要保存 |
| 求职准备 | 招聘来源 | 启停、保存、探测、添加站点         |
| 系统管理 | 运行日志 | 本版本业务历史、系统诊断筛选与导出 |
| 系统管理 | 回收站   | 72 小时内整包恢复、永久删除、清空  |
| 系统管理 | 设置     | 模型预算、目录、备份、版本维护     |

Hash 保存 `packageId + targetRevisionId`。未选择目标与“全部目标 · 只读汇总”是不同状态。汇总行显示所属版本；编辑前进入所属版本。切换版本中止请求/事件流，迟到结果不更新新版本页面。管理页保留正在填写的草稿；业务页按范围隔离。

## 视觉变量

| 变量                         | 值                                                         |
| ---------------------------- | ---------------------------------------------------------- |
| background / foreground      | `#F8FAFC` / `#0F172A`                                      |
| card / card-foreground       | `#FFFFFF` / `#0F172A`                                      |
| primary / primary-foreground | `#0369A1` / `#FFFFFF`                                      |
| muted / muted-foreground     | `#F1F5F9` / `#475569`                                      |
| border / input               | `#E2E8F0` / `#64748B`                                      |
| destructive                  | `#B91C1C`                                                  |
| success / success-background | `#166534` / `#F0FDF4`                                      |
| warning / warning-background | `#92400E` / `#FFFBEB`                                      |
| focus ring                   | `#0369A1`，2px，并留 3px 间隔                              |
| font                         | 本地 `system-ui, Microsoft YaHei, PingFang SC, sans-serif` |
| body / secondary             | 16px / 至少 13px                                           |
| control height               | 至少 44px                                                  |
| spacing                      | 4px 基础；页面/卡片以 16/24px 为主                         |
| transition                   | 150–200ms；`prefers-reduced-motion` 降低动画               |

主区域最大 1440px；768px 以下使用可关闭侧栏与岗位卡片。卡片与表格消费同一事实投影；长中文自动换行。弹窗设置视口上限和纵向滚动。详情 Sheet 可阅读当前版本正文、来源观察、历史评价及投递。

## 表单与反馈

采用真实 Base UI Field/Select/Checkbox/Dialog/Sheet/AlertDialog/DropdownMenu/Toast。所有表单使用现有共享 `validation-rules.js`；错误同时出现在字段与可跳转摘要，摘要接收焦点。错误保留输入；操作中禁重复提交；成功只在接口提交完成后出现。错误携带诊断 ID 时提供日志链接。

资料库简历与目标自有简历相互独立；删除资料库版本说明保存目标副本仍可用。目标创建和失败重试保留 `submissionId`。模型显示实际 API model ID，金额为每任务 0–10 元；0 元禁用模型调用。规则模式不发送密钥，临时密钥仅模型模式出现，创建成功或离开后清除。

回收站按服务状态决定内容能力：未到期包可详情/恢复；到期包仅管理元数据；`purge_pending` 仅匿名操作、安全计数和重试；`purged` 不再显示。清空预览覆盖整个回收站，页面筛选不改变范围。原样提交服务端 Preview；409 要求重做预览。完成、等待和失败逐项反馈，不把部分完成描述成全部成功。

## shadcn 来源与初始化实证

官方 CLI 固定 `shadcn 4.21.4`。真实执行后生成 `ui/components.json` 的 `style: base-nova`、`rsc: false`、`tsx: true`、`iconLibrary: lucide`、Tailwind CSS 变量及 `@/` 别名。

实际命令（工作区已有 Vite/React/Tailwind 配置与 `ui/package.json`）：

```powershell
node node_modules/shadcn/dist/index.js init --cwd ui --base base --preset nova --no-monorepo --no-rtl --yes
node node_modules/shadcn/dist/index.js add '@shadcn/sidebar' '@shadcn/card' '@shadcn/field' '@shadcn/select' '@shadcn/dialog' '@shadcn/alert-dialog' '@shadcn/toast' '@shadcn/badge' '@shadcn/tabs' '@shadcn/toggle-group' '@shadcn/table' '@shadcn/dropdown-menu' '@shadcn/alert' '@shadcn/empty' '@shadcn/spinner' '@shadcn/checkbox' '@shadcn/textarea' '@shadcn/switch' '@shadcn/collapsible' --cwd ui --yes
```

这里的 preset 参数是 `nova`，`--base base` 选择 Base UI；`base-nova` 是生成的 style 名称，不能直接传作 preset。真实 CLI 生成 27 个 UI 组件文件及 `use-mobile.ts`，合计 28 个生成文件，依赖组件包括 button/input/separator/skeleton/tooltip/label/toggle/sheet。生成源使用 `@base-ui/react`、`cn`、Lucide；Toast 采用 Base UI manager，Select/ToggleGroup 使用 Base UI 的值和 props。组件中文关闭提示与布局覆盖属于本地修改，原始供应商来源仍记录在此。

主题初始化含字体模板；已替换为本地系统中文字体和批准的变量，不下载外部字体。

| 锁定包                 | 版本                     |
| ---------------------- | ------------------------ |
| React / React DOM      | 19.3.0                   |
| Vite / React plugin    | 7.3.7 / 5.2.0            |
| Tailwind / Vite plugin | 4.3.3 / 4.3.3            |
| Base UI                | 1.8.0                    |
| Lucide / cn / CVA      | 1.53.0 / 0.4.0 / 0.7.1   |
| TypeScript / tsx       | 5.9.3 / 4.23.15          |
| jsdom                  | 29.1.1                   |
| RTL / DOM / user-event | 16.3.3 / 10.4.2 / 14.6.7 |

锁定版本已实际安装，在 Node **20.20.2** 上运行测试、类型检查和构建。Vite 7.3.7/React plugin 5.2.0 与 jsdom 的官方 engines 包含此版本；不使用要求更高 Node 的新 Vite 版本。

2026-10-09 npm 官方审计：`--omit=dev` 为 0 个漏洞。全依赖的 7 项 high 属 shadcn CLI 开发依赖链（braces/micromatch/fast-glob/registry/ts-morph）；npm 提议降到 shadcn 1.0.0，未自动降级。CLI 不随生产运行使用，构建资产包含已生成的组件。最终安装/打包仍由统一交付门禁验证。

## 构建与 CSP

`ui/` 是 Vite root，`publicDir: false`，`base: /app/`，只输出 `public/app/`。`tools/build-ui.mjs` 先严格类型检查，再 Vite build。入口引用外部 bundle/CSS，不使用内联 JS、CDN、远程字体或 Vite 生产服务。

App 包裹 `<CSPProvider disableStyleElements>`。Base UI 禁止插入动态 style 元素；滚动条隐藏类写入本地 CSS，浮层定位保留组件所需的 DOM style 属性。此适配不修改服务端原有 CSP。jsdom 仅验证行为；最终 EXE 的独立 100% / 125% / 150% 进程各通过 57 项实际 Chromium 检查，CSP / 控制台 / 渲染器错误为 0。Select 定位、Sheet 焦点、Esc 与焦点返回、Toast 和窗口几何由实际操作验证。375px 名义窗口在后两种 DPI 的真实宽度为 374px，768 / 1024 / 1440px 则精确；报告保留 requested / actual / DPR 和原生采样，不将 jsdom 或标注尺寸当作实际窗口证明。详见 `docs/UI-ACCEPTANCE.md`。

Toast Content 的高度类由 `h-full` 改为 `h-auto`，解决真实 125% 环境中的 ResizeObserver 高度反馈循环；保留原组件测量及错误监听。岗位详情完整显示当前 / 历史规则依据。工作台按准确版本恢复活跃任务，待提交启动请求跨页面继续、返回后先等待提交再读取，避免后台任务被遗漏。日志页签及诊断链接同步 hash，手动切换保留草稿。上述审查和实际 EXE 问题的定点 RED / GREEN 证据均记录在验收文档中。

## 技能检索依据

UI UX Pro Max 的本地 UX 检索 `desktop personal job workspace data table form error feedback navigation` 返回提交反馈、错误恢复、就近错误说明；实施为 busy→success/error、保留草稿、诊断入口与字段摘要。没有把营销落地页配色覆盖批准的桌面工作台设计。

官方来源：[shadcn CLI](https://ui.shadcn.com/docs/cli)、[components schema](https://ui.shadcn.com/schema.json)、[Base UI CSPProvider](https://base-ui.com/react/utils/csp-provider)、[Vite](https://vite.dev/guide/)、[React](https://react.dev/)、[Tailwind Vite](https://tailwindcss.com/docs/installation/using-vite)、[jsdom engines](https://github.com/jsdom/jsdom)、[Testing Library](https://testing-library.com/docs/react-testing-library/intro/)。组件由官方 `@shadcn` registry 生成，并由 `components.json` 选择 Base Nova。
