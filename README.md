# 简历岗位雷达 v2 · 个人求职工作台

把简历、招聘证据、检索目标和投递进度保存在同一工作区。面向个人长期使用，Web、Windows 桌面和 CLI 共用应用服务。

## 日常流程

1. 在「简历与目标」粘贴文本或上传 PDF / DOCX / TXT / MD，查看提取警告，校正事实后保存画像版本。
2. 保存检索目标：岗位方向、城市、届别、岗位类型、学历资格、来源和预算。城市支持不限、采用画像、指定城市。
3. 在「工作台」更新招聘来源。没有模型密钥时使用规则模式；部分来源失败仍保留已取得的记录与原因。
4. 在「岗位库」查看原文、资格证据、匹配分项和来源日期。岗位、公告、公司招聘窗口分别展示；匹配分用于排序。
5. 在「投递进度」记录状态、备注、使用的简历版本和跟进日期，在设置页导出或备份。

修改简历或目标会生成新版本；已有岗位可以重新评分，人工投递记录独立保留。关闭浏览器不会取消后台任务，重新打开可继续查看进度。

PDF导入需要可提取的文字层。图片型/扫描件PDF会明确提示没有文字；本版未提供OCR。可上传文字版PDF、DOCX或TXT，或先清除已选文件再粘贴简历正文。

## 启动

要求 Node.js 20 或更高版本。

```powershell
npm ci --ignore-scripts
npm start
```

访问终端显示的本机地址。也可使用 `start.cmd`。首次使用不需要模型密钥。

Windows 便携版位于 `dist/简历岗位雷达-win32-x64/简历岗位雷达.exe`，整个目录一起移动。源码开发及打包：

```powershell
node tools/fetch-electron.mjs
npm run desktop
npm run dist:desktop
npm run verify:package
```

下载器核验 Electron 官方 SHA-256。桌面 renderer 保持 sandbox、contextIsolation 和禁止 Node 集成。设置页可通过系统加密保存、清除模型密钥；系统加密不可用时明确拒绝保存。

## 数据与升级

- Web / CLI 默认使用项目 `data/`；`RJR_DATA_DIR` 可指定另一可写目录。
- 桌面使用用户可写目录，可从「文件 → 打开数据目录」查看。
- `workspace.v2.json` 保存岗位、观察、评价、画像、目标与人工记录；`runs-v2/` 保存不可变运行快照。
- v1 `job-index.json` 和 `runs/*.json` 首次启动前自动备份后迁移；原文件保留。损坏文件或不支持的版本会报告错误，不静默清空。
- 设置页的业务备份包含个人资料，应按个人文件保存。密钥、会话和系统加密文件独立于业务备份。

详细步骤与回退语义见 [v2 升级指南](docs/v2-upgrade-guide.md)。本次验证见 [发布报告](docs/reports/2026-10-05-v2-release-verification.md)。

## 招聘渠道

本版保留八类旧来源适配器，并增加国家平台、高校、企业公开职位接口、研究机构公告和社交线索通道。

2026-10-05 实际探针取得 **6 个新增直连适配器、4 类渠道、30 个有效站点**：20 个 91job 高校、NCSS、腾讯、博世、Canonical 和 6 个研究机构公告站。只表示本次能够读到 ID、标题、URL 与要求正文，未来可能变化；候选目录与已接通站点分别显示。

目录包含 30 所高校 / 4 类就业系统、11 家企业、6 个公共公告站点及平台目录。旧来源或候选目录不能凭数量认定可用；使用设置页的单源检查查看实际状态。来源可能返回可用、空结果、访问受限、不可用或解析错误。详见 [来源验收报告](docs/reports/2026-10-05-source-readiness.md)。

### 微信公众号、微博、抖音

可以成为招聘线索来源。已配置搜索 API 时发现公开 URL；在「导入招聘线索」保存账号、链接和用户提供的正文，按公告展示。正文足够且模型可用时可抽取有原文支持的具体岗位，并保留原公告。

本次没有验证成功的三平台直接自动采集通道。需要登录、平台权限或授权接口的内容保留明确状态；搜索摘要和人工导入不计入直连来源验收。Scrapling 用于公开页面研究，已禁止路径没有正文采集。依据与限制见 [社交来源研究](docs/reports/2026-10-05-social-sources.md)。

