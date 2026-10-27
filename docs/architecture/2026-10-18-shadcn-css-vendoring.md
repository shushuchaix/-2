# shadcn CSS 的本地保留与 CLI 依赖隔离

2026-10-18 核对发现，`ui/src/styles.css` 确实通过 `shadcn/tailwind.css` 直接使用 shadcn 的样式资源。仅搜索 JavaScript / TypeScript 的 import 会漏掉这个依赖，不能据此直接卸载包。

为保留现有样式，当前将 `shadcn@4.21.4` 已安装发行包中的 `dist/tailwind.css` 完整复制到 `ui/src/vendor/shadcn/tailwind.css`，并将 styles.css 中这一处导入改为本地相对路径。CSS 内容、选择器、主题、组件及 `ui/components.json` 均不需要重写。

## 出处与许可

- 包版本：`shadcn@4.21.4`。
- 官方包元数据：[npm registry shadcn 4.21.4](https://registry.npmjs.org/shadcn/4.21.4)。本次读取 HTTP 200；license 为 MIT，dist integrity 与原锁文件一致。
- 发行包：[官方 tarball](https://registry.npmjs.org/shadcn/-/shadcn-4.21.4.tgz)。本次使用既有安装文件，没有重新下载或执行包。
- 上游：[shadcn-ui/ui 的 packages/shadcn](https://github.com/shadcn-ui/ui/tree/main/packages/shadcn)。此链接用于定位项目，当前复制版本以 npm 4.21.4 元数据和本地精确摘要为准。
- CSS 原路径：`node_modules/shadcn/dist/tailwind.css`，16,340 字节。
- CSS SHA-256：`4c371f7a1ff5d219ae2f7ff28bd256b4346fd546fe46fbae22092e57db2f0fae`。
- 许可证原路径：`node_modules/shadcn/LICENSE.md`，1,063 字节。
- 许可证 SHA-256：`1564074e13439397221ffd522e2e504d56561994a23d371aa5e3ad43e4f5423f`。
- 原 MIT 许可证和版权声明完整保存在 `ui/src/vendor/shadcn/LICENSE.md`，未改动文字或行尾。

把 CSS 留在本地允许运行界面继续使用同一份资源，同时避免仅为样式在构建依赖中保留整套 CLI 工具链。项目已有 shadcn 组件源码、配置和用户级技能能力继续可用；以后若需要生成新组件，应按技能要求明确调用 CLI，并单独复核新增依赖与样式变更。

## 核验要求

修改前后都使用项目既有的 `tools/build-ui.mjs`，其中包括 TypeScript 检查和正式 Vite 构建。对实际输出 CSS 做逐字节摘要比较；同时对保留的 52 个生产依赖的已安装 package.json 与锁文件节点做前后核对。依赖整理后的官方 npm audit 结果属于具体时间点的已知公告匹配，不能宣称上游漏洞已修复。

公开仓库保留精确版本、上述 SHA-256、完整 MIT 许可证和锁文件，可据此核对来源。使用 `npm ci --ignore-scripts` 与 `npm run build:ui` 可复核干净安装及界面构建；`npm audit` 只反映执行当时的已知公告匹配。构建通过或审计没有匹配项，都不代表未来没有漏洞。
