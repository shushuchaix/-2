# 全来源真实简历实测：第一批

日期：2026-10-10。尚非最终交付；下列矩阵区分实际采集与配置/预算/登录阻断。简历只在本地规则评价，不进入网络或模型载荷。

## 方法和范围

- 原附加PDF为单页图片；本地OCR、图像核对与已恢复文本确认身份。旧owned copy毕业年份空白，另建独立测试版本保存图像确认年份，不改旧副本。
- 98条目录逐项检查；每站最多一页列表、一份详情，全部归属一个暂停准备的活动。数据源调用只用固定公开职业词。
- 本批额度91次请求、47详情、6.13元；此前89请求/33详情与3.869184元费用上界继续保留。原180请求上限本批已用满，不能把受预算阻断的来源记为空结果。
- 本批来源请求91：85已核实调用，6未知上界；含DNS44、HTTP44、重定向3，已计详情16次。DNS调用数不是独立HTTP页数，系统缓存是否实际发DNS报文未测量。
- 首批工具按目录顺序执行且详情取首条，存在平台覆盖与相关性采样偏差；这两个限制在后续修正及新增实测时要分开报告，不能回写本批成绩。

## 实际结果

| 结果 | 数量 |
| --- | ---: |
| 已解析来源 | 16 |
| 调用失败来源 | 4 |
| 预算阻断 | 28 |
| 缺公告模板 | 47 |
| Boss需本版本首次登录 | 1 |
| 外部费用未核实 | 2 |
| 新增且版本内不重复记录 | 213 |
| 本地规则已评价 | 213 |
| 正文证据完整 | 14 |
| 资格未知 / 不符 | 137 / 76 |
| 已核实在招 / 可投递 / 有效新增 | 0 / 0 / 0 |

213条包含公告与待核实记录，不能称为213个可投递岗位。全来源召回率、误合并率与人工总体准确率未测量。

### 原日志归因与后续修复

只读同活动日志确认西安电子科技大学、嘉兴大学、中国民用航空飞行学院、91job南京理工大学与南京师范大学相关失败均有`request_timeout`。矩阵保留工具当时记录的错误码；该超时只说明本次12秒限制内未成功，不能断言站点永久不可用。

详情采样已改为本地按角色匹配和资格排序；未知资格继续保持未知。来源轮询与生产证据补全正在做独立回归。首批工具未调用生产的投递/附件补全，且未补详情的长摘要可能没有进入正文队列，因此正文与投递缺口需要沿生产路径重新测量，不能把首批数字当作这些模块的最终准确率。

## 独立模型测量

v4.1对应官方deepseek-flash：24个合成黄金样例真实调用24/24通过；结构100%、关键字段100%、危险误推荐0，四个合法公告正例抽出23个岗位。费用0.054174元。该成绩只适用于此样例集，不代表用户个人匹配、实际社交平台或真实公告已经验收。

## 逐项矩阵

parsed仅证明取得可入库记录；body列单列已验证正文，valid列要求正文、在招、投递、个人资格同时通过。blocked未执行HTTP的条目不能记为成功或空。