## 模型、搜索和预算

规则模式无需密钥。模型辅助提供分项解释，模型输出必须引用真实原文；资格硬门槛失败不能被模型高分覆盖。缺失事实保持待核实。模型质量尚未做带真实密钥的人工评测，不能据此承诺精排效果。

Web 临时模型密钥只用于本次任务；不写浏览器存储、历史结果或导出。服务端可用 `DEEPSEEK_API_KEY` 配置密钥；配置文件与环境变量须自行妥善保存。搜索 API 可配置 Tavily、博查或 Serper，具体字段见 `config.example.json`。

| 预算                                 | 标准 | 广泛 |
| ------------------------------------ | ---: | ---: |
| 站点                                 |   12 |   24 |
| 来源请求（含重试、重定向与安全解析） |  120 |  240 |
| 关键词                               |    6 |    6 |
| 每查询页数                           |    2 |    2 |
| 详情                                 |   20 |   20 |

每任务模型最多 20 次 HTTP 尝试（含格式修复与重试），每次最多 4000 输出 tokens。没有配置价格时只显示调用和 token 数。

## CLI 与旧参数

```powershell
node src/cli.mjs --resume tools/sample-resume.txt --no-llm --format json
node src/cli.mjs tools/sample-resume.txt --cities "北京，上海" --keywords "Java，SQL" --year 2027 --no-intern --format csv --out results.csv
node src/cli.mjs targets list
node src/cli.mjs runs start --target TARGET_ID --rules
node src/cli.mjs runs show RUN_ID
node src/cli.mjs applications set JOB_ID --status applied --note "三天后跟进"
node src/cli.mjs sources probe ncss --site ncss
```

保留 `--resume` / 位置文件、`--text`、`--cities`、`--keywords`、`--year`、`--no-intern`、`--all-years`、`--format`、`--out`、`--no-llm`、`--top`。无 `--out` 时结果输出 stdout，日志写 stderr；旧 v1 HTTP API 保留兼容入口。

## 验证与来源探针

```powershell
npm run test:offline
npm run e2e
npm run audit
npm audit
npm run verify:package
```

离线测试用独立数据目录和零公网连接保护，含迁移、恢复与完整业务流程。实际打包后单独验证产物；CI 不以不存在的产物冒充通过。

显式联网检查：

```powershell
node tools/probe-sources-v2.mjs --report .cache/source-readiness.md
node tools/verify-source-catalog.mjs --live
node tools/run-e2e.mjs --live tools/sample-resume.txt
```

`e2e` 默认跑合成流程；`--live` 才采集公网，`--llm` 才在该演练中启用模型。默认 live 演练输出写独立 `.cache/e2e-live-*` 目录。

## 分享与部署

[部署指南](deploy/部署指南.md) 支持 Docker / Node + HTTPS。公网启动需要口令保护，流式反代需同时覆盖 v1 与 v2 事件路径。

**当前是单共享工作区。所有登录者看到同一份简历和投递记录，没有多人资料隔离。** 分享给他人试用时应使用独立 `RJR_DATA_DIR` 和合成资料；个人真实工作区建议在本机运行。

## 项目结构

| 目录                                  | 内容                                         |
| ------------------------------------- | -------------------------------------------- |
| `src/domain/`                         | 身份、技能、资格、排序等纯业务规则           |
| `src/application/`                    | 画像、目标、岗位、投递、任务、来源、导出服务 |
| `src/infrastructure/`                 | 文件事务、锁、迁移、备份、公共网络请求保护   |
| `src/sources/`                        | 适配器、目录、覆盖规划                       |
| `src/server/`                         | v1/v2 HTTP 边界与可重连事件流                |
| `public/js/` / `public/styles/`       | 五页原生模块界面                             |
| `electron/`                           | 桌面主进程、安全 preload 和加密凭据          |
| `tests/` / `evals/`                   | 合成测试和匹配基线                           |
| `docs/superpowers/` / `docs/reports/` | 已批准设计、计划与验证证据                   |

招聘正文与个人记录会存入本地工作区用于持续比较。请核对招聘原文、发布日期、投递渠道与截止时间；自动采集只访问允许的公开接口，受限内容使用授权接口或人工提供材料。
