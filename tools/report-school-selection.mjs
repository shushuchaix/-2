// 自动选校结果反馈：① 选校矩阵  ② 未收录学校的真实探测命中率
// 用法：node tools/report-school-selection.mjs [--sweep]
import { resolveHosts, discoverHost, VERIFIED_HOSTS, preferredKinds, isOwnSchool } from '../src/sources/university.mjs';

const SWEEP = process.argv.includes('--sweep');

/* ============================================================
   ① 选校矩阵：不同「学校 × 专业」会选出哪些就业网
   ============================================================ */
const PROFILES = [
  { school: '西安电子科技大学', major: '计算机科学与技术', note: '本校已收录 + IT 专业' },
  { school: '西安电子科技大学', major: '会计学', note: '本校已收录 + 非 IT 专业' },
  { school: '郑州大学', major: '软件工程', note: '本校已收录(综合) + IT 专业' },
  { school: '大连海事大学', major: '金融学', note: '本校已收录(理工) + 财经专业' },
  { school: '北京邮电大学', major: '计算机科学与技术', note: '本校未收录(有缩写) + IT 专业' },
  { school: '北京邮电大学', major: '英语', note: '本校未收录 + 冷门专业' },
  { school: '上海财经大学', major: '会计学', note: '本校未收录(财经) + 财经专业' },
  { school: '某某职业技术学院', major: '计算机应用', note: '缩写表里没有的学校' },
  { school: '', major: '计算机科学与技术', note: '简历没写学校 + IT 专业' },
  { school: '', major: '', note: '学校专业都没有' },
];

console.log('='.repeat(78));
console.log('  ① 选校矩阵：不同「学校 × 专业」选出的就业网');
console.log('='.repeat(78));

const rows = [];
for (const p of PROFILES) {
  const log = [];
  const hosts = await resolveHosts(p, { maxHosts: 4, log: (m) => log.push(m.trim()) });
  const own = p.school && hosts.some((h) => isOwnSchool(h, p));
  rows.push({
    profile: `${p.school || '(未写)'} / ${p.major || '(未写)'}`,
    kinds: preferredKinds(p).join(',') || '-',
    selected: hosts.map((h) => h.name).join('、'),
    own: own ? '本校✓' : p.school ? '本校✗' : '-',
    note: p.note,
  });
  // 逐行打印探测/选校日志（去重）
  for (const m of [...new Set(log)]) console.log(`    ↳ ${m}`);
}
console.log('');
for (const r of rows) {
  console.log(`  ${r.profile}`);
  console.log(`    专业类型偏好: ${r.kinds}   本校命中: ${r.own}`);
  console.log(`    选中: ${r.selected}`);
  console.log(`    场景: ${r.note}\n`);
}

/* ============================================================
   ③ 定向补录：财经 / 师范 / 综合类院校有没有可用的就业网
   ============================================================ */
if (process.argv.includes('--enrich')) {
  console.log('\n' + '='.repeat(78));
  console.log('  ③ 定向探测：补 finance / normal / general 三类院校');
  console.log('='.repeat(78) + '\n');

  const GROUPS = {
    finance: ['东北财经大学', '天津财经大学', '山西财经大学', '云南财经大学', '山东财经大学', '广东财经大学', '安徽财经大学', '河北经贸大学'],
    normal: ['北京师范大学', '华东师范大学', '华中师范大学', '南京师范大学', '华南师范大学', '湖南师范大学', '陕西师范大学', '东北师范大学', '首都师范大学', '山东师范大学', '浙江师范大学', '福建师范大学'],
    general: ['兰州大学', '云南大学', '广西大学', '贵州大学', '南昌大学', '安徽大学', '河南大学', '山西大学', '河北大学', '湖北大学', '黑龙江大学', '辽宁大学'],
  };

  const hit = {};
  for (const [kind, schools] of Object.entries(GROUPS)) {
    console.log(`  【${kind}】`);
    for (const s of schools) {
      const log = [];
      const host = await discoverHost(s, { log: (m) => log.push(m.trim()), force: true });
      if (host) {
        (hit[kind] ||= []).push({ s, host });
        console.log(`    ✅ ${s.padEnd(12)} ${host}`);
      } else {
        console.log(`    ❌ ${s.padEnd(12)} 不支持`);
      }
    }
    console.log('');
  }

  console.log('  命中汇总（可直接补进 VERIFIED_HOSTS）：');
  for (const [kind, list] of Object.entries(hit)) {
    for (const { s, host } of list) console.log(`    { name: '${s}', host: '${host}', kind: '${kind}' },`);
  }
  if (!Object.keys(hit).length) console.log('    （无）');
}

/* ============================================================
   ② 探测命中率：拿未收录的学校走一遍真实探测
   ============================================================ */
if (SWEEP) {
  console.log('='.repeat(78));
  console.log('  ② 未收录学校的真实探测（用生产代码 discoverHost）');
  console.log('='.repeat(78));
  console.log('  说明：discoverHost 会依次尝试 7 种域名模式，全部失败才算不支持。\n');

  const SCHOOLS = [
    '电子科技大学', '哈尔滨工业大学', '北京理工大学', '大连理工大学',
    '华南理工大学', '西安交通大学', '华中科技大学', '北京航空航天大学',
    '南京航空航天大学', '南京理工大学', '西北工业大学', '中国科学技术大学',
    '东南大学', '天津大学', '同济大学', '上海交通大学',
    '上海财经大学', '中央财经大学', '西南财经大学', '南京审计大学',
    '北京大学', '浙江大学', '南京大学', '四川大学', '山东大学', '厦门大学',
    '江苏大学', '扬州大学', '湘潭大学', '宁波大学',
    '郑州大学', // 对照组：注册表里已收录
  ];

  const found = [];
  const missed = [];
  const unknownAbbr = [];
  let idx = 0;
  for (const s of SCHOOLS) {
    idx++;
    const t0 = Date.now();
    const log = [];
    const host = await discoverHost(s, { log: (m) => log.push(m.trim()), force: true });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (log.some((m) => /未收录/.test(m))) {
      unknownAbbr.push(s);
      console.log(`  [${String(idx).padStart(2)}/${SCHOOLS.length}] ${s.padEnd(12)} 缩写表未收录  ${secs}s`);
    } else if (host) {
      found.push({ s, host });
      console.log(`  [${String(idx).padStart(2)}/${SCHOOLS.length}] ${s.padEnd(12)} ✅ ${host}  ${secs}s`);
    } else {
      missed.push(s);
      console.log(`  [${String(idx).padStart(2)}/${SCHOOLS.length}] ${s.padEnd(12)} ❌ 7 种域名全不支持  ${secs}s`);
    }
  }

  console.log(`\n  探测 ${SCHOOLS.length} 所：命中 ${found.length}，不支持 ${missed.length}，缩写表未收录 ${unknownAbbr.length}`);
  const newOnes = found.filter((f) => !VERIFIED_HOSTS.some((v) => v.host === f.host));
  console.log(`  其中不在注册表里的新发现：${newOnes.length}${newOnes.length ? ' → ' + newOnes.map((n) => `${n.s} ${n.host}`).join('，') : ''}`);
  console.log(`  不支持：${missed.join('、') || '（无）'}`);
  console.log(`  缩写表未收录：${unknownAbbr.join('、') || '（无）'}`);
}
