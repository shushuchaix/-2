// 简历 → 结构化求职画像 + 检索词（DeepSeek）
import { CITY_ALIAS_CANDIDATES } from "./cities.mjs";

const SYSTEM = `你是资深的中国校园招聘求职顾问，擅长把大学生简历拆解成可检索的求职画像。

要求：
1. 只依据简历原文推断，不要编造简历中不存在的信息；无法确定的字段用空字符串或空数组。
2. 面向中国大陆校招/实习市场，输出中文。
3. titleKeywords 必须是招聘网站上真实存在的短岗位词（2-8 个汉字，如「Java开发」「后端开发」「数据分析」「前端开发」「算法工程师」「产品经理」），不要带城市、不要带"应届""校招"这类词，避免过长导致搜不到结果。
4. webQueries 是用于搜索引擎的长查询，要自然、包含届别/岗位/城市等限定词，4-8 条，覆盖不同岗位方向；其中 2-4 条使用 site: 限定在主流招聘站。
5. 严格输出 JSON，不要输出任何解释、前后缀或 Markdown 围栏。`;

const SCHEMA_HINT = `{
  "name": "姓名",
  "school": "学校全称",
  "degree": "最高学历：专科/本科/硕士/博士",
  "major": "专业",
  "graduationYear": "毕业年份，如 2026",
  "targetRoles": ["目标岗位全称，如 Java后端开发工程师"],
  "jobTypes": ["校招", "实习"],
  "preferredCities": ["期望城市，从简历中的期望城市/现居地推断；简历未写则按学校所在地给出"],
  "skills": [{ "name": "技能名", "level": "掌握程度，未知填 熟悉" }],
  "certificates": ["证书"],
  "awards": ["奖项"],
  "internships": [{ "company": "公司", "role": "岗位", "highlights": "一句话成果" }],
  "projects": [{ "name": "项目名", "tech": ["技术栈"], "highlights": "一句话亮点" }],
  "keywords": ["全部可用于岗位匹配的关键词：技术栈/工具/业务领域/软技能，10-25 个"],
  "titleKeywords": ["短岗位词，3-6 个"],
  "webQueries": ["搜索长查询，4-8 条"],
  "summary": "一句话求职画像，40 字以内",
  "strengths": ["核心竞争力，2-4 条"],
  "gaps": ["相对目标岗位的短板，1-3 条"]
}`;

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === "") return [];
  return [v];
}

function str(v) {
  return typeof v === "string"
    ? v.trim()
    : v === null || v === undefined
      ? ""
      : String(v).trim();
}

/** 规范化 LLM 返回的画像，补齐字段类型 */
export function normalizeProfile(raw = {}) {
  const p = {
    name: str(raw.name),
    school: str(raw.school),
    degree: str(raw.degree),
    major: str(raw.major),
    graduationYear: str(raw.graduationYear),
    targetRoles: asArray(raw.targetRoles).map(str).filter(Boolean),
    jobTypes: asArray(raw.jobTypes).map(str).filter(Boolean),
    preferredCities: asArray(raw.preferredCities).map(str).filter(Boolean),
    skills: asArray(raw.skills)
      .map((s) =>
        typeof s === "string"
          ? { name: s, level: "熟悉" }
          : { name: str(s?.name), level: str(s?.level) || "熟悉" },
      )
      .filter((s) => s.name),
    certificates: asArray(raw.certificates).map(str).filter(Boolean),
    awards: asArray(raw.awards).map(str).filter(Boolean),
    internships: asArray(raw.internships).map((x) => ({
      company: str(x?.company),
      role: str(x?.role),
      highlights: str(x?.highlights),
    })),
    projects: asArray(raw.projects).map((x) => ({
      name: str(x?.name),
      tech: asArray(x?.tech).map(str).filter(Boolean),
      highlights: str(x?.highlights),
    })),
    keywords: asArray(raw.keywords).map(str).filter(Boolean),
    titleKeywords: asArray(raw.titleKeywords).map(str).filter(Boolean),
    webQueries: asArray(raw.webQueries).map(str).filter(Boolean),
    summary: str(raw.summary),
    strengths: asArray(raw.strengths).map(str).filter(Boolean),
    gaps: asArray(raw.gaps).map(str).filter(Boolean),
  };

  // 关键词兜底：技能 + 项目技术栈 + 目标岗位
  if (p.keywords.length < 5) {
    const extra = [
      ...p.skills.map((s) => s.name),
      ...p.projects.flatMap((x) => x.tech),
      ...p.targetRoles,
    ].filter(Boolean);
    p.keywords = [...new Set([...p.keywords, ...extra])];
  }

  // 岗位词兜底
  if (p.titleKeywords.length === 0) {
    const derived = p.targetRoles
      .map((r) =>
        r
          .replace(/(工程师|专员|经理|实习生|助理|开发)$/g, (m) =>
            m === "实习生" ? "" : m,
          )
          .trim(),
      )
      .filter(Boolean);
    p.titleKeywords = [...new Set([...derived, ...p.targetRoles])].slice(0, 5);
  }
  if (p.titleKeywords.length === 0) p.titleKeywords = ["应届生"];

  // 城市兜底：无法解析时给全国
  if (p.preferredCities.length === 0) p.preferredCities = [];

  return p;
}