| 来源 | provider | 状态 | 原因 | 请求 | 新记录 | 正文 | 有效新增 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| 西安电子科技大学 | university | parsed | — | 5 | 23 | 0 | 0 |
| 东北大学秦皇岛分校 | university | parsed | — | 5 | 3 | 1 | 0 |
| 大连海事大学 | university | parsed | — | 5 | 2 | 1 | 0 |
| 山东财经大学 | university | parsed | — | 10 | 12 | 1 | 0 |
| 浙江师范大学 | university | parsed | — | 5 | 2 | 0 | 0 |
| 厦门大学 | university | parsed | — | 5 | 1 | 1 | 0 |
| 郑州大学 | university | parsed | — | 5 | 3 | 1 | 0 |
| 嘉兴大学 | university | failed | unavailable | 4 | 0 | 0 | 0 |
| 中国民用航空飞行学院 | chenyun | failed | unavailable | 3 | 0 | 0 | 0 |
| 东南大学 | university-91job | parsed | — | 4 | 7 | 1 | 0 |
| 河海大学 | university-91job | parsed | — | 4 | 20 | 1 | 0 |
| 南京航空航天大学 | university-91job | parsed | — | 4 | 20 | 1 | 0 |
| 南京理工大学 | university-91job | failed | source_validation_failed | 3 | 0 | 0 | 0 |
| 南京农业大学 | university-91job | parsed | — | 4 | 20 | 1 | 0 |
| 南京师范大学 | university-91job | failed | source_validation_failed | 3 | 0 | 0 | 0 |
| 南京工业大学 | university-91job | parsed | — | 4 | 20 | 1 | 0 |
| 南京邮电大学 | university-91job | parsed | — | 4 | 20 | 1 | 0 |
| 南京信息工程大学 | university-91job | parsed | — | 4 | 20 | 1 | 0 |
| 南京林业大学 | university-91job | parsed | — | 4 | 20 | 1 | 0 |
| 中国药科大学 | university-91job | parsed | — | 4 | 20 | 1 | 0 |
| 南京医科大学 | university-91job | blocked | source_budget_exhausted | 2 | 0 | 0 | 0 |
| 南京中医药大学 | university-91job | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 南京财经大学 | university-91job | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 南京审计大学 | university-91job | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 苏州大学 | university-91job | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 常州大学 | university-91job | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 江南大学 | university-91job | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 江苏大学 | university-91job | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 扬州大学 | university-91job | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 南京大学 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 中国人民警察大学 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 河南理工大学 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 西安科技大学 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 中国矿业大学 | university-91job | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 腾讯 | tencent | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 博世 | smartrecruiters | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 华为 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 小米 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 阿里巴巴 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 字节跳动 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 美团 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 中国银行 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 西门子 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 人民教育出版社 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| Canonical | greenhouse | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 浙江省机场集团有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 首都机场集团有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 上海机场（集团）有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 安徽民航机场集团有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 西部机场集团有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 深圳市机场（集团）有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 河北机场管理集团有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 吉林省民航机场集团有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 黑龙江省机场管理集团有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 杭州萧山国际机场有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 宁波机场集团有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 温州机场集团有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 北京首都国际机场股份有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 北京大兴国际机场 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 天津滨海国际机场 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 广州白云国际机场股份有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 北京博维航空设施管理有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 首都机场集团设备运维管理有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 北京首都机场动力能源有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 北京空港航空地面服务有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 中国中安消防安全工程有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 中安建设安装集团有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 上海盛安建设工程（集团）有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 威特龙消防安全集团股份公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 四川威特龙消防技术服务有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 南京消防器材股份有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 国安达股份有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 海湾安全技术有限公司（GST） | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 青鸟消防 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 泰和安（中消云·泰和安集团） | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 四川久远智能消防设备有限责任公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 北京利达华信电子股份有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 深圳市赋安安全系统有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 中集天达控股有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 中建安装集团有限公司 | official-announcements | blocked | template_missing | 0 | 0 | 0 | 0 |
| 贵州民航集团招聘公告 | official-announcements | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 中国科学院计算技术研究所 | official-announcements | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 中国科学院软件研究所 | official-announcements | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 中国科学院物理研究所 | official-announcements | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 中国科学院广州生物医药与健康研究院 | official-announcements | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 中国科学院文献情报中心 | official-announcements | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 中国科学院过程工程研究所 | official-announcements | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| Boss直聘 | boss | blocked | boss_login_required | 0 | 0 | 0 | 0 |
| 智联招聘 | zhaopin | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 实习僧 | shixiseng | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 牛客校招 | nowcoder | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 就业桥 | jiuyeqiao | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 国家大学生就业服务平台 | ncss | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 应届生截止日期榜 | yingjiesheng | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 全网搜索 | searchapi | blocked | external_cost_unverified | 0 | 0 | 0 | 0 |
| 微信公众号线索 | wechat | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 微博招聘线索 | weibo | blocked | source_budget_exhausted | 0 | 0 | 0 | 0 |
| 抖音招聘线索 | douyin | blocked | external_cost_unverified | 0 | 0 | 0 | 0 |

机器可读白名单结果：[source-validation-matrix.json](2026-10-10-source-validation-matrix.json)。文件不含简历、姓名、联系方式、凭据、私人路径、请求正文或岗位正文。

## 后续本地规则重评

采用修复后的conditions-3及严格正文门槛，同一版本213条已有事实全部重评完成。213份旧评价更新，来源/详情/附件/模型请求和费用增量均为0，原事实和抓取时间不变。正文核实13条、资格未知137/不符76/通过0、当前在招0、已核实入口0、有效新增0。少计的一条是旧截断正文，尚未重新补抓。本段不改写上表及JSON的首批测量快照。
