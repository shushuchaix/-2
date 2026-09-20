#!/usr/bin/env node
// 环境自检：一键确认各项依赖/密钥/数据通道是否可用
import { loadConfig, ROOT, maskKey } from './config.mjs';
import { DeepSeek } from './llm/deepseek.mjs';
import * as zhaopin from './sources/zhaopin.mjs';
import * as shixiseng from './sources/shixiseng.mjs';
import * as wechat from './sources/wechat.mjs';
import * as nowcoder from './sources/nowcoder.mjs';
import * as university from './sources/university.mjs';
import { searchQuery } from './sources/searchapi.mjs';
import { truncate } from './util/text.mjs';

const PASS = '  ✅';
const FAIL = '  ❌';
const WARN = '  ⚠️ ';
let failures = 0;

function line(icon, label, detail = '') {
  console.log(`${icon} ${label}${detail ? '  —  ' + detail : ''}`);
}

console.log('\n=== 简历岗位雷达 · 环境自检 ===\n');

/* 1. Node 版本 */
const major = Number(process.versions.node.split('.')[0]);
line(major >= 20 ? PASS : FAIL, `Node.js ${process.versions.node}`, major >= 20 ? '' : '需要 >= 20');
if (major < 20) failures++;

/* 2. 配置 */
const cfg = loadConfig({ quiet: true });
line(PASS, '工作目录', ROOT);

/* 3. DeepSeek */
const llm = new DeepSeek(cfg);
if (llm.available) {
  line(PASS, 'DeepSeek API Key', `${maskKey(llm.apiKey)}（来源：${cfg.__deepseekKeySource}）`);
  process.stdout.write('  ⏳ 正在测试 DeepSeek 连通性…');
  try {
    const reply = await llm.chat('你是一个测试助手。', '只回复两个字：正常', { maxTokens: 12, retries: 1 });
    process.stdout.write('\r');
    line(PASS, 'DeepSeek 连通性', `模型 ${llm.model} 回复「${reply.trim().slice(0, 12)}」`);
  } catch (e) {
    process.stdout.write('\r');
    line(FAIL, 'DeepSeek 连通性', e.message);
    failures++;
  }
} else {
  line(WARN, 'DeepSeek API Key 未配置', '将以离线规则模式运行（关键词提取与匹配质量下降）');
}

/* 4. 搜索通道 */
if (cfg.__activeSearchProvider) {
  const provider = cfg.__activeSearchProvider;
  line(PASS, `全网搜索通道：${provider}`, maskKey(cfg.__searchKeys[provider]));
  process.stdout.write('  ⏳ 正在测试搜索通道…');
  try {
    const r = await searchQuery('2026届校园招聘 Java开发 北京', {
      provider,
      apiKey: cfg.__searchKeys[provider],
      maxResults: 3,
      timeoutMs: 25000,
    });
    process.stdout.write('\r');
    line(PASS, `${provider} 连通性`, `返回 ${r.length} 条结果`);
  } catch (e) {
    process.stdout.write('\r');
    line(FAIL, `${provider} 连通性`, e.message);
    failures++;
  }
} else {
  line(WARN, '未配置全网搜索 API Key', '仅使用智联/实习僧直连通道；如需全网检索，请在 config.json 填入 Tavily/博查/Serper 密钥');
}

/* 5. 岗位源 */
process.stdout.write('  ⏳ 正在测试智联招聘通道…');
try {
  const r = await zhaopin.fetchListPage('Java开发', 1, { city: '北京' });
  process.stdout.write('\r');
  if (r.jobs.length) {
    line(PASS, '智联招聘通道', `首条：${r.jobs[0].title} @ ${r.jobs[0].company}`);
  } else {
    line(FAIL, '智联招聘通道', '返回 0 条岗位（页面结构可能已变化）');
    failures++;
  }
} catch (e) {
  process.stdout.write('\r');
  line(FAIL, '智联招聘通道', e.message);
  failures++;
}

