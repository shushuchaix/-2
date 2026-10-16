# 社交招聘来源可行性

2026-10-05（Asia/Hong_Kong）；只读核验，未执行平台登录、授权或付费。Scrapling 0.4.15 已可用，CLI探针使用 --ai-targeted；没有验证成功的自动岗位采集通道。

| 平台 | 本轮证据 | 纳入工作台的方法 |
| --- | --- | --- |
| 微信公众号 | 搜狗微信、mp.weixin.qq.com 的通用 robots 禁止；腾讯官方条款确认招聘微信号 QQjobs | 通过已配置搜索API发现公告线索，保存URL；用户提供正文后抽取，运营方授权API另行核实 |
| 微博 | robots 请求TLS失败，页面工具报告禁止；协议限制未经许可自动抓取；官方CLI需开发者认证、OAuth、服务开通 | 搜索线索、原文URL与用户正文导入；未配置授权明确显示未授权 |
| 抖音 | 主站robots按路径限制，精选域名通用禁止；官方video.list需权限及账号授权，video.search为特殊权限 | 搜索视频公告线索，保存URL与用户提供的文字材料；无正文/官方认证证据不升格具体岗位 |

Scrapling robots 探针：05:02–05:07 香港时间，搜狗微信/微信公众号/抖音主站/抖音精选均HTTP200；微博TLS关闭无HTTP状态。微信开发者robots跳登录错误页，不算有效规则文件。没有对禁止路径进行正文采集；临时文件已清理。

社交信息保留 platform/account/sourceUrl/publishTime/retrievedAt/evidenceLevel/accessStatus。搜索摘要标 discovery；用户正文标 user_provided；官方性需公司官网链接、平台认证或授权主体证据。只凭昵称、视频说明、过期公告不认定官方岗位。只有具体岗位及公司/地点/要求/投递证据足够时才抽取 Job，仍保留原公告。社交线索与手工导入不计入六个新增自动采集适配器。

官方依据：

- [腾讯招聘条款（QQjobs）](https://careers.tencent.com/m/zh-cn/termsservice.html)
- [字节校招FAQ](https://jobs.bytedance.com/campus/page-6272Gc?spread=49TMNMC)
- [微博CLI使用手册](https://open.weibo.com/cli/quickstart)
- [微博服务协议](https://www.weibo.com/signup/v5/protocol/)
- [抖音授权账号视频列表](https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/search-video/account-video-list)
- [抖音权限分类](https://open.douyin.com/platform/resource/docs/accession-guide/type-and-permission)
- [抖音用户协议](https://www.douyin.com/draft/douyin_agreement/douyin_agreement_user.html?id=6773906068725565448&ug_source=yd_tbbg)
- [公众号robots](https://mp.weixin.qq.com/robots.txt)
- [搜狗微信robots](https://weixin.sogou.com/robots.txt)
- [抖音精选robots](https://jingxuan.douyin.com/robots.txt)

微信发布列表权限当前官方正文未取得；不把历史SDK描述当已验证接口。微博CLI可检索/读取的具体命令，正式接入须以授权后的 commands list --available 为准。本版提供发现与导入，不携带平台登录凭证。
