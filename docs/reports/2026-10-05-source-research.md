# 招聘渠道扩展：只读核验记录

核验日期：2026-10-04 至 2026-10-05（Asia/Hong_Kong）。包含主流程及并行只读调研的结果；未接入生产代码。响应是核验时刻的观察，实施时须重新验证。

## 取得实际数据的候选

| 渠道 | 请求/响应证据 | 当前可确认范围 |
| --- | --- | --- |
| NCSS | GET /student/jobs/jobslist/ajax/，offset=1、limit=2，返回 HTTP200，flag=true，data.list | 匿名列表有招聘公告/岗位字段；详情与分页语义待实现时核对 |
| 91job | 东南大学学校代码10286、河海大学10294；POST /web/wsjysc/lbxq/getZpgwPageList，JSON;charset=utf-8，返回 success=true/code=200/result.records；东南 getZpggPageList 及 GET getZpgwxq?zpgwid=&xxdm= 成功 | 两校列表、东南公告和岗位正文；属于一个适配器、多校配置 |
| 腾讯 | GET /tencentcareer/api/post/Query?keyword=&pageIndex=1&pageSize=2&language=zh-cn，HTTP200，Data.Posts | 公开社会招聘列表；不证明校招能力，详情仍需验证 |
| SmartRecruiters / 博世 | GET /v1/companies/BoschGroup/postings?limit=2&country=cn 返回 HTTP200，两条记录地点为西安/郑州；跟随 ref 的详情返回 HTTP200 | 匿名列表与职责/资格/投递链接；country筛选及其他公司归属仍需逐项确认 |
| 应届生截止日期榜 | /deadline/ HTTP200，GBK HTML 名单和日期可读 | 网申窗口线索；第二页/岗位详情被WAF限制，不算完整岗位采集接入 |

NCSS 请求使用前端实际字段：jobType、areaCode、jobName、monthPay、industrySectors、property、categoryCode、memberLevel、recruitType、keyUnits、degreeCode、sourcesName、sourcesType 可为空，offset/limit 必须按契约；携带 X-Requested-With: XMLHttpRequest 与公开列表 Referer。用 page/pageSize 替代的初次请求返回500，不能把错误参数当正确接口。

91job JSON 请求字段：current、size、xxdm，以及 dwgm、dwxz、fbsj、hylb、jssj、keyword、kssj、ssqy、xlyq、nxsx、nxxx、xqzy、zwlb、lmid、sjly。form-urlencoded 返回业务500；zwms 是 JSON 字符串，需静态解码。时间、薪资单位依据原字段语义核实，不凭字段名猜测。

SmartRecruiters 使用官方公开 Posting API，博世官方 FAQ 确认其ATS。其 API robots.txt 对普通机器人为 Disallow，存在 LinkedInBot 特定规则；本次使用文档所述公开 API 契约，无 Cookie/Token/签名或专用机器人身份。正式实现应保存该接口的访问依据，避免复制通用网页抓取规则或伪装身份。

## 尚未满足接入证据的候选

| 候选 | 核验结果 | 下一步 |
| --- | --- | --- |
| 国聘 | 官方bundle有 /api/jobs/v3/list、info；匿名列表返回业务403，前端有 Sign/T/Nonce 签名路径 | 保留候选/原文入口，寻找另一个公开可读渠道；本次没有实现签名 |
| 飞书招聘候选 | 字节、五菱、蔚来匿名POST候选返回405 | 重新核对官方租户与当前公开契约；不算可用 |
| 海投 | 公开入口超时 | 后续少量探针验证，不宣称永久失效 |
| 国资委、深圳国资招聘栏目 | 官方索引有招聘标题/日期/正文，本轮直连TLS/socket失败或超时 | 取得实际列表与详情后才标ready，寻找同类别替代站点 |

## 官方依据与入口

- [NCSS 列表页](https://www.ncss.cn/student/jobs/index.html)
- [东南大学 91job](https://seu.91job.org.cn/sub-station/home/10286)
- [河海大学 91job](https://hhu.91job.org.cn/sub-station/home/10294)
- [腾讯招聘](https://careers.tencent.com/)
- [应届生截止日期榜](https://www.yingjiesheng.com/deadline/)
- [博世招聘 FAQ](https://www.bosch.com/careers/faq/)
- [SmartRecruiters 公开接口](https://developers.smartrecruiters.com/docs/endpoints)
- [SmartRecruiters 鉴权说明](https://developers.smartrecruiters.com/docs/authentication)
- [国聘](https://www.iguopin.com/)
- [国资委招聘栏目](https://www.sasac.gov.cn/n2588035/n2588325/n2588350/index.html)
- [深圳国资校园招聘](https://gzw.sz.gov.cn/gzrc/xyzp/)

没有保存个人简历、密钥、完整真实岗位正文或登录凭证。最终交付数量以 C6 的 source-readiness 报告为准，本报告不算通过了接入验收。
