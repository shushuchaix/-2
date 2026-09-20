// 院校 / 专业的「毕业生去向」种子数据
//
// 用途：单靠岗位标题关键词检索，会漏掉那些**标题里不写专业名**的对口岗位
// （例如「危险品培训专员」「隐患治理专员」「场站运行」）。
// 而学校官方发布的就业质量报告 / 专业简介里，会明确列出毕业生实际去了哪些单位、哪些行业，
// 这是最权威的「该专业到底去哪就业」的依据，拿来当检索种子和打分加权都很准。
//
// 数据来源（均为学校官方公开页面，2026-09 采集）：
//   中国民用航空飞行学院 消防工程专业简介
//   https://www.cafuc.edu.cn/jwcx/info/1185/1535.htm
//
// ⚠️ 只收录**原文明确写到**的单位与行业，不做推测。原文没提的一律不加。

/**
 * @typedef {object} DestinationProfile
 * @property {string} school      学校名（用于匹配简历）
 * @property {string} [major]     专业名（正则字符串，留空表示该校通用）
 * @property {string[]} employers 官方点名提到接收毕业生的单位
 * @property {string[]} industries 官方点名的行业方向
 * @property {string[]} roles     官方点名的岗位方向
 * @property {string[]} extraQueries 补充检索词（标题里常不含专业名的岗位叫法）
 * @property {string} source      出处，便于核对
 * @property {string} note        原文里关于去向的原话摘要
 */
export const DESTINATIONS = [
  {
    school: '中国民用航空飞行学院',
    major: '消防工程',
    // 原文：「毕业生广泛就业于上海浦东国际机场、虹桥国际机场、深圳宝安国际机场等行业龙头企业的消防部门」
    employers: [
      '上海浦东国际机场',
      '上海虹桥国际机场',
      '深圳宝安国际机场',
      // 原文点名接收毕业生较多的单位：「前往中安保实业集团有限公司三门分公司的学生也较多，24届中有14名学生前往，成为消防工程师储备干部」
      '中安保实业集团有限公司',
      // 产教融合协同育人单位（原文「与…共同制定产教融合协同育人的培养方案」）
      '四川川消消防车辆有限公司',
      '广州白云国际机场',
      '乌鲁木齐天山国际机场',
    ],
    // 原文：「2023届…26%为航司、机场，其次是新能源类和铁路等相关企业；2024届…29%为航司、机场，其次是其他类、升学、铁路类企业」
    industries: ['航空公司', '机场', '新能源', '铁路', '消防设施设备'],
    // 原文培养目标：「能够在运输航空公司、通用航空公司应急救援部门、消防设施设备类单位、
    // 机场消防支队，及中铁、中保等企事业单位中胜任消防安全管理与航空应急救援岗位」
    roles: [
      '消防工程师',
      '消防安全管理',
      '航空应急救援',
      '机场消防',
      '消防设施',
      '危险品管理',
      '安全管理',
      '应急管理',
    ],
    // 这些岗位名标题里通常不写「消防」，但确实是该专业对口岗 —— 不补就会整片漏掉
    extraQueries: [
      '机场消防',
      '航空安全',
      '应急救援',
      '危险品',
      '消防安全管理',
      '机场运行',
      '安检',
      '消防设施操作员',
      '新能源安全',
      '铁路安全',
    ],
    source: 'https://www.cafuc.edu.cn/jwcx/info/1185/1535.htm',
    note:
      '2023届毕业生 70% 签约、2024届 78% 签约；23届 26%、24届 29% 去向为航司/机场；' +
      '24届有 14 名学生进入中安保实业集团三门分公司任消防工程师储备干部。',
  },
];

/** 取某个「学校 + 专业」的去向档案；没有则返回 null */
export function destinationFor(profile = {}) {
  const school = String(profile.school || '');
  const major = String(profile.major || '');
  if (!school) return null;
  return (
    DESTINATIONS.find(
      (d) => school.includes(d.school) && (!d.major || new RegExp(d.major).test(major)),
    ) || null
  );
}

/**
 * 把去向数据转成补充检索词。
 * 单位名也一样值得当检索词：企业官网/公众号发的公告标题里常带自己的全称。
 */
export function destinationQueries(profile = {}, { max = 10 } = {}) {
  const d = destinationFor(profile);
  if (!d) return { queries: [], employers: [], roles: [], industries: [], source: '' };
  const shortEmployers = d.employers.map((e) => e.replace(/(股份有限公司|有限公司|有限责任公司|集团)$/, ''));
  const queries = [
    ...d.extraQueries,
    ...shortEmployers.slice(0, 3), // 单位名太多会挤掉岗位词，取前几个
  ];
  return {
    queries: [...new Set(queries)].filter(Boolean).slice(0, max),
    employers: d.employers,
    roles: d.roles,
    industries: d.industries,
    source: d.source,
    note: d.note,
  };
}

/**
 * 行业标签 → 匹配模式。
 * 不能拿标签本身做子串匹配：「航空公司」匹配不到「圆通航空集团」「海航航空技术」，
 * 而这些恰恰就是该行业的真实企业名。
 */
const INDUSTRY_PATTERN = {
  航空公司: /航空(公司|集团|股份|技术|有限)/,
  机场: /机场/,
  新能源: /新能源|光伏|储能|锂电|风电|氢能/,
  铁路: /铁路|轨道交通|中铁|铁建|地铁/,
  消防设施设备: /消防(设施|设备|器材|车辆|工程|技术)/,
};

/** 岗位是否命中「毕业生去向」里的单位/行业（用于打分加权） */
export function matchesDestination(job, profile = {}) {
  const d = destinationFor(profile);
  if (!d) return { hit: false, what: '' };
  const hay = `${job.title || ''} ${job.company || ''} ${job.description || ''}`;
  for (const e of d.employers) {
    const core = e.replace(/(股份有限公司|有限公司|有限责任公司|集团)$/, '');
    if (core.length >= 4 && hay.includes(core)) return { hit: true, what: core, kind: 'employer' };
  }
  for (const i of d.industries) {
    const re = INDUSTRY_PATTERN[i];
    if (re ? re.test(hay) : hay.includes(i)) return { hit: true, what: i, kind: 'industry' };
  }
  return { hit: false, what: '' };
}
