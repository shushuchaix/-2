// 技能词表与文本技能抽取（供离线画像与岗位源共用）
import { termEvidence } from '../domain/skills.mjs';
export const TECH = [
  // 编程语言
  'Java', 'Python', 'C++', 'C#', 'C语言', 'Go', 'Golang', 'Rust', 'PHP', 'Ruby', 'Swift', 'Kotlin', 'Scala', 'R', 'MATLAB', 'JavaScript', 'TypeScript', 'Dart', 'Objective-C', 'Shell', 'SQL', 'HTML', 'CSS',
  // 前端
  'React', 'Vue', 'Vue.js', 'Angular', 'Next.js', 'Nuxt', 'jQuery', 'Webpack', 'Vite', 'Element UI', 'Ant Design', 'ECharts', 'Three.js', '小程序', 'uni-app', 'Flutter', 'React Native', 'Tailwind',
  // 后端 / 框架
  'Spring', 'Spring Boot', 'SpringBoot', 'Spring Cloud', 'SpringCloud', 'MyBatis', 'Mybatis-Plus', 'Hibernate', 'Dubbo', 'Netty', 'Django', 'Flask', 'FastAPI', 'Tornado', 'Express', 'Koa', 'NestJS', 'Gin', 'Beego', 'RocketMQ', 'Kafka', 'RabbitMQ', 'ActiveMQ', 'gRPC', 'RESTful', 'GraphQL', '微服务', '分布式', '高并发', '中间件',
  // 数据 / 存储
  'MySQL', 'PostgreSQL', 'Oracle', 'SQL Server', 'MongoDB', 'Redis', 'Elasticsearch', 'ClickHouse', 'HBase', 'Hive', 'SQLite', 'Neo4j', 'Kylin', 'Doris', 'TiDB',
  // 大数据 / 人工智能
  'Hadoop', 'Spark', 'Flink', 'Storm', 'MapReduce', 'Yarn', 'Zookeeper', 'ETL', '数据仓库', '数据挖掘', '机器学习', '深度学习', 'TensorFlow', 'PyTorch', 'PaddlePaddle', 'Keras', 'Scikit-learn', 'XGBoost', 'LightGBM', 'NLP', '自然语言处理', '计算机视觉', 'OpenCV', 'YOLO', '大模型', 'LLM', 'Transformer', 'RAG', 'LangChain', 'Agent', '推荐系统', '知识图谱', '强化学习', 'AIGC', 'Prompt',
  // 数据分析 / 产品
  '数据分析', '数据可视化', 'Tableau', 'Power BI', 'Excel', 'SPSS', 'SAS', 'Pandas', 'NumPy', 'Matplotlib', 'Seaborn', 'Jupyter', 'A/B测试', '用户画像', '指标体系', '埋点', 'SQL优化',
  // 运维 / 云 / 测试
  'Linux', 'Docker', 'Kubernetes', 'K8s', 'Jenkins', 'CI/CD', 'Git', 'GitLab', 'SVN', 'Maven', 'Gradle', 'Nginx', 'Tomcat', 'Ansible', 'Prometheus', 'Grafana', '阿里云', '腾讯云', 'AWS', 'Azure', 'DevOps', 'SRE', '自动化测试', 'Selenium', 'Appium', 'JUnit', 'Postman', 'JMeter', '接口测试', '性能测试', '单元测试',
  // 消防安全 / 应急 / 民航（消防工程、安全工程等专业的核心词）
  '消防工程', '消防工程师', '注册消防工程师', '消防设计', '消防设施', '消防系统', '火灾自动报警', '自动喷水灭火',
  '防排烟', '防火分区', '建筑防火', '消防验收', '消防检测', '消防安全', '灭火器', '消火栓', '火灾', '燃烧学',
  '安全工程', '安全管理', '安全评价', '安全技术', '安全生产', '安全标准化', '风险辨识', '隐患排查', '危险源',
  '应急预案', '应急管理', '应急救援', '应急处置', '事故调查', '职业健康', 'EHS', 'HSE', '双重预防机制',
  '危险化学品', '特种设备', '消防安全管理', '安全员', '安全规程', '安全防护',
  '民用航空', '民航', '机场', '航空公司', '航空安全', '机场运行', '飞行区', '空中交通管理', '航空器',
  'BIM', 'CAD', 'Revit', '广联达', 'PKPM', '天正', '注册安全工程师',
  // 安全 / 网络 / 嵌入 / 硬件
  '网络安全', '渗透测试', 'CTF', '密码学', 'TCP/IP', 'HTTP', '抓包', 'Wireshark', '单片机', 'STM32', '嵌入式', 'FPGA', 'Verilog', 'PLC', 'ROS', 'SolidWorks', 'AutoCAD', 'ANSYS', 'Altium Designer',
  // 设计 / 产品 / 运营
  'Figma', 'Sketch', 'Photoshop', 'Illustrator', 'Axure', '墨刀', 'UI设计', 'UX', '交互设计', '视觉设计', '原型设计', '产品需求文档', 'PRD', '需求分析', '竞品分析', '项目管理', 'Scrum', '敏捷开发', 'SEO', 'SEM', '新媒体运营', '内容运营', '用户运营', '活动运营', '私域运营', '电商运营', '社群运营', '短视频', '直播运营', '投放',
  // 商科 / 职能
  '财务报表', '会计核算', '审计', '税务', '成本管理', '预算管理', '财务分析', 'CPA', 'ACCA', '初级会计', '证券从业', '基金从业', '人力资源管理', '招聘', '绩效考核', '薪酬', '劳动关系', '法律职业资格', '合同审核', '市场营销', '商务谈判', '客户关系', '供应链', '物流管理', '采购',
  // 语言 / 通用
  '英语六级', '英语四级', 'CET-6', 'CET-4', '雅思', '托福', '日语', 'N1', 'N2', '普通话',
];

