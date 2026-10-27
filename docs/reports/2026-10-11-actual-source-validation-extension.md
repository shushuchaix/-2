# 原活动追加公开实测核对

观察日期：2026-10-11。此报告追加新证据，原98来源最终报告与历史账本保留。真实简历仅用于本地规则；公开读取采用固定来源入口/种子、空画像和固定职业词，无全局账号会话。

## 预算与已测范围

用户追加300请求、100详情，总字节上限300MiB，正常adjustLimits一次修改同活动691请求/187详情/314572800字节；模型原根6.13元、附件10份不增加。连历史累计上限780请求、220详情、模型9.999184元。

| 指标 | 当前原根 | 加历史累计 |
| --- | ---: | ---: |
| 请求上界 | 447/691 | 536/780 |
| 已确认 / 未知请求上界 | 322/125 | 历史89未拆分 |
| 详情credit | 42/187 | 75/220 |
| 字节 | 124632576/314572800 | 历史字节独立保留 |
| 附件credit | 3/10 | 剩7份 |
| 模型请求 / 费用上界 | 29 / 0.119426元 | 3.988610元 |

原47条template_missing为配置状态，追加固定公开入口请求尝试提交47/47，尚未提交0条。固定47范围入口请求尝试已完成；正文与投递补证仍分开记录。 状态计数：{"failed":32,"blocked":3,"body_selector_unverified":1,"no_recruitment_list_evidence":10,"entry_recruitment_links_sampled":1}。模板阶段从原根299请求为基线，持久上限220，不重置；基线之后公众号/微博请求也保守计入这道阶段守卫；每批最多3站、每站最多5次公开HTTP采样、20秒、0重试、1MiB。DNS和重定向分别按真实物理预约计数，失败/未知不退额度。possibleJavaScriptShell只是静态HTML的推测，不能证明有效空列表。

## 正文与有效推荐

按稳定身份保留545条，本版本正文核验37条、已核实在招0条、可用投递0条；资格通过/未知/不符为3/413/129。疑似语义重复206条保留复核。正文、在招、投递、资格四项同时通过的有效新增为0。追加读取为只读证据采样，不把公告条数、招聘相关链接或候选入口算成可投递岗位。

资格通过旧3条中，Tencent真实详情请求超时（3物理预约，其中2known/1unknown，API变化未被证实）；牛客正常核验0网络仍约21秒属于本地准备/读写耗时，其单独公开页请求另超时。就业桥正文核验成功，但在招/投递仍未知；其独立公开页旧harness将DNS ABORT_ERR误标caller取消，原exit1和原码保留，后续分类已纠正且没有退回预约或重发该页。30秒NCSS补样实际HTTP200、仍detail_insufficient，不算空或正文成功；本次失败后原HTML/parser字段未捕获，不能倒推字段值，未为补字段再发旧候选。原首轮NCSS正文1保留，原追加5份正文0（4超时/1字节阻断）也保留。

温州已保存的两个真实200样本经离线官方adapter重放：正文624字、发布时间2024-08-15，列表1条；正文规则td.wz、列表.bg_c a[href]。这是酒店招聘历史公告，没有观察当前期限或在线报名表，岗位雇主与发布集团归属未核验，ready仍false。旧body_selector_unverified记录保留并由单独离线说明补充。

## 修复后的公众号/微博追加复测

wechat：failed / collection_route_forbidden，1次公开HTTP调用，4个物理请求预约，正文未证实，readyfalse。；weibo：failed / content_non_json，1次公开HTTP调用，6个物理请求预约，正文未证实，readyfalse。 不使用浏览器、Python、全局session或登录cookie自动扩读；每provider最多2次公开HTTP调用。微博未知200非JSON HTML保持content_non_json，明确登录/风险与合法空列表分开。

## 原生进程证据

共保存24个本追加阶段原HandleWait退出记录。包括初始化前无日志的0x80000003失败、最初DNS误归因导致的evidence exit1，以及其后正常批次exit0；失败不会改写成成功。各原生退出和资源关闭记录见ignored日志，机器矩阵只公开退出码、句柄持有、进程退出、期限布尔。

