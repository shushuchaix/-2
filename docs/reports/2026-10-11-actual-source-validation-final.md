# 全98来源实测最终核对

来源观察日期：2026-10-10；恢复核验：2026-10-11。沿用已批准的唯一真实根活动、同一目标版本和原账本。真实简历仅用于本地 rules；网络查询为固定公开职业词。

**快照范围：** 下列98来源矩阵和用量保留追加额度前的观察。2026-10-11用户又批准同一活动追加300次公开请求、100次详情及总300MiB；已通过正式调整接口保存，原根上限变为691请求、187详情、300MiB，累计上限780请求、220详情。模型累计仍不超过10元、附件10份上限不变，原账本与未知消耗保留。新增正文核验和公告模板证据另行记录，不改写本快照为线上成功。

## 当前证据与预算

活动已暂停，保留全部已提交页和未知消耗。原根追加300请求/40详情后，上限为391请求、87详情、6.13元；连同历史89请求、33详情、3.869184元，累计上限480请求、120详情，模型费用最高9.999184元，低于用户10元总上限。附件仍为原10份/总100MiB，上限未增加。

| 指标 | 原根当前 | 历史加原根累计 |
| --- | ---: | ---: |
| 请求消耗上界 | 285 / 391 | 374 / 480 |
| 已核实请求 / 未知请求上界 | 202 / 83 | 历史未细分 |
| 详情 credit | 38 / 87 | 71 / 120 |
| 模型调用 | 29 | 历史调用数未在此报告重新测量 |
| 模型费用上界（元） | 0.119426 / 6.13 | 3.988610 / 10 |
| 附件 credit | 3 / 10 | 原根10份上限未增加 |
| 字节消耗 | 104385089 / 104857600 | 历史字节不转移、不清零 |

原根尚余106请求、49详情、7附件credit，但总字节仅余472511。浏览器一次需要20MiB预约，1MiB详情也无法再按该预约通过；因此剩余请求与费用不构成继续这些读取的许可。失败和不确定预约均保留上界，没有退回、重置或建立第二活动/后端。

## 本版本四项推荐门槛

| 本版本事实投影 | 数量 |
| --- | ---: |
| 按稳定身份去重后保留的本版本记录 | 545 |
| 正文核验通过 | 37 |
| 已核实当前在招 | 0 |
| 已核实可用投递入口 | 0 |
| 资格通过 / 未知 / 不符 | 3 / 413 / 129 |
| 历史或已过期 | 6 |
| 疑似重复 | 206 |
| 正文、在招、投递、资格四项同时通过的有效新增 | 0 |

545条是按稳定身份去重后保留的岗位、公告与待核实记录，不能称为545个可投递岗位或完全没有语义重复。206条疑似重复是启发式相似关系涉及的记录数，保留待人工复核，没有自动删除。545条均完成本地规则核验（核验前发现213份旧规则版本记录；本次545份结果均通过当前规则版本校验，结果ID沿用545个，核验问题0），本阶段网络、详情、附件、模型和费用增量全为0。质量投影按当前版本事实重算；逐站采样计数是当页快照，不能相加替代当前投影。召回率、人工总体准确率和误合并率仍未测量。

## 全98行覆盖和实际阻断

当前观察状态为parsed32、failed13、blocked53；其中16个parsed继承首批已提交页，本轮already_committed跳过，未重发。后续矩阵本身为parsed16、failed13、skipped16、blocked53，不能称作98站均联网成功。47站缺公告模板、Boss1站缺本版本首次登录、2站外部费用未核实，均不算空结果。嘉兴大学HTTP200后缺已验证原始空列表证据，保持empty_evidence_unverified。两份公开公告详情在总字节预约耗尽后仍保留已取得记录/正文与阻断码。

NCSS首轮代表详情已核验正文1份，矩阵保留此采样证据。随后追加5份详情：4份超时、1份字节额度阻断，追加正文通过0；这不抹去先前已核验的1份正文。原代码23原样保留并按TimeoutError证据解释为request_timeout，不能算空或成功。该字节阻断的账本budgetKind为attachments，它覆盖字节预约，并不意味着已用完10份附件credit。微博原实测HTTP200非JSON的parse_error保持原证据；新代码将其呈为content_non_json，仅明确登录HTML呈login_required、已知challenge呈风险。修复后未重发微博请求，不声称线上已经通过。

## 公开模型拆岗

24份合成黄金样本的真实模型结果为24/24，通过结构与字段断言，危险误推荐0；这仅代表样本集。另1份贵州公开公告已做过模型处理，no_job、费用0.002514元，其附件材料不变成可推荐岗位。随后完整公开雇主正文以空画像{}拆分最多4份：2份完成并入库10个独立岗位，全部资格不符；2份因public_positions_unverified过滤、入库0。该4份增量4模型调用、0.062738元、网络0。全部共用原根模型账本；无真实简历或私人画像进入模型载荷。

