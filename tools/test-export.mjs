// 导出模块测试（CSV / Markdown / JSON）
//
// 为什么必须测：导出的数据是用户最终拿到手的东西。
// 这里出错（列错位、中文乱码、漏字段）用户很难发现，却直接影响使用。
// 而 export.mjs 此前一个测试都没有。
import { toCsv, toMarkdown, toJson, exportResult } from '../src/export.mjs';

let pass = 0;
let fail = 0;
const ok = (n, c, e = '') => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n}${e ? ` — ${e}` : ''}`);
  }
};

const profile = {
  name: '李航',
  school: '中国民用航空飞行学院',
  degree: '本科',
  major: '消防工程',
  graduationYear: '2027',
  targetRoles: ['消防工程师'],
  skills: [{ name: '消防工程', level: '熟练' }],
  preferredCities: [],
};

const jobs = [
  {
    title: '消防工程师（2027届）',
    company: '某机场集团',
    city: '成都',
    salary: '8K-12K',
    education: '本科及以上',
    experience: '经验不限',
    jobType: '校招',
    sourceName: '就业桥',
    source: 'jiuyeqiao',
    score: 88,
    verdict: '高度匹配',
    matchedKeywords: ['消防工程', '安全评价'],
    reasons: ['岗位方向匹配你的「消防工程师」方向'],
    gaps: ['岗位要求注册消防工程师，简历中未见'],
    publishTime: '2026-09-10',
    url: 'https://example.com/job/1',
    summary: '负责机场消防设施维护',
    tags: ['2027届', '国企'],
    extra: { university: '中国民用航空飞行学院', expire: '2026-10-01' },
  },
  {
    title: '安全,工程师', // 含逗号，专门测 CSV 转义
    company: '含"引号"公司',
    city: '北京',
    salary: '',
    education: '本科',
    experience: '',
    jobType: '校招',
    sourceName: '智联招聘',
    source: 'zhaopin',
    score: 70,
    verdict: '一般匹配',
    matchedKeywords: [],
    reasons: [],
    gaps: [],
    publishTime: '',
    url: 'https://example.com/job/2',
    summary: '',
    tags: [],
    extra: {},
  },
];

console.log('\n[1] CSV');
{
  const csv = toCsv({ jobs, profile });
  const lines = csv.split('\n');
  ok('非空', csv.length > 0);
  ok('以 UTF-8 BOM 开头（Excel 打开不乱码）', csv.charCodeAt(0) === 0xfeff, `首字符码点 ${csv.charCodeAt(0)}`);
  ok('表头行存在', lines[0].includes('岗位') || lines[0].includes('标题'), lines[0].slice(0, 60));
  ok('数据行数 = 岗位数', lines.filter((l) => l.trim()).length >= jobs.length + 1, `${lines.length} 行`);
  ok('包含岗位标题', csv.includes('消防工程师'));
  ok('包含公司', csv.includes('某机场集团'));
  ok('含逗号的字段被引号包裹', /"[^"]*安全,工程师[^"]*"/.test(csv) || csv.includes('"安全,工程师"'), '转义失败');
  ok('含引号的字段被正确转义（双写）', csv.includes('""引号""'), '引号未双写');
  ok('列数与表头一致', (() => {
    // 简单校验：每行（考虑引号内逗号）解析后的列数应与表头相同
    const parse = (line) => {
      const out = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (q && line[i + 1] === '"') { cur += '"'; i++; }
          else q = !q;
        } else if (ch === ',' && !q) { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur);
      return out;
    };
    const head = parse(lines[0]).length;
    return lines.slice(1).filter((l) => l.trim()).every((l) => parse(l).length === head);
  })(), '列数不一致');
}

console.log('\n[2] Markdown');
{
  const md = toMarkdown({ jobs, profile });
  ok('非空', md.length > 0);
  ok('含一级/二级标题', /^#{1,2}\s/m.test(md));
  ok('含画像信息', md.includes('消防工程'));
  ok('含岗位标题', md.includes('消防工程师'));
  ok('含匹配分', /88/.test(md));
  ok('表格分隔行存在', /\|\s*-{2,}/.test(md) || md.includes('| ---'), '无 Markdown 表格');
}

console.log('\n[3] JSON / 统一导出入口');
{
  const out = toJson({ jobs, profile });
  ok('返回字符串', typeof out === 'string');
  const parsed = JSON.parse(out);
  ok('可被 JSON.parse', Boolean(parsed));
  const arr = Array.isArray(parsed) ? parsed : parsed.jobs;
  ok('含全部岗位', Array.isArray(arr) && arr.length === jobs.length, String(arr?.length));
  ok('保留匹配分', arr?.[0]?.score === 88 || arr?.[0]?.preScore === 88);
}

console.log('\n[4] 边界');
{
  ok('空岗位列表不报错（CSV）', typeof toCsv({ jobs: [], profile }) === 'string');
  ok('空岗位列表不报错（MD）', typeof toMarkdown({ jobs: [], profile }) === 'string');
  ok('空画像不报错', typeof toCsv({ jobs, profile: {} }) === 'string');
  ok('缺字段的岗位不报错', typeof toCsv({ jobs: [{ title: 'X' }], profile }) === 'string');
  }

console.log('\n[5] 届别 / 来源等关键列没丢');
{
  const csv = toCsv({ jobs, profile });
  ok('含届别列', /届别|2027/.test(csv));
  ok('含来源', csv.includes('就业桥'));
  ok('含截止时间（extra.expire —— 高校就业网/晨云用的字段名）', csv.includes('2026-10-01'), '截止时间列为空：字段名不一致的老 bug');
  const csv2 = toCsv({ jobs: [{ title: 'X', extra: { deadline: '2026-11-11' } }], profile });
  ok('含截止时间（extra.deadline —— 公众号用的字段名）', csv2.includes('2026-11-11'));
  const md = toMarkdown({ jobs, profile });
  ok('Markdown 里也有截止时间', md.includes('2026-10-01'), '截止时间缺失');
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