## 98来源与新增观察矩阵

原始配置/观察与追加真实结果分列。此前parsed只证明取得记录。其余45个来源在追加阶段未重发，保留原样本，不声称全部98本阶段再联网成功。

| 来源 | provider | 原观察 | 追加实际观察 | 原因 | 追加请求上界 | 正文 |
| --- | --- | --- | --- | --- | ---: | --- |
| 西安电子科技大学 | university | parsed | 本追加阶段未重发 | — | — | 未测 |
| 东北大学秦皇岛分校 | university | parsed | 本追加阶段未重发 | — | — | 未测 |
| 大连海事大学 | university | parsed | 本追加阶段未重发 | — | — | 未测 |
| 山东财经大学 | university | parsed | 本追加阶段未重发 | — | — | 未测 |
| 浙江师范大学 | university | parsed | 本追加阶段未重发 | — | — | 未测 |
| 厦门大学 | university | parsed | 本追加阶段未重发 | — | — | 未测 |
| 郑州大学 | university | parsed | 本追加阶段未重发 | — | — | 未测 |
| 嘉兴大学 | university | blocked | 本追加阶段未重发 | — | — | 未测 |
| 中国民用航空飞行学院 | chenyun | failed | 本追加阶段未重发 | — | — | 未测 |
| 东南大学 | university-91job | parsed | 本追加阶段未重发 | — | — | 未测 |
| 河海大学 | university-91job | parsed | 本追加阶段未重发 | — | — | 未测 |
| 南京航空航天大学 | university-91job | parsed | 本追加阶段未重发 | — | — | 未测 |
| 南京理工大学 | university-91job | parsed | 本追加阶段未重发 | — | — | 未测 |
| 南京农业大学 | university-91job | parsed | 本追加阶段未重发 | — | — | 未测 |
| 南京师范大学 | university-91job | parsed | 本追加阶段未重发 | — | — | 未测 |
| 南京工业大学 | university-91job | parsed | 本追加阶段未重发 | — | — | 未测 |
| 南京邮电大学 | university-91job | parsed | 本追加阶段未重发 | — | — | 未测 |
| 南京信息工程大学 | university-91job | parsed | 本追加阶段未重发 | — | — | 未测 |
| 南京林业大学 | university-91job | parsed | 本追加阶段未重发 | — | — | 未测 |
| 中国药科大学 | university-91job | parsed | 本追加阶段未重发 | — | — | 未测 |
| 南京医科大学 | university-91job | failed | 本追加阶段未重发 | — | — | 未测 |
| 南京中医药大学 | university-91job | failed | 本追加阶段未重发 | — | — | 未测 |
| 南京财经大学 | university-91job | failed | 本追加阶段未重发 | — | — | 未测 |
| 南京审计大学 | university-91job | failed | 本追加阶段未重发 | — | — | 未测 |
| 苏州大学 | university-91job | failed | 本追加阶段未重发 | — | — | 未测 |
| 常州大学 | university-91job | failed | 本追加阶段未重发 | — | — | 未测 |
| 江南大学 | university-91job | failed | 本追加阶段未重发 | — | — | 未测 |
| 江苏大学 | university-91job | failed | 本追加阶段未重发 | — | — | 未测 |
| 扬州大学 | university-91job | parsed | 本追加阶段未重发 | — | — | 未测 |
| 南京大学 | official-announcements | blocked（配置缺模板） | no_recruitment_list_evidence | — | 3 | 未测 |
| 中国人民警察大学 | official-announcements | blocked（配置缺模板） | failed | extension_failed | 2 | 未测 |
| 河南理工大学 | official-announcements | blocked（配置缺模板） | entry_recruitment_links_sampled | — | 3 | 未测 |
| 西安科技大学 | official-announcements | blocked（配置缺模板） | failed | request_timeout | 3 | 未测 |
| 中国矿业大学 | university-91job | failed | 本追加阶段未重发 | — | — | 未测 |
| 腾讯 | tencent | parsed | 正常核验:failed | request_timeout | 3 | 未证实 |
| 博世 | smartrecruiters | parsed | 本追加阶段未重发 | — | — | 未测 |
| 华为 | official-announcements | blocked（配置缺模板） | no_recruitment_list_evidence | — | 3 | 未测 |
| 小米 | official-announcements | blocked（配置缺模板） | failed | ECONNRESET | 2 | 未测 |
| 阿里巴巴 | official-announcements | blocked（配置缺模板） | no_recruitment_list_evidence | — | 3 | 未测 |
| 字节跳动 | official-announcements | blocked（配置缺模板） | failed | public_http_404 | 3 | 未测 |
| 美团 | official-announcements | blocked（配置缺模板） | no_recruitment_list_evidence | — | 3 | 未测 |
| 中国银行 | official-announcements | blocked（配置缺模板） | failed | ECONNRESET | 3 | 未测 |
| 西门子 | official-announcements | blocked（配置缺模板） | failed | ECONNRESET | 2 | 未测 |
| 人民教育出版社 | official-announcements | blocked（配置缺模板） | failed | ABORT_ERR | 2 | 未测 |
| Canonical | greenhouse | failed | 本追加阶段未重发 | — | — | 未测 |
| 浙江省机场集团有限公司 | official-announcements | blocked（配置缺模板） | failed | request_timeout | 4 | 未测 |
| 首都机场集团有限公司 | official-announcements | blocked（配置缺模板） | failed | ABORT_ERR | 2 | 未测 |
| 上海机场（集团）有限公司 | official-announcements | blocked（配置缺模板） | blocked | restricted | 3 | 未测 |
| 安徽民航机场集团有限公司 | official-announcements | blocked（配置缺模板） | failed | ABORT_ERR | 2 | 未测 |
| 西部机场集团有限公司 | official-announcements | blocked（配置缺模板） | failed | public_http_502 | 3 | 未测 |
| 深圳市机场（集团）有限公司 | official-announcements | blocked（配置缺模板） | failed | ABORT_ERR | 2 | 未测 |
| 河北机场管理集团有限公司 | official-announcements | blocked（配置缺模板） | no_recruitment_list_evidence | — | 3 | 未测 |
| 吉林省民航机场集团有限公司 | official-announcements | blocked（配置缺模板） | failed | extension_failed | 2 | 未测 |
| 黑龙江省机场管理集团有限公司 | official-announcements | blocked（配置缺模板） | failed | public_http_412 | 3 | 未测 |
| 杭州萧山国际机场有限公司 | official-announcements | blocked（配置缺模板） | failed | ABORT_ERR | 2 | 未测 |
| 宁波机场集团有限公司 | official-announcements | blocked（配置缺模板） | failed | request_timeout | 3 | 未测 |
| 温州机场集团有限公司 | official-announcements | blocked（配置缺模板） | body_selector_unverified | — | 4 | 未测 |
| 北京首都国际机场股份有限公司 | official-announcements | blocked（配置缺模板） | failed | ECONNRESET | 2 | 未测 |
| 北京大兴国际机场 | official-announcements | blocked（配置缺模板） | no_recruitment_list_evidence | — | 3 | 未测 |
| 天津滨海国际机场 | official-announcements | blocked（配置缺模板） | failed | ECONNRESET | 3 | 未测 |
| 广州白云国际机场股份有限公司 | official-announcements | blocked（配置缺模板） | no_recruitment_list_evidence | — | 3 | 未测 |
| 北京博维航空设施管理有限公司 | official-announcements | blocked（配置缺模板） | failed | request_timeout | 3 | 未测 |
| 首都机场集团设备运维管理有限公司 | official-announcements | blocked（配置缺模板） | failed | ABORT_ERR | 2 | 未测 |
| 北京首都机场动力能源有限公司 | official-announcements | blocked（配置缺模板） | failed | ABORT_ERR | 2 | 未测 |
| 北京空港航空地面服务有限公司 | official-announcements | blocked（配置缺模板） | blocked | restricted | 3 | 未测 |
| 中国中安消防安全工程有限公司 | official-announcements | blocked（配置缺模板） | failed | CERT_HAS_EXPIRED | 3 | 未测 |
| 中安建设安装集团有限公司 | official-announcements | blocked（配置缺模板） | failed | request_timeout | 3 | 未测 |
| 上海盛安建设工程（集团）有限公司 | official-announcements | blocked（配置缺模板） | no_recruitment_list_evidence | — | 3 | 未测 |
| 威特龙消防安全集团股份公司 | official-announcements | blocked（配置缺模板） | failed | ABORT_ERR | 2 | 未测 |
| 四川威特龙消防技术服务有限公司 | official-announcements | blocked（配置缺模板） | failed | ERR_TLS_CERT_ALTNAME_INVALID | 3 | 未测 |
| 南京消防器材股份有限公司 | official-announcements | blocked（配置缺模板） | failed | ABORT_ERR | 2 | 未测 |
| 国安达股份有限公司 | official-announcements | blocked（配置缺模板） | failed | ABORT_ERR | 2 | 未测 |
| 海湾安全技术有限公司（GST） | official-announcements | blocked（配置缺模板） | failed | request_timeout | 3 | 未测 |
| 青鸟消防 | official-announcements | blocked（配置缺模板） | failed | request_timeout | 3 | 未测 |
| 泰和安（中消云·泰和安集团） | official-announcements | blocked（配置缺模板） | failed | request_timeout | 3 | 未测 |
| 四川久远智能消防设备有限责任公司 | official-announcements | blocked（配置缺模板） | failed | request_timeout | 2 | 未测 |
| 北京利达华信电子股份有限公司 | official-announcements | blocked（配置缺模板） | blocked | restricted | 3 | 未测 |
| 深圳市赋安安全系统有限公司 | official-announcements | blocked（配置缺模板） | failed | CERT_HAS_EXPIRED | 3 | 未测 |
| 中集天达控股有限公司 | official-announcements | blocked（配置缺模板） | no_recruitment_list_evidence | — | 4 | 未测 |
| 中建安装集团有限公司 | official-announcements | blocked（配置缺模板） | no_recruitment_list_evidence | — | 4 | 未测 |
| 贵州民航集团招聘公告 | official-announcements | parsed | 本追加阶段未重发 | — | — | 未测 |
| 中国科学院计算技术研究所 | official-announcements | failed | 本追加阶段未重发 | — | — | 未测 |
| 中国科学院软件研究所 | official-announcements | blocked | 本追加阶段未重发 | — | — | 未测 |
| 中国科学院物理研究所 | official-announcements | parsed | 本追加阶段未重发 | — | — | 未测 |
| 中国科学院广州生物医药与健康研究院 | official-announcements | parsed | 本追加阶段未重发 | — | — | 未测 |
| 中国科学院文献情报中心 | official-announcements | parsed | 本追加阶段未重发 | — | — | 未测 |
| 中国科学院过程工程研究所 | official-announcements | blocked | 本追加阶段未重发 | — | — | 未测 |
| Boss直聘 | boss | blocked | 本追加阶段未重发 | — | — | 未测 |
| 智联招聘 | zhaopin | parsed | 本追加阶段未重发 | — | — | 未测 |
| 实习僧 | shixiseng | parsed | 本追加阶段未重发 | — | — | 未测 |
| 牛客校招 | nowcoder | parsed | 正常核验:completed；公开正文补样:failed | request_timeout | 3 | 未通过 |
| 就业桥 | jiuyeqiao | parsed | 正常核验:completed；公开正文补样:failed | request_cancelled | 5 | 通过 |
| 国家大学生就业服务平台 | ncss | parsed | 正文补样:failed | detail_insufficient | 3 | 未证实 |
| 应届生截止日期榜 | yingjiesheng | parsed | 本追加阶段未重发 | — | — | 未测 |
| 全网搜索 | searchapi | blocked | 本追加阶段未重发 | — | — | 未测 |
| 微信公众号线索 | wechat | parsed | failed | collection_route_forbidden | 4 | 未测 |
| 微博招聘线索 | weibo | failed | failed | content_non_json | 6 | 未测 |
| 抖音招聘线索 | douyin | blocked | 本追加阶段未重发 | — | — | 未测 |