// 建立小写索引加速匹配
//
// 注意：短的纯 ASCII 词不能直接做子串匹配。
// TECH 里有 'R'（统计语言）和 'Go'，而 lower.includes('r') 会命中任何含字母 r 的文本
// （Redis / Spring / Revit / Django…），结果**每份简历都会被抽出一个并不存在的技能「R」**，
// 进而污染关键词与岗位方向判定。这类词必须按词边界匹配。
const SHORT_ASCII = /^[A-Za-z][A-Za-z0-9+#.]{0,1}$/;

const LOWER_INDEX = TECH.map((t) => ({
  term: t,
  lower: t.toLowerCase(),
  boundary: SHORT_ASCII.test(t) ? new RegExp(`(^|[^a-z0-9])${t.toLowerCase().replace(/[+#.]/g, '\\$&')}([^a-z0-9]|$)`) : null,
}));

/**
 * 从任意文本中抽取命中的技能词。
 * 返回按词表顺序去重的技能名数组。
 */
export function extractTechTerms(text = '') {
  const s = String(text);
  if (!s) return [];
  const lower = s.toLowerCase();
  const hits = [];
  for (const { term, lower: lt, boundary } of LOWER_INDEX) {
    if (termEvidence(s, term).length) hits.push(term);
  }
  return [...new Set(hits)];
}

/**
 * 从文本中抽取「岗位要求型」标签（学历、经验、福利之外的能力要求）
 * 用于补齐岗位源的技能字段。
 */
export function extractRequirementTags(text = '') {
  const s = String(text);
  const out = [];
  const patterns = [
    /(本科及以上|硕士及以上|大专及以上|学历不限|本科|硕士|博士|大专)/g,
    /(\d+\s*[-–~]?\s*\d*\s*年(?:以上)?(?:工作)?经验|经验不限|应届(?:生)?|在校生)/g,
    /(实习(?:生)?|校招|社招|全职|兼职)/g,
  ];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      const v = m[1].trim();
      if (v && !out.includes(v)) out.push(v);
    }
  }
  return out;
}
