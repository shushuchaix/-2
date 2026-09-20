// 离线（不调用 LLM）的简历画像提取：词表匹配 + 规则推断
// 作为无 API Key 或 LLM 失败时的降级通道，保证流程仍可跑通
import { guessCitiesFromText } from './cities.mjs';
import { extractTechTerms } from '../util/skills.mjs';

const TITLE_RULES = [
  [/(算法|机器学习|深度学习|NLP|计算机视觉|大模型|AI)[^\n，。；]{0,8}(工程师|实习生|开发)/i, '算法工程师'],
  [/(前端|web前端|H5)[^\n，。；]{0,6}(工程师|开发|实习生)/i, '前端开发工程师'],
  [/(后端|服务端|Java|Go|Python|PHP|C\+\+)[^\n，。；]{0,8}(工程师|开发|实习生)/i, '后端开发工程师'],
  [/(全栈|全链路)[^\n，。；]{0,6}(工程师|开发)/i, '全栈开发工程师'],
  [/(测试|QA)[^\n，。；]{0,6}(工程师|开发|实习生)/i, '测试开发工程师'],
  [/(运维|SRE|DevOps)[^\n，。；]{0,6}(工程师|实习生)?/i, '运维开发工程师'],
  [/(数据分析|数据开发|数据仓库|大数据|BI)[^\n，。；]{0,6}(师|工程师|实习生|岗)?/i, '数据分析师'],
  [/(产品经理|产品助理|产品实习)/i, '产品经理'],
  [/(运营)[^\n，。；]{0,4}(实习|专员|助理)?/i, '运营专员'],
  [/(UI|交互|视觉)[^\n，。；]{0,4}(设计)/i, 'UI设计师'],
  // 消防/安全工程必须排在 IT 安全之前：否则「消防安全」「安全工程」会被下面那条的裸「安全」吃掉
  [/(消防|安全工程|安全管理|安全生产|安全评价|应急管理|EHS|HSE)[^\n，。；]{0,8}(工程师|管理员|专员|实习生)?/i, '消防/安全工程师'],
  // 收紧为明确的 IT 安全措辞 —— 原来这里是 (网络安全|信息安全|渗透|安全)，
  // 那个裸的「安全」会把消防工程、生产安全全都误判成 IT 安全工程师
  [/(网络安全|信息安全|渗透测试|等保|安全攻防|Web安全)[^\n，。；]{0,6}(工程师|实习生)?/i, '信息安全工程师'],
  [/(嵌入式|单片机|硬件)[^\n，。；]{0,6}(工程师|开发)?/i, '嵌入式开发工程师'],
  [/(财务|会计|审计|税务)[^\n，。；]{0,4}(实习|专员|助理)?/i, '财务专员'],
  [/(人力|HR)[^\n，。；]{0,4}(实习|专员|助理)?/i, '人力资源专员'],
  [/(市场|营销|品牌|商务)[^\n，。；]{0,4}(实习|专员|助理)?/i, '市场营销专员'],
  [/(机械|结构|工艺)[^\n，。；]{0,6}(工程师|设计)?/i, '机械工程师'],
  [/(电气|自动化|控制)[^\n，。；]{0,6}(工程师)?/i, '电气工程师'],
];

const DEGREES = [
  ['博士', /博士|Ph\.?D/i],
  ['硕士', /硕士|研究生|MBA|Master/i],
  ['本科', /本科|学士|Bachelor/i],
  ['大专', /大专|专科|高职/i],
];

function detectDegree(text) {
  for (const [name, re] of DEGREES) if (re.test(text)) return name;
  return '';
}

function detectGraduation(text) {
  const m = text.match(/(20\d{2})\s*[年\-/]?\s*(?:届|毕业|年毕业)/) || text.match(/(?:毕业|届)[^\d]{0,4}(20\d{2})/);
  if (m) return m[1];
  const m2 = text.match(/(20\d{2})\s*[.\-/]\s*(?:0?[1-9]|1[0-2])\s*[-–~至]\s*(20\d{2})/);
  if (m2) return m2[2];
  return '';
}

function detectSchool(text) {
  const m = text.match(/([\u4e00-\u9fa5]{2,12}(?:大学|学院|理工大学|师范大学|财经大学|职业技术学院))/);
  return m ? m[1] : '';
}

function detectMajor(text) {
  const m = text.match(/([\u4e00-\u9fa5]{2,10}(?:专业|工程|科学与技术|技术))(?![^\n]{0,6}公司)/);
  if (m) return m[1].replace(/专业$/, '');
  return '';
}

function detectName(text) {
  const m = text.match(/(?:姓\s*名|名字)\s*[:：]?\s*([\u4e00-\u9fa5]{2,4})/);
  if (m) return m[1];
  const first = text.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(first)) return first;
  return '';
}

function detectTitles(text) {
  const out = [];
  for (const [re, title] of TITLE_RULES) {
    if (re.test(text) && !out.includes(title)) out.push(title);
  }
  return out;
}

/** 离线画像 */
export function analyzeResumeOffline(resumeText) {
  const text = String(resumeText || '');
  const skills = extractTechTerms(text);
  const targetRoles = detectTitles(text);
  const degree = detectDegree(text);
  const cities = guessCitiesFromText(text);
  const graduationYear = detectGraduation(text);

  if (targetRoles.length === 0 && skills.length) {
    const has = (...t) => t.some((x) => skills.includes(x));
    if (has('Java', 'Spring', 'Spring Boot', 'MyBatis')) targetRoles.push('后端开发工程师');
    else if (has('React', 'Vue', 'JavaScript', 'TypeScript')) targetRoles.push('前端开发工程师');
    else if (has('Python', 'Pandas', 'SQL', '数据分析')) targetRoles.push('数据分析师');
    else if (has('PyTorch', 'TensorFlow', '机器学习')) targetRoles.push('算法工程师');
    else if (has('Docker', 'Kubernetes', 'Linux')) targetRoles.push('运维开发工程师');
    else targetRoles.push('技术类岗位');
  }

  const titleKeywords = [...new Set(targetRoles.map((r) => r.replace(/工程师$|专员$|师$/, '').trim() || r))].slice(0, 5);
  const jobTypes = /实习/.test(text) ? ['实习', '校招'] : ['校招'];

  return {
    name: detectName(text),
    school: detectSchool(text),
    degree,
    major: detectMajor(text),
    graduationYear,
    targetRoles,
    jobTypes,
    preferredCities: cities,
    skills: skills.map((s) => ({ name: s, level: '熟悉' })),
    certificates: [],
    awards: [],
    internships: [],
    projects: [],
    keywords: skills,
    titleKeywords: titleKeywords.length ? titleKeywords : ['应届生'],
    webQueries: [],
    summary: `${degree || '大学'}${targetRoles[0] ? ' · 目标' + targetRoles[0] : ''}${skills.length ? ' · 技能' + skills.slice(0, 5).join('/') : ''}`.slice(0, 60),
    strengths: skills.slice(0, 4),
    gaps: [],
    __offline: true,
  };
}