机器矩阵：[追加矩阵](2026-10-11-actual-source-validation-extension-matrix.json)。原报告：[98来源原阶段](2026-10-11-actual-source-validation-final.md)。公共报告不包含简历、私人词、联系方式、凭据、私人路径、网络正文或职位正文。

## 入口覆盖与已保存响应补证

提交47/47指固定来源入口请求尝试，已保存HTTP响应19个来源、观察到200响应13个来源。正文契约现场通过0个，离线真实响应正文通过1个，候选保存0个；入口只读阶段自动保存未读后续链接涉及1个来源，仍待单独正文与投递补证。入口相关链接不等于已读正文，DNS阶段失败也不等于访问了平台空列表。

吉林与中国人民警察大学的extension_failed保留原码；已有诊断精确定位DNS解析返回非零Status的Error（DNS分别约8.5秒/8.7秒、transport0，各2known/0unknown），未观察目标站HTTP。此结论来自保存的调用位置，不是重新联网推断。

公众号后续修复使用已保存真实200响应，通过正常contentReadService离线重放：0联网、0模型、0详情credit，challenge_required、正文null、图片0、外链0，不返回挑战query。原在线collection_route_forbidden和退出记录保留；离线回放证明已保存挑战响应的修复分类，不表示二次联网成功。