/** 调用 LLM 分析简历 */
export async function analyzeResume(
  llm,
  resumeText,
  { log = () => {}, signal } = {},
) {
  const text =
    resumeText.length > 12000
      ? resumeText.slice(0, 12000) + "\n…（简历过长已截断）"
      : resumeText;
  log("正在调用 DeepSeek 解析简历画像…");
  const raw = await llm.chatJson(
    SYSTEM,
    `请分析下面这份大学生简历，输出如下结构的 JSON：\n${SCHEMA_HINT}\n\n=== 简历原文开始 ===\n${text}\n=== 简历原文结束 ===`,
    { temperature: 0.15, maxTokens: 3000, signal },
  );
  const profile = normalizeProfile(raw);
  log(
    `画像提取完成：${profile.targetRoles.join("、") || "未识别目标岗位"}；关键词 ${profile.keywords.length} 个`,
  );
  return profile;
}

/**
 * 由「专业 + 技能」推导岗位族。
 *
 * 为什么需要这个：简历里写「目标岗位：Java后端开发工程师」，但市面上同类工作
 * 会叫「服务端研发」「后端研发」「平台开发」「基础架构」「应用开发」……
 * 只按简历上那两三个岗位词去搜、去打分，会把大量**要求高度吻合**的岗位漏掉。
 * 用户要的是「这个专业 + 这份简历能胜任的岗位」，不是字面上的那几个title。
 */