process.stdout.write('  ⏳ 正在测试实习僧通道…');
try {
  const r = await shixiseng.fetchListPage('数据分析', 1, { city: '全国' });
  process.stdout.write('\r');
  if (r.jobs.length) {
    line(PASS, '实习僧通道', `首条：${r.jobs[0].title} @ ${r.jobs[0].company}`);
  } else {
    line(FAIL, '实习僧通道', '返回 0 条岗位（页面结构可能已变化）');
    failures++;
  }
} catch (e) {
  process.stdout.write('\r');
  line(FAIL, '实习僧通道', e.message);
  failures++;
}

/* 6. 微信公众号通道 */
process.stdout.write('  ⏳ 正在测试微信公众号通道…');
try {
  // maxFetch: 0 → 只验证搜索可用，不解析链接、不抓正文，避免自检太慢
  const r = await wechat.collectWechat({
    keywords: ['2026届 校园招聘'],
    roleKeywords: ['校园招聘'],
    maxPages: 1,
    maxFetch: 0,
    delayMs: 0,
    log: () => {},
  });
  process.stdout.write('\r');
  if (r.jobs.length) {
    line(PASS, '微信公众号通道', `搜到 ${r.jobs.length} 篇公告，首篇：${truncate(r.jobs[0].title, 28)}`);
  } else {
    line(FAIL, '微信公众号通道', r.stats?.blocked ? '触发搜狗反爬，稍后再试' : '未搜到公告（页面结构可能已变化）');
    failures++;
  }
} catch (e) {
  process.stdout.write('\r');
  line(FAIL, '微信公众号通道', e.message);
  failures++;
}

/* 7. 牛客校招通道 */
process.stdout.write('  ⏳ 正在测试牛客校招通道…');
try {
  const r = await nowcoder.fetchCampusJobs();
  process.stdout.write('\r');
  if (r.jobs.length) {
    const years = [...new Set(r.jobs.map((j) => j.extra.graduationYear).filter(Boolean))];
    line(PASS, '牛客校招通道', `${r.jobs.length} 个校招岗位，届别字段：${years.slice(0, 4).join('/') || '无'}`);
  } else {
    line(FAIL, '牛客校招通道', r.note || '返回 0 个岗位（页面结构可能已变化）');
    failures++;
  }
} catch (e) {
  process.stdout.write('\r');
  line(FAIL, '牛客校招通道', e.message);
  failures++;
}

/* 8. 高校就业网通道 */
process.stdout.write('  ⏳ 正在测试高校就业网通道…');
try {
  const r = await university.collect({
    keywords: ['Java'],
    hosts: university.DEFAULT_HOSTS,
    maxHosts: 2,
    maxPerKeyword: 5,
    maxDetail: 2,
    delayMs: 300,
    log: () => {},
  });
  process.stdout.write('\r');
  if (r.jobs.length) {
    line(PASS, '高校就业网通道', `${r.stats.hosts} 所学校可用，首条：${truncate(r.jobs[0].title, 26)} @ ${r.jobs[0].extra.university}`);
  } else {
    line(FAIL, '高校就业网通道', '返回 0 个岗位（接口或页面结构可能已变化）');
    failures++;
  }
} catch (e) {
  process.stdout.write('\r');
  line(FAIL, '高校就业网通道', e.message);
  failures++;
}

/* 9. PDF 解析 */
process.stdout.write('  ⏳ 正在测试 PDF 解析依赖…');
try {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  process.stdout.write('\r');
  line(PASS, 'PDF 解析依赖', `pdfjs-dist ${pdfjs.version}`);
} catch (e) {
  process.stdout.write('\r');
  line(FAIL, 'PDF 解析依赖', `未安装，执行 npm install 后重试（${e.message}）`);
  failures++;
}

console.log('');
if (failures === 0) {
  console.log('  ✅ 自检通过，可以启动服务：npm start\n');
} else {
  console.log(`  ❌ 有 ${failures} 项未通过，请按上面的提示修复后重试\n`);
}
process.exit(failures === 0 ? 0 : 1);