## 原生进程证据和修复

原98行remaining阶段曾原生退出1，HTTP取消时DNS/账本await后形成孤立Promise拒绝；原失败日志保留。窄复现证明取消后不发transport且不释放未知预约，已修复。后续bodies原HandleWait已核实退出0/持有原handle/资源关闭失败0。public保存日志证明completed、资源关闭失败0、已无进程，但本次恢复没有原退出码证据，故记为未独立核实且未为补证重跑模型。rules本次隐藏Electron原HandleWait明确退出0、原handle持有true、进程已退出true、资源关闭失败0，stderr长度0。

新增浏览器onCompleted按原请求id确认一次物理请求，重复事件幂等；重定向各物理跳转仍独立预约，前序未证实跳转保留上界。错误请求不退预约，字节独立结算。暂停状态岗位核验改走withDiagnosticContext，继续使用原scope、lease、token、cancel与终态拒绝。该核验回归仅用合成资料，不补发真实活动请求。

## 98来源矩阵

请求列为首批/后续列表及代表详情请求；额外NCSS正文14次请求、5详情以及公开拆岗另列上文。parsed只证明取得记录；正文与有效列为所选批次采样快照，详细分阶段字段及初始/后续状态见机器矩阵。

| 来源 | provider | 最新观察状态 | 原因 | 请求 首批/后续 | 新记录采样 | 正文采样 | 有效采样 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| 西安电子科技大学 | university | parsed（首批） | source_validation_failed | 5 / 0 | 23 | 0 | 0 |
| 东北大学秦皇岛分校 | university | parsed（首批） | — | 5 / 0 | 3 | 1 | 0 |
| 大连海事大学 | university | parsed（首批） | — | 5 / 0 | 2 | 1 | 0 |
| 山东财经大学 | university | parsed（首批） | — | 10 / 0 | 12 | 1 | 0 |
| 浙江师范大学 | university | parsed（首批） | ECONNRESET | 5 / 0 | 2 | 0 | 0 |
| 厦门大学 | university | parsed（首批） | — | 5 / 0 | 1 | 1 | 0 |
| 郑州大学 | university | parsed（首批） | — | 5 / 0 | 3 | 1 | 0 |
| 嘉兴大学 | university | blocked | empty_evidence_unverified | 4 / 4 | 0 | 0 | 0 |
| 中国民用航空飞行学院 | chenyun | failed | unavailable | 3 / 3 | 0 | 0 | 0 |
| 东南大学 | university-91job | parsed（首批） | — | 4 / 0 | 7 | 1 | 0 |
| 河海大学 | university-91job | parsed（首批） | — | 4 / 0 | 20 | 1 | 0 |
| 南京航空航天大学 | university-91job | parsed（首批） | — | 4 / 0 | 20 | 1 | 0 |
| 南京理工大学 | university-91job | parsed | — | 3 / 4 | 20 | 1 | 0 |
| 南京农业大学 | university-91job | parsed（首批） | — | 4 / 0 | 20 | 1 | 0 |
| 南京师范大学 | university-91job | parsed | — | 3 / 4 | 20 | 1 | 0 |
| 南京工业大学 | university-91job | parsed（首批） | — | 4 / 0 | 20 | 1 | 0 |
| 南京邮电大学 | university-91job | parsed（首批） | — | 4 / 0 | 20 | 1 | 0 |
| 南京信息工程大学 | university-91job | parsed（首批） | — | 4 / 0 | 20 | 1 | 0 |
| 南京林业大学 | university-91job | parsed（首批） | — | 4 / 0 | 20 | 1 | 0 |
| 中国药科大学 | university-91job | parsed（首批） | — | 4 / 0 | 20 | 1 | 0 |
| 南京医科大学 | university-91job | failed | request_timeout | 2 / 3 | 0 | 0 | 0 |
| 南京中医药大学 | university-91job | failed | request_timeout | 0 / 3 | 0 | 0 | 0 |
| 南京财经大学 | university-91job | failed | request_timeout | 0 / 2 | 0 | 0 | 0 |
| 南京审计大学 | university-91job | failed | request_timeout | 0 / 3 | 0 | 0 | 0 |
| 苏州大学 | university-91job | failed | request_timeout | 0 / 3 | 0 | 0 | 0 |
| 常州大学 | university-91job | failed | request_timeout | 0 / 3 | 0 | 0 | 0 |
| 江南大学 | university-91job | failed | request_timeout | 0 / 3 | 0 | 0 | 0 |
| 江苏大学 | university-91job | failed | source_validation_failed | 0 / 2 | 0 | 0 | 0 |
| 扬州大学 | university-91job | parsed | — | 0 / 4 | 20 | 1 | 0 |
| 南京大学 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 中国人民警察大学 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 河南理工大学 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 西安科技大学 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 中国矿业大学 | university-91job | failed | request_timeout | 0 / 3 | 0 | 0 | 0 |
| 腾讯 | tencent | parsed | — | 0 / 4 | 1 | 1 | 0 |
| 博世 | smartrecruiters | parsed | — | 0 / 8 | 20 | 1 | 0 |
| 华为 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 小米 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 阿里巴巴 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 字节跳动 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 美团 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 中国银行 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 西门子 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 人民教育出版社 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| Canonical | greenhouse | failed | request_timeout | 0 / 3 | 0 | 0 | 0 |
| 浙江省机场集团有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 首都机场集团有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 上海机场（集团）有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 安徽民航机场集团有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 西部机场集团有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 深圳市机场（集团）有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 河北机场管理集团有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 吉林省民航机场集团有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 黑龙江省机场管理集团有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 杭州萧山国际机场有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 宁波机场集团有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 温州机场集团有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 北京首都国际机场股份有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 北京大兴国际机场 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 天津滨海国际机场 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 广州白云国际机场股份有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 北京博维航空设施管理有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 首都机场集团设备运维管理有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 北京首都机场动力能源有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 北京空港航空地面服务有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 中国中安消防安全工程有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 中安建设安装集团有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 上海盛安建设工程（集团）有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 威特龙消防安全集团股份公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 四川威特龙消防技术服务有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 南京消防器材股份有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 国安达股份有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 海湾安全技术有限公司（GST） | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 青鸟消防 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 泰和安（中消云·泰和安集团） | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 四川久远智能消防设备有限责任公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 北京利达华信电子股份有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 深圳市赋安安全系统有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 中集天达控股有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 中建安装集团有限公司 | official-announcements | blocked | template_missing | 0 / 0 | 0 | 0 | 0 |
| 贵州民航集团招聘公告 | official-announcements | parsed | — | 0 / 5 | 7 | 1 | 0 |
| 中国科学院计算技术研究所 | official-announcements | failed | request_timeout | 0 / 3 | 0 | 0 | 0 |
| 中国科学院软件研究所 | official-announcements | blocked | source_budget_exhausted | 0 / 4 | 18 | 1 | 0 |
| 中国科学院物理研究所 | official-announcements | parsed | — | 0 / 4 | 8 | 1 | 0 |
| 中国科学院广州生物医药与健康研究院 | official-announcements | parsed | — | 0 / 4 | 15 | 1 | 0 |
| 中国科学院文献情报中心 | official-announcements | parsed | — | 0 / 4 | 20 | 1 | 0 |
| 中国科学院过程工程研究所 | official-announcements | blocked | source_budget_exhausted | 0 / 4 | 14 | 1 | 0 |
| Boss直聘 | boss | blocked | boss_login_required | 0 / 0 | 0 | 0 | 0 |
| 智联招聘 | zhaopin | parsed | — | 0 / 4 | 20 | 1 | 0 |
| 实习僧 | shixiseng | parsed | — | 0 / 4 | 3 | 0 | 0 |
| 牛客校招 | nowcoder | parsed | — | 0 / 3 | 20 | 0 | 0 |
| 就业桥 | jiuyeqiao | parsed | — | 0 / 4 | 10 | 1 | 0 |
| 国家大学生就业服务平台 | ncss | parsed | — | 0 / 4 | 20 | 1 | 0 |
| 应届生截止日期榜 | yingjiesheng | parsed | parse_error | 0 / 4 | 85 | 0 | 0 |
| 全网搜索 | searchapi | blocked | external_cost_unverified | 0 / 0 | 0 | 0 | 0 |
| 微信公众号线索 | wechat | parsed | — | 0 / 64 | 1 | 0 | 0 |
| 微博招聘线索 | weibo | failed | parse_error | 0 / 6 | 0 | 0 | 0 |
| 抖音招聘线索 | douyin | blocked | external_cost_unverified | 0 / 0 | 0 | 0 | 0 |

机器矩阵：[actual-source-validation-final-matrix.json](2026-10-11-actual-source-validation-final-matrix.json)。首批原证据：[首批实测报告](2026-10-10-actual-source-validation.md)、[首批矩阵](2026-10-10-source-validation-matrix.json)。公共文件仅包含公开来源名称/标识、枚举、hash、数值和布尔，不含简历、私人关键词、联系方式、凭据、私人路径、请求正文或岗位正文。