const ROLE_FAMILIES = [
  {
    key: "java-backend",
    match: /Java|Spring|MyBatis|Mybatis|JVM|Dubbo|Netty|微服务|分布式|中间件/i,
    roles: [
      "后端开发",
      "Java开发",
      "服务端开发",
      "服务端研发",
      "后端研发",
      "软件开发",
      "研发工程师",
      "微服务开发",
      "中间件开发",
      "基础架构",
      "平台开发",
      "应用开发",
      "系统开发",
    ],
  },
  {
    key: "python",
    match: /Python|Django|Flask|FastAPI|Tornado/i,
    roles: ["Python开发", "后端开发", "服务端开发", "脚本开发", "自动化开发"],
  },
  {
    key: "frontend",
    match: /React|Vue|Angular|JavaScript|TypeScript|HTML|CSS|前端|小程序/i,
    roles: ["前端开发", "Web前端", "大前端", "前端工程师"],
  },
  {
    key: "native",
    match: /C\+\+|C语言|嵌入式|STM32|单片机|驱动/i,
    roles: ["嵌入式开发", "C++开发", "底层开发", "驱动开发"],
  },
  {
    key: "ai",
    match:
      /机器学习|深度学习|PyTorch|TensorFlow|NLP|自然语言处理|计算机视觉|大模型|LLM|算法|推荐系统|知识图谱|AIGC/i,
    roles: [
      "算法工程师",
      "AI工程师",
      "AI应用开发",
      "机器学习工程师",
      "大模型算法",
      "人工智能",
    ],
  },
  {
    key: "data",
    match: /数据分析|Pandas|NumPy|Tableau|Power ?BI|指标体系|A\/B测试/i,
    roles: ["数据分析师", "数据开发", "BI工程师", "数据运营"],
  },
  {
    key: "bigdata",
    match: /Hadoop|Spark|Flink|大数据|Hive|数据仓库|ETL|ClickHouse/i,
    roles: ["大数据开发", "数据开发", "数据仓库工程师", "数据平台开发"],
  },
  {
    key: "qa",
    match: /测试|Selenium|JMeter|Appium|自动化测试|性能测试/i,
    roles: ["测试工程师", "测试开发", "质量保障"],
  },
  {
    key: "ops",
    match: /Docker|Kubernetes|K8s|Linux|运维|DevOps|SRE|Nginx/i,
    roles: ["运维开发", "云平台开发", "SRE", "DevOps工程师"],
  },
  {
    // 必须排在 IT 的 security 之前：否则「消防安全」「安全工程」会被 IT 安全族吃掉。
    // 另外「安全工程」要用负向后顾排除 —— '网络安全工程' 里也含这四个字，
    // 不排除的话一个做渗透测试的人会同时被推成消防工程师。
    key: "fire-safety",
    match:
      /消防|防火|防排烟|灭火|火灾|(?<!网络)(?<!信息)安全工程|安全管理|安全生产|安全评价|应急|EHS|HSE|危险化学品|职业健康|民航安全|航空安全/i,
    // 顺序有讲究：检索只取前几个词，而「安全工程师」在理工类院校就业网上
    // 几乎全是「网络安全工程师」（IT 安全），所以把不会歧义的「消防*」放最前面。
    roles: [
      "消防工程师",
      "消防安全",
      "消防设计",
      "消防施工",
      "消防检测",
      "消防设施",
      "安全工程",
      "安全工程师",
      "EHS工程师",
      "HSE工程师",
      "安全管理",
      "安全管理员",
      "安全评价师",
      "应急管理",
      "安全生产管理",
      "职业健康安全",
      "安全环保",
      "机场运行",
      "航空安全管理",
    ],
  },
  {
    key: "security",
    // 收紧为「明确的 IT 安全措辞」：单独的「安全」两个字含义太宽，会把消防/生产安全误判进来
    match:
      /网络安全|信息安全|渗透测试|CTF|密码学|漏洞挖掘|等保|安全攻防|Web安全/i,
    roles: ["安全工程师", "信息安全工程师"],
  },
  {
    key: "product",
    match: /产品经理|PRD|需求分析|竞品分析|原型设计/i,
    roles: ["产品经理", "产品助理", "产品运营"],
  },
];

/** 按专业推导的通用岗位词（技能不强时的兜底） */
const MAJOR_FAMILIES = [
  {
    match:
      /计算机|软件工程|人工智能|数据科学|信息工程|电子信息|通信工程|自动化/,
    roles: ["软件开发", "研发工程师", "技术类岗位"],
  },
  { match: /数学|统计|金融数学/, roles: ["数据类岗位", "算法工程师"] },
  // 消防/安全：同样把不会歧义的「消防*」放前面，避免「安全工程师」在理工类院校
  // 就业网上捞回一堆「网络安全工程师」
  {
    match: /消防|(?<!网络)(?<!信息)安全工程|安全科学|应急管理|应急技术/,
    roles: [
      "消防工程师",
      "消防安全",
      "消防设计",
      "安全工程",
      "安全工程师",
      "EHS工程师",
      "安全管理",
      "安全评价",
    ],
  },
  {
    match: /电子|电气|机械|自动化|控制/,
    roles: ["硬件工程师", "电气工程师", "自动化工程师"],
  },
  { match: /会计|财务|审计/, roles: ["财务专员", "审计"] },
  { match: /市场营销|工商管理|经济/, roles: ["市场营销", "运营专员"] },
  { match: /人力|行政|劳动/, roles: ["人力资源专员"] },
  { match: /设计|视觉|艺术/, roles: ["UI设计师", "视觉设计师"] },
  {
    match: /航空|民航|飞行|空管|交通运输/,
    roles: ["航空类岗位", "机场运行", "安全管理"],
  },
];

/** 由专业推导目标岗位词（画像钉死时用它替换简历里残留的旧方向） */
export function rolesForMajor(major = "") {
  for (const fam of MAJOR_FAMILIES)
    if (fam.match.test(String(major))) return [...fam.roles];
  return [];
}

/**
 * 推导候选岗位族词表（按相关度排序）
 * @returns {string[]}
 */
