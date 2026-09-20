#!/usr/bin/env node
// 命令行入口：无界面跑完整个流程
// 用法：node src/cli.mjs --resume 简历.txt --cities 北京,上海 --keywords Java开发 --out result.json
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ensureDataDirs, ROOT } from './config.mjs';
import { DeepSeek } from './llm/deepseek.mjs';
import { extractResumeText } from './resume/extract-text.mjs';
import { runPipeline, saveRun } from './pipeline.mjs';
import { exportResult } from './export.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`
简历岗位雷达 · 命令行用法

  node src/cli.mjs --resume <简历文件> [选项]

选项：
  --resume <路径>     简历文件（PDF/DOCX/TXT/MD）或纯文本文件；也可用 --text 直接给文本
  --text <字符串>     直接传入简历文本
  --cities <列表>     期望城市，逗号分隔，例如 北京,上海
  --keywords <列表>   岗位关键词，逗号分隔，覆盖自动生成
  --year <年份>       目标毕业届别，例如 2027（只保留面向该校的校招岗位）
  --no-intern         排除实习岗，只留正式校招
  --all-years         关闭届别过滤，保留所有届别
  --format <格式>     输出格式：json（默认）/ csv / md
  --out <路径>        结果写入文件（默认写入 data/runs/ 并打印摘要）
  --no-llm            不使用 DeepSeek，仅离线规则模式
  --top <数字>        只打印前 N 个岗位（默认 15）
  --help              显示本帮助
`);
  process.exit(0);
}

function splitList(v) {
  return String(v || '')
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readResume() {
  if (args.text) return { text: String(args.text), from: '命令行 --text' };
  const file = args.resume || args._[0];
  if (!file) {
    console.error('错误：请用 --resume <文件> 指定简历，或用 --text "<简历文本>" 直接传入。加 --help 查看用法。');
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error(`错误：找不到文件 ${abs}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(abs);
  const { text, format } = await extractResumeText(buf, path.basename(abs));
  console.log(`已读取简历：${path.basename(abs)}（${format}，${text.length} 字）`);
  return { text, from: abs };
}

(async () => {
  ensureDataDirs();
  const cfg = loadConfig();
  const llm = new DeepSeek(cfg);
  const useLlm = args['no-llm'] ? false : undefined;

  const { text } = await readResume();
  if (!text || text.trim().length < 30) {
    console.error('错误：简历内容太短，无法分析。');
    process.exit(1);
  }

  const options = { useLlm };
  const cities = splitList(args.cities);
  const keywords = splitList(args.keywords);
  if (cities.length) options.cities = cities;
  if (keywords.length) options.titleKeywords = keywords;
  // 届别：--year 覆盖配置；--all-years 显式关闭过滤
  if (args['all-years']) options.graduationYear = '';
  else if (args.year) options.graduationYear = String(args.year).replace(/届$/, '');
  if (args['no-intern']) options.includeInternship = false;

  const BAR = 26;
  let lastStage = '';
  const t0 = Date.now();

  const result = await runPipeline({
    resumeText: text,
    llm,
    cfg,
    options,
    onEvent: (ev) => {
      if (ev.type === 'stage') {
        lastStage = ev.label;
        console.log(`\n▶ ${ev.label}`);
      } else if (ev.type === 'log') {
        console.log(`   ${ev.message}`);
      } else if (ev.type === 'profile') {
        const p = ev.profile;
        console.log(`   画像：${p.degree || '?'} · ${p.targetRoles.join('、') || '未识别岗位'} · 城市 ${p.preferredCities.join('/') || '不限'}`);
      }
    },
  });

  const topN = Number(args.top) || 15;
  console.log('\n' + '─'.repeat(78));
  console.log(`完成：命中 ${result.jobs.length} 个岗位（原始 ${result.stats.rawCount} 条，去重后 ${result.stats.afterDedupe} 条），耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`数据来源：智联 ${result.stats.zhaopin} · 实习僧 ${result.stats.shixiseng} · 全网搜索 ${result.stats.web}`);
  console.log('─'.repeat(78));
  console.log('');

  result.jobs.slice(0, topN).forEach((j, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${String(j.score).padStart(3)}分 ${j.verdict}] ${j.title}`);
    console.log(`    ${j.company || '未知公司'} · ${j.city || '-'} · ${j.salary || '薪资未标注'} · ${j.education || '-'} · ${j.jobType || '-'}`);
    if (j.matchedKeywords?.length) console.log(`    命中：${j.matchedKeywords.slice(0, 10).join('、')}`);
    if (j.reasons?.length) console.log(`    理由：${j.reasons.slice(0, 3).join('；')}`);
    if (j.gaps?.length) console.log(`    差距：${j.gaps.slice(0, 2).join('；')}`);
    console.log(`    ${j.url}`);
    console.log('');
  });

  if (result.errors?.length) {
    console.log('运行告警：');
    result.errors.slice(0, 10).forEach((e) => console.log(`  ! ${e}`));
    console.log('');
  }
  if (result.llmUsage) {
    console.log(`LLM 用量：${result.llmUsage.calls} 次调用，输入 ${result.llmUsage.promptTokens} tokens，输出 ${result.llmUsage.completionTokens} tokens\n`);
  }

  const saved = await saveRun(result);
  console.log(`结果已保存：${path.relative(ROOT, saved)}`);

  if (args.out) {
    const format = String(args.format || (String(args.out).endsWith('.csv') ? 'csv' : String(args.out).endsWith('.md') ? 'md' : 'json'));
    const { body } = exportResult(result, format);
    fs.writeFileSync(path.resolve(process.cwd(), args.out), body, 'utf8');
    console.log(`已导出 ${format.toUpperCase()}：${args.out}`);
  }
})().catch((e) => {
  console.error('\n运行失败：', e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
