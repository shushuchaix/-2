# 公开招聘来源种子研究

核验日期：2026-10-10（Asia/Hong_Kong）。范围：7 个机构或平台的公开网站。用途：提供来源身份、栏目、正文、附件和投递证据样本，支持后续适配器测试。本报告没有实施目录扩容，也没有评审 Task 4。

研究遵循 Agent-Reach 的公开资料发现流程，并以官方页面和实际结构作判断。未读取简历、账号材料、浏览器会话；未登录、提交报名或调用付费模型。搜索结果只用于发现；无法直取的页面保留证据级别和限制。

## 1. 结论与现有目录核对

找到招聘栏目，不能证明现在仍在招。本次样本中的 6 份具体招聘公告均已超过报名截止时间；NCSS 尚未取得具体职位详情。因此，**本报告没有确认任何当前可投递岗位，也不把这些样本计入有效岗位数**。这不代表这些机构全部停止招聘，只描述所核验的公告。

2026-10-10T01:32:37Z 读取 `src/sources/catalog` 的四个公开配置文件：共 97 条（employers 46、platforms 11、public-notices 6、universities 34）。按下列机构名和域名检查，只有 NCSS 已存在生产目录。贵州民航集团已经出现在 `tools/pilot-recruitment-coverage.mjs` 的 `pilot-guizhou-airport`，应完善现有记录，避免再建一份。其余 5 个是候选入口，未写入生产配置。

