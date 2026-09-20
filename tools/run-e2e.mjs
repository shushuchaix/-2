// 端到端跑一次完整流水线（不调用 LLM，只验证采集 / 过滤 / 打分链路）
// 用法：node tools/run-e2e.mjs [简历文件] [--llm]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { runPipeline } from '../src/pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const useLlm = args.includes('--llm');
const resumeFile = args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'tools', 'sample-resume.txt');
const resumeText = fs.readFileSync(resumeFile, 'utf8');

const cfg = loadConfig();
// 不配 search key 时全网搜索通道本来就是关的，这里只确认一下
console.log(`简历：${path.basename(resumeFile)}（${resumeText.length} 字）`);
console.log(`LLM：${useLlm ? '开启' : '关闭（仅验证采集链路）'}`);
console.log(`届别过滤：${cfg.filters.graduationYear} 届  实习：${cfg.filters.includeInternship ? '含' : '不含'}\n`);

let llm = null;
if (useLlm) {
  const { DeepSeek } = await import('../src/llm/deepseek.mjs');
  llm = new DeepSeek(cfg);
  console.log(`LLM 可用：${llm.available}\n`);
}

const stages = new Map();
const t0 = Date.now();
const result = await runPipeline({
  resumeText,
  llm,
  cfg,
  options: { useLlm },
  onEvent: (e) => {
    if (e.type === 'log') {
      const m = String(e.message);
      // 只打印关键行，避免刷屏
      if (/高校就业网|检索计划|专业「|就业网|采集|过滤|去重|打分|入围|完成|失败|✅|探测/.test(m)) {
        console.log(`  ${m}`);
      }
    } else if (e.type === 'stage') {
      stages.set(e.stage, Date.now() - t0);
      console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)}s] ▶ ${e.label}`);
    }
  },
});

const secs = (Date.now() - t0) / 1000;
console.log(`\n${'='.repeat(72)}`);
console.log(`  耗时 ${secs.toFixed(1)}s`);
console.log(`  统计 ${JSON.stringify(result.stats)}`);
console.log(`  错误 ${result.errors.length} 条`);
for (const e of result.errors.slice(0, 6)) console.log(`    ! ${e}`);
console.log(`${'='.repeat(72)}`);

console.log(`\n最终岗位 ${result.jobs.length} 条：`);
const byUni = {};
for (const j of result.jobs) {
  if (j.source === 'university') byUni[j.extra?.university] = (byUni[j.extra?.university] || 0) + 1;
}
for (const j of result.jobs.slice(0, 25)) {
  console.log(
    `  · [${(j.sourceName || j.source).slice(0, 18)}] ${String(j.title).slice(0, 40)}  @${j.company || '?'}  ${j.city || ''}`,
  );
}
if (Object.keys(byUni).length) {
  console.log(`\n来源高校分布：${Object.entries(byUni).map(([k, v]) => `${k}×${v}`).join('，')}`);
}

fs.writeFileSync(path.join(ROOT, 'data', 'e2e-university.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(`\n完整结果已写入 data/e2e-university.json`);