## 3个未读招聘入口的单独补证

已提交3/3，逻辑读取3/7；列表契约1、正文1、投递页实读0、候选保存1，ready仍0。 此阶段保留47条入口原记录，使用同基线299/上限220守卫；失败URL及已提交候选不重发。岗位实际雇主与来源发布机构分别核验，缺少雇主或发布者证据不回填机场集团名。正文解析通过正常官方适配器的缓存重放，原根详情credit照常预约，解析不能追加未缓存联网。

| 来源 | 补证状态 | 原因 | 列表契约 | 正文 | 在招 | 投递 | 请求上界 |
| --- | --- | --- | --- | --- | --- | --- | ---: |
| 浙江省机场集团有限公司 | evidence_incomplete | followup_url_scope | 通过 | 通过 | unknown | unknown | 3 |
| 河北机场管理集团有限公司 | failed | ECONNRESET | 未证实 | 未证实 | unknown | unknown | 3 |
| 中集天达控股有限公司 | failed | request_timeout | 未证实 | 未证实 | unknown | unknown | 3 |

浙江追加公告修复前存档的正常适配器正文1280字，发布机构与实际雇主分别确认；可见列表日期2026-08-26，正常record未取得发布日期/截止日期，故在招仍unknown。正文有2个公开附件，其中被选为applyUrl的链接也是DOCX登记表附件；已保存HTML未观察在线form，未下载附件或发起额外外域请求，投递仍unknown，readyfalse。该只读候选正文不计入现有545条岗位的正文37条。

## 已保存浙江正文的解析修复复查

固定已保存的公开响应经正常官方适配器缓存重放，0联网、0模型、0详情credit。条件解析版本conditions-4识别显式报名期限为2026年9月1日结束（北京时间），观察日已过期，opening为expired；DOCX登记表保留在2份附件中，applyUrl为null，公开网页投递候选证据0。泛化材料清单不再产生法律职业资格硬条件；真实持有/须取得条件和手工/结构化条件继续保留。正文仍1280字，readyfalse。原现场unknown及补证状态原行保留，新增离线修正不表示重发网络或重新在招，也不将只读候选并入545条岗位。

## 原活动缓存岗位最终本地规则重评

状态completed，选择545条、完成545条，新评估545条、复用0条，重评前旧解析/规则版本评估758条；不刷新网络岗位事实或新增岗位身份。实际请求/详情/附件/模型/费用增量为{"requestDelta":0,"detailCreditDelta":0,"attachmentCreditDelta":0,"modelRequestDelta":0,"costUpperBoundDelta":0}，最终四项证据与资格统计以上方当前本版本质量结果为准。
