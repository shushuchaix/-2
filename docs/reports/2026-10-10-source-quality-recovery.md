# 2026-10-10 采集质量与正文补抓修复验证

## 交付范围

利用新技能与Boss工具交接资料，对上一轮已批准采集流程做定向核查，修复原有行为缺陷。新增Boss产品接入及质量治理的补充设计已获用户通过，实施计划另行审阅；这次EXE包含下列原流程修复。

## 修复与回归证据

| 问题                                                 | 修复                                                                  | 可观察结果                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| 长期招聘先要求投递可用才判开放，入口核验却先要求开放 | 正文已核验、时效开放或未知且无冲突时允许只读入口检查                  | 长期招聘核验成功后可判开放；普通无日期岗位仍未知         |
| 不可重试详情反复进入正文队列                         | 尊重错误的retryable=false                                             | 保留线索与错误，队列不再重复消耗                         |
| 补抓成功继承旧incomplete/retryEligible               | 新详情调用清除旧尝试状态，按新响应确认正文状态                        | 重启后补抓成功正文入库、待办完成                         |
| 前10条等待任务阻塞第11条到期任务                     | 先筛执行时间，再限制每片10条                                          | 前10条服务器等待不被绕过，第11条完成，队列只余10条       |
| 正文过期截止/字段冲突在入口请求后才提取              | 核验前对克隆记录prepareRecruitmentRecord                              | 正文过期或冲突不发送投递页请求                           |
| 空正文detailStatus=complete静默清除补抓待办          | 空/纯空白返回detail_insufficient且不可自动重试，独立补抓保留安全issue | 内容不足提示可见；适配器认定完整的非空短正文按原契约保留 |

新增活动回归文件：`tests/integration/collection-quality-recovery.test.mjs`，最终5/5。原四项均先观察有效RED再GREEN；限定审阅两项边界分别触发额外投递请求、缺少内容不足issue的RED，再修正通过。

原失败状态清理保留本次明确的受限/挑战、bodyIncomplete及rowAmbiguous结果，不将失败正文升级为完整。未给所有API增加统一字数门槛；测试曾发现30字门槛误拒绝腾讯/ATS合法短正文，已删除该通用阈值，各适配器自身结构门槛继续生效。

## 最终验证

- `tools/run-all-tests.mjs --skip-network`退出0：25套件，18通过、0失败、7明确跳过；后端744/744、React76/76、桌面源码27/27。7项包括6外部网络套件及独立发行包检查；包校验随后实际执行通过。
- `tsc -p ui/tsconfig.json --noEmit`退出0。
- 最终构建退出0，159.8秒；整个便携目录约1287.8MiB、EXE约234.4MiB。应保留整个目录运行。
- `tools/verify-package.mjs`退出0：10420文件、52生产依赖、3JS/1CSS；随包运行时与32个OCR资源哈希通过。
- 三个修改的生产模块与ASAR提取字节3/3一致。ASAR SHA256：`7f8a40c94f1172b7d88917688cdc137b2bdc83b7f1e0a69be1cbdbca14c56042`。
- 最终实际EXE100%/125%/150%三个独立合成进程，各69/69、退出0；外部请求、阻止请求、渲染/CSP/控制台错误、自动下载均0。69项包含随包运行时检查，不重复相加。
- 核对三种DPI代表截图：证据抽屉、活动操作与窄窗口岗位卡片可阅读，没有横向溢出。375名义宽在小数DPI实际374，由原窗口几何测试明确记录。
- 限定本次差异的一次独立审阅发现两项边界，已按RED→GREEN修复；没有重复上一轮整分支审查。

本地日志位于`.cache/source-expansion-round2/`：`quality-red-application.log`、`quality-red-recovery.log`、`quality-review-red.log`、`quality-review-green.log`、`offline-quality-final.log`、`build-desktop-final.log`、`verify-package.log`、`exe-three-dpi.log`及`packaged-source-proof.json`。

三DPI合成报告目录依次为`.cache/rjr-self-test-exe-c2bd345bc764451f949543b628cc9d5f`、`.cache/rjr-self-test-exe-b64780e967ad40f893efb9727b3fd1a1`、`.cache/rjr-self-test-exe-82b85d8259964231ac0ab29bc83cf84e`。

## 实际覆盖边界

本轮修复验证使用合成岗位和本地网络mock，模型费用0、真实招聘批量采集0。上一轮50线索/13正文/0投递/0有效推荐仍是此前公开试点结果；本轮不能把离线通过当作线上覆盖已提高。

用户级Boss此前的一页15条/一份674字符JD成功记录只证明外部专用窗口。产品内Boss独立登录、分页、取消、风险停止、真实正文/投递证据仍由新计划验收。REA工具可见，Smart Explore两次.mjs无法解析；此次未宣称完成REA运行时分析或AST遍历。

新设计与计划分别位于`docs/superpowers/specs/2026-10-10-source-effectiveness-and-boss-design.md`、`docs/superpowers/plans/2026-10-10-source-effectiveness-and-boss.md`。执行方式沿用当前会话。