export function deriveRoleKeywords(profile, { max = 40 } = {}) {
  const skillText = [
    ...(profile.keywords || []),
    ...(profile.skills || []).map((s) => (typeof s === "string" ? s : s?.name)),
    ...(profile.projects || []).flatMap((p) => p.tech || []),
    ...(profile.targetRoles || []),
    ...(profile.titleKeywords || []),
  ]
    .filter(Boolean)
    .join(" ");

  const scored = new Map(); // role -> weight
  const add = (role, w) => {
    const r = String(role).replace(/\s+/g, "").trim();
    if (r.length < 2 || r.length > 16) return;
    scored.set(r, Math.max(scored.get(r) || 0, w));
  };

  // 简历里明确写的目标岗位优先
  for (const r of profile.targetRoles || []) add(r, 100);
  for (const r of profile.titleKeywords || []) add(r, 95);

  for (const fam of ROLE_FAMILIES) {
    if (!fam.match.test(skillText)) continue;
    fam.roles.forEach((r, i) => add(r, 70 - i));
  }
  for (const fam of MAJOR_FAMILIES) {
    if (!fam.match.test(String(profile.major || ""))) continue;
    fam.roles.forEach((r, i) => add(r, 40 - i));
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([r]) => r)
    .slice(0, max);
}

/** 生成站点直连关键词（确保有足够数量与多样性） */
export function buildTitleKeywords(profile, { max = 6 } = {}) {
  const set = [];
  const push = (k) => {
    const v = str(k).replace(/[\s\u3000]+/g, "");
    if (v && v.length >= 2 && v.length <= 14 && !set.includes(v)) set.push(v);
  };

  // 先放简历里明确的岗位词
  profile.titleKeywords.forEach(push);
  profile.targetRoles.forEach(push);

  // 再用推导出的岗位族补齐 —— 这样搜索引擎能覆盖「服务端研发」「平台开发」这类叫法
  for (const r of deriveRoleKeywords(profile, { max: 40 })) push(r);

  if (profile.degree && set.length < 3) push("应届生");
  return set.slice(0, max);
}

/** 生成搜索 API 查询词 */
export function buildWebQueries(profile, { cities = [], max = 8 } = {}) {
  const queries = [...profile.webQueries];
  const city = cities[0] || profile.preferredCities[0] || "";
  const year = profile.graduationYear || "";
  const role = profile.targetRoles[0] || profile.titleKeywords[0] || "";
  const topSkills = profile.keywords.slice(0, 4).join(" ");

  const seen = new Set(queries.map((q) => q.replace(/\s+/g, "")));
  const add = (q) => {
    const key = String(q).replace(/\s+/g, "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    queries.push(q);
  };

  if (role)
    add(
      [year ? `${year}届` : "", "校园招聘", role, city]
        .filter(Boolean)
        .join(" "),
    );
  if (role) add([role, "实习", city, "招聘"].filter(Boolean).join(" "));
  if (topSkills) add([topSkills, city, "校招"].filter(Boolean).join(" "));
  add(`site:zhipin.com ${role} ${city}`.trim());
  add(`site:nowcoder.com ${role} 校招 ${city}`.trim());
  add(`site:yingjiesheng.com ${year ? year + "届" : ""} ${role}`.trim());
  add(`site:shixiseng.com ${role} 实习 ${city}`.trim());

  return [...new Set(queries)].slice(0, max);
}

/**
 * 生成微信公众号检索词。
 * 公众号文章的标题多为「XX集团2026届校园招聘正式启动」，所以查询要带
 * 届别 + 招聘词，而不是像招聘站那样只给一个短岗位词。
 */
export function buildWechatQueries(
  profile,
  { cities = [], max = 4, targetYear = "" } = {},
) {
  // 目标届别优先于简历里写的毕业年份：用户可能想提前看下一届的机会
  const year = String(targetYear || profile.graduationYear || "").replace(
    /届$/,
    "",
  );
  const yearTag = year ? `${year}届` : "";
  const role = profile.targetRoles?.[0] || profile.titleKeywords?.[0] || "";
  const city = cities[0] || profile.preferredCities?.[0] || "";

  const out = [];
  const add = (s) => {
    const t = String(s).replace(/\s+/g, " ").trim();
    if (t && !out.includes(t)) out.push(t);
  };

  if (role) {
    add([yearTag, role, "校园招聘"].filter(Boolean).join(" "));
    add(`${role} 实习 招聘`);
  }
  add([yearTag, "校园招聘", city].filter(Boolean).join(" "));
  add([yearTag, "校园招聘", "信息汇总"].filter(Boolean).join(" "));
  add([yearTag, "秋招", role].filter(Boolean).join(" "));

  return out.slice(0, max);
}

export { CITY_ALIAS_CANDIDATES };