| institutionName | channel | 招聘栏目 | 本次证据级别 | 具体公告状态 |
| --- | --- | --- | --- | --- |
| 国家大学生就业服务平台 | official_platform | [公开职位页](https://main.ncss.cn/student/jobs/index.html) | 网页工具可读取界面；列表为动态占位 | 未取得职位证据 |
| 贵州民航产业集团有限公司 | official_employer_announcements | [社会招聘](https://www.gz-gcac.com/srecruitment.html) / [校园招聘](https://www.gz-gcac.com/crecruitment.html) | 公告匿名 GET 200，静态 DOM 已核验 | 2026-07-09 截止 |
| 成都双流国际机场股份有限公司 | official_airport_announcements | [重要公告](https://www.cdairport.com/announcement.aspx?page=4&t=60) | 网页工具可读取栏目及正文 | 2026-04-01 截止 |
| 集信国控安评消防（茂名）有限公司 | official_group_announcements | [集团新闻公告](https://www.xyjiance.cn/news.asp) | 网页工具可读取精确公告正文 | 2026-07-01 前报名，已过期 |
| 连云港港口集团有限公司消防救援技术（咨询）服务分公司 | official_group_announcements | [人才招聘目录路径](https://www.lygport.com.cn/gb2312/renliziyuan/rencaizhaopin/) | 官方域名索引正文；直接打开失败 | 2026-05-30 截止 |
| 常州国际机场集团有限公司（常州机场发布渠道） | official_airport_announcements | [人事招聘](https://czjc.changzhou.gov.cn/class/KHBDKLPQ) | 网页工具可读取栏目及正文 | 样本 2026-04-21 截止 |
| 国泰应急产业集团有限公司 | official_employer_careers | [人才招聘](https://www.guotaigroup.com.cn/rlzy/rlzy.asp) | 官方域名索引正文；直接打开失败 | 样本 2018-12-21 截止 |

证据级别说明：只有贵州公告经过本机匿名 HTTP GET 核验；网页工具返回的正文可能来自缓存，不能等同于本机采集连通性验证。官方域名索引只能证明曾发布该内容，不能标记来源 `ready` 或近期采集成功。

## 2. 可复核的机构字段

### 2.1 国家大学生就业服务平台

- `institutionName`：国家大学生就业服务平台。
- `homepage`：[平台首页](https://www.ncss.cn/)。
- `listingUrl`、`evidenceUrl`：[公开职位列表](https://main.ncss.cn/student/jobs/index.html)。
- `channel`：`official_platform`；`checkedAt`：2026-10-10。
- 观察：公开页面显示职位、公告等检索类别和筛选项，岗位数量仍为占位符；没有取得消防、机场具体职位正文。页面署名教育部学生服务与素质发展中心。[公开页面](https://main.ncss.cn/student/jobs/index.html)
- 判断：优先验证现有 NCSS 适配器的公开列表接口、详情和实际投递跳转。网页界面可读不能作为“返回零岗位且完成”的证据。同平台高校子域名应按实际租户区别，避免把相同职位重复算作新增覆盖。
- 当前在招：**未知**；不根据平台总岗位量或页面存在推断个人可投递岗位。

### 2.2 贵州民航产业集团有限公司

- `institutionName`：贵州民航产业集团有限公司；样本岗位实际发布单位为贵州省支线机场管理有限公司，二者需分别保存。
- `homepage`：[集团官网](https://www.gz-gcac.com/)。
- `listingUrl`：[社会招聘](https://www.gz-gcac.com/srecruitment.html)；辅助入口：[校园招聘](https://www.gz-gcac.com/crecruitment.html)。
- `evidenceUrl`：[2026 年社会招聘公告](https://www.gz-gcac.com/content/details_182_28403.html)。
- `channel`：`official_employer_announcements`；`checkedAt`：2026-10-10T01:32:06.403Z。
- 观察：样本包含消防等多个岗位类别，具体条件在 XLSX 岗位表；报名截止 2026-07-09 17:00。官网指向另一域名上的招聘系统，需自行注册登录。[原公告](https://www.gz-gcac.com/content/details_182_28403.html)
- 判断：适合测试正文、外部报名地址和附件岗位表组合；不能把整份公告当成一个职位。社会招聘首页同时出现成绩及拟录用公示，需先判断公告阶段。[栏目](https://www.gz-gcac.com/srecruitment.html)
- 当前在招：**该样本已截止**。详情 DOM 见第 3 节。

### 2.3 成都双流国际机场股份有限公司

- `institutionName`：成都双流国际机场股份有限公司。
- `homepage`：[机场官网](https://www.cdairport.com/)。
- `listingUrl`：[重要公告](https://www.cdairport.com/announcement.aspx?page=4&t=60)。
- `evidenceUrl`：[2026 年度招聘简章](https://www.cdairport.com/news_detail.aspx?cid=6295&page=4&t=60)。
- `channel`：`official_airport_announcements`；`checkedAt`：2026-10-10。
- 观察：正文包含急救医生岗位、资格要求和报名方式，截止 2026-04-01 17:00；不是消防职位。栏目混合招聘、航班变化、合作伙伴招募等内容。[原公告](https://www.cdairport.com/news_detail.aspx?cid=6295&page=4&t=60)、[栏目](https://www.cdairport.com/announcement.aspx?page=4&t=60)
- 判断：适合检验“机场雇主”与“岗位方向”的区别，以及招聘、招商、合作招募的分类，防止相关单位的所有公告都进入岗位库。
- 当前在招：**该样本已截止**。报名页面或表单未打开、未提交。

### 2.4 集信国控安评消防（茂名）有限公司

- `institutionName`：集信国控安评消防（茂名）有限公司。
- `homepage`：[集团发布渠道](https://www.xyjiance.cn/)；未确认该子公司的独立官网。
- `listingUrl`：[集团新闻公告](https://www.xyjiance.cn/news.asp)。
- `evidenceUrl`：[2026-06-23 招聘简章](https://www.xyjiance.cn/newsDemo.asp?val=4504f00c15b568ca680bf7794e3a616512f383bf317358f64b1892f8c971163)。
- `channel`：`official_group_announcements`；`checkedAt`：2026-10-10。
- 观察：正文为一级消防工程师及资深消防设施操作员；前者要求一级注册消防工程师资格，后者要求维保方向中级证书及至少六年经历。正文要求在 2026-07-01 前报名。[原公告](https://www.xyjiance.cn/newsDemo.asp?val=4504f00c15b568ca680bf7794e3a616512f383bf317358f64b1892f8c971163)
- 投递证据：该精确公告仅说明发送至公司邮箱，没有列出明确招聘邮箱。页脚通用联系邮箱不能自动当作已核验的招聘邮箱。[报名段与页脚](https://www.xyjiance.cn/newsDemo.asp?val=4504f00c15b568ca680bf7794e3a616512f383bf317358f64b1892f8c971163)
- 判断：适合测试资格硬条件、缺失投递地址、集团与子公司身份归属。同一栏目多条标题都为“招聘简章”，不能仅按标题去重。
- 当前在招：**该样本已截止**。

### 2.5 连云港港口集团消防救援服务分公司

- `institutionName`：连云港港口集团有限公司消防救援技术（咨询）服务分公司。
- `homepage`：[集团官网](https://www.lygport.com.cn/)。
- `listingUrl`：[人才招聘目录路径](https://www.lygport.com.cn/gb2312/renliziyuan/rencaizhaopin/)；路径由官方公告层级确认，本次目录首页直接打开超时，尚不能确认其当前列表响应。
- `evidenceUrl`：[2026 年度招聘公告](https://www.lygport.com.cn/gb2312/renliziyuan/rencaizhaopin/1159.html)。
- `channel`：`official_group_announcements`；`checkedAt`：2026-10-10。
- 观察：官方域名索引中有完整公告，报名时间为 2026-05-24 至 05-30；具体岗位与专业在 DOC 岗位表。另两个 DOC 是报名及回避表单，不是岗位表。该页面直接打开失败，附件尚未下载解析。[官方公告索引对应原页](https://www.lygport.com.cn/gb2312/renliziyuan/rencaizhaopin/1159.html)
- 判断：优先验证 DOC 转换及附件用途分类；公告共同条件与岗位行证据应同时保留。不要从公司经营消防服务推断每一个招聘岗位都匹配消防专业。
- 当前在招：**索引中的该样本已截止**；近期页面连通性与岗位表详情仍待核验。

### 2.6 常州机场发布渠道

- `institutionName`：常州国际机场集团有限公司（网站名称：常州奔牛国际机场）。
- `homepage`：[机场官方网站](https://czjc.changzhou.gov.cn/)。
- `listingUrl`：[人事招聘](https://czjc.changzhou.gov.cn/class/KHBDKLPQ)。
- `evidenceUrl`：[2026-04-14 招聘工作人员简章](https://czjc.changzhou.gov.cn/html/czjc/2026/KHBDKLPQ_0414/45258.html)。
- `channel`：`official_airport_announcements`；`checkedAt`：2026-10-10。
- 观察：本次精确公告雇主为东部机场集团常州航空食品有限公司，岗位是厨师，截止 2026-04-21；附 DOCX 应聘表。网站发布单位和实际用人单位不同。[原公告](https://czjc.changzhou.gov.cn/html/czjc/2026/KHBDKLPQ_0414/45258.html)
- 历史消防样本：[2016 年消防车辆驾驶员招聘](https://czjc.changzhou.gov.cn/html/czjc/2016/KHBDKLPQ_0406/2654.html)写“招满即止”，未见本次仍在招证据。不能把长期可访问的历史公告当成持续开放岗位。
- 判断：适合测试实际雇主解析、DOCX 报名表与岗位附件的区别、无明确截止日期的历史岗位降级。
- 当前在招：**2026 样本已截止；历史消防样本未知**。

### 2.7 国泰应急产业集团有限公司

- `institutionName`：国泰应急产业集团有限公司。
- `homepage`：[集团官网](https://www.guotaigroup.com.cn/)。
- `listingUrl`、`evidenceUrl`：[人才招聘页面](https://www.guotaigroup.com.cn/rlzy/rlzy.asp)。
- `channel`：`official_employer_careers`；`checkedAt`：2026-10-10。
- 观察：官方域名索引有消防行业销售经理职位及资格、投递信息，但岗位发布时间为 2018-05-21、截止 2018-12-21。页面含大量企业文化内容，直接打开失败。[官方人才招聘原页](https://www.guotaigroup.com.cn/rlzy/rlzy.asp)
- 判断：作为过期识别和正文范围的反例；生产候选优先级应低于可直取、近期有新招聘批次的来源。消防行业销售与消防工程技术岗位应分开分类。
- 当前在招：**索引中的该样本已截止**；没有确认当前新岗位。

## 3. 贵州民航公告的实际 DOM 证据

### 3.1 本次匿名 GET

- 原 URL：[公开招聘公告](https://www.gz-gcac.com/content/details_182_28403.html)。
- 时间：2026-10-10T01:32:06.403Z；HTTP 200；`text/html;charset=UTF-8`；原响应 57,392 bytes。
- 本机默认网络环境先发生 DNS 解析失败；只对这一个固定公开 URL 使用已通过自动审批的网络执行。请求没有简历、求职画像、登录状态或任何表单内容。
- 只解析静态 HTML，没有执行网页脚本，没有进入报名系统。

### 3.2 观察到的节点

| 目的 | 实际节点/行为 | 测试意义 |
| --- | --- | --- |
| 招聘正文 | `.news_detial .news_de_con > .edit`，节点另有 `fnt_16` 类；文本约 4,856 字符 | `detial` 是官网实际拼写；不能按 `news-detail` 猜测 |
| 职位类别与报名时间 | 上述正文的 `p` 子节点 | 保留段落范围，隔离页眉、热门推荐与联系方式 |
| 报名地址 | 正文 `p` 内的纯文本 URL；本次未找到对应报名 `a[href]` | 只检查锚点会漏掉有效外部报名地址 |
| 岗位表附件 | `.news_de_con > .edit_down a[href]` | 附件区与正文 `.edit` 为同级；只遍历正文子树会漏掉 XLSX |

报名系统 URL：[官网正文指定系统](https://rlzy.gzairports.com:15600/zp.html#/channel/02)。**该系统未访问**。地址来源是公开公告中的报名段落，来源证据成立；目标系统连通性、职位列表与登录后功能尚未验证，不能据此承诺可直接投递。

岗位表链接：[官网 XLSX 岗位表](https://www.gz-gcac.com/upload/file/2026/07/02/938a4d82-de9d-419c-9d2f-0dd306f8cdc5.xlsx)。**附件未下载**，本次只核验其锚点位置、标题及地址。

核查时 pilot 模板中的 `article,.news_content,.news-detail,.content_detail` 不对应这个实际正文节点。这里只提供证据，模板修改与回归由实施任务处理。

### 3.3 最小研究资产

- `.cache/public-source-research/guizhou-airport-dom-metadata.json`：原 URL、时间、HTTP 元数据、祖先结构、短摘要、事实字段和岗位表锚点。
- `.cache/public-source-research/guizhou-airport-minimal-nodes.html`：真实祖先结构及三个极短段落摘录；其余正文明确标注省略。没有联系人、电话、候选人名单或完整原始 HTML。
- `.cache/public-source-research/inspect-guizhou-public-dom.mjs`：单页匿名静态 DOM 研究脚本；不属于产品代码，不进行队列采集或报名操作。

这些资产用于结构回归。最小 HTML 已删减内容，不能冒充原页面完整快照，也不能用于岗位条件解析准确率验收。

## 4. 对项目有用的测试组合

以下是根据本次证据作出的工程判断，尚不是实际采集收益结论：

1. **贵州：正文节点 + 纯文本报名 URL + 同级 XLSX。** 比单独放大请求量更能检验详情完整度；应分别报告正文提取、附件发现、岗位行解析和投递地址证据。
2. **集信：资格硬条件 + 投递未知 + 同名公告。** 消防关键词不能替代注册资格、证书方向和经历核验；集团名和子公司名不可混用，通用联系邮箱不可默认当招聘邮箱。
3. **连云港：DOC 岗位表 + 两种报名表。** 岗位附件与应聘资料模板应分类；附件尚未解析时，岗位条件保留未知，不能把公告标题转成“可投递”的单岗位。
4. **双流与常州：机场来源 + 不相关职位。** 除机构方向外还要检查岗位类别及实际用人单位。旅客意见表中的“立即提交”不是招聘投递入口。
5. **所有来源：截止日期优先、公告阶段与日期冲突保留。** 贵州另有 [2025 年社会招聘公告](https://www.gz-gcac.com/content/details_182_28303.html)，页面日期呈现 2026-10-01，但正文报名截止为 2025-09-12；应保留冲突证据，不能只按页面日期判新鲜。
6. **NCSS：列表契约与详情证据分别验收。** 动态占位页可访问、零结果、接口失败是三种不同状态；平台来源和原始发布方证据共同保存。不要用增加同平台域名数量掩盖重复岗位。

建议以“每 100 次请求新增的有效、不重复、证据完整岗位”比较扩源收益；并列记录请求失败、过期、资格不符、正文缺失、附件未解析、投递未知。旧公告是必要反例，不计入新增有效岗位指标。

## 5. 限制与交接

本次只核验公开栏目和有限公告，未遍历全部分页，未解析附件，未运行真实简历匹配，未检查登录后的招聘系统。无当前在招验收结果，无付费调用、报名提交或产品配置变更。

优先交接贵州的实际 DOM、集信的严格资格与缺投递证据、连云港的附件用途区分。各来源启用前仍需在应用 HTTP 客户端中通过有限公开探针，保留失败原因；不能把索引存在、栏目可见或配置 `ready` 当成近期采集成功。
