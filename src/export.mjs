// 结果导出：CSV / Markdown / JSON
import { verdictOf } from './match/score.mjs';
import { csvCell } from './domain/redact.mjs';

const HEADERS = ['排名', '匹配分', '评级', '岗位', '公司', '城市', '薪资', '学历', '经验', '类型', '届别', '命中关键词', '匹配理由', '差距', '来源', '公众号', '招聘批次', '截止时间', '投递方式', '发布时间', '链接', '标题待确认'];

// 截止时间字段历史上被两个源用了不同的名字：
//   · 公众号（article.mjs）用 extra.deadline
//   · 高校就业网 / 晨云（university / chenyun）用 extra.expire
// 而这里只读了 deadline —— 结果「截止时间」这一列在前两个源上**一直是空的**，
// 数据明明抓到了却没导出来。现在两个名字都认。
function deadlineOf(j) {
  return j?.extra?.deadline || j?.extra?.expire || '';
}

function row(j, i) {
  return [
    i + 1,
    j.score ?? '',
    verdictOf(j),
    j.title || '',
    j.company || '',
    j.city || '',
    j.salary || '',
    j.education || '',
    j.experience || '',
    j.jobType || '',
    j.yearMatch?.years?.length ? `${j.yearMatch.years.join('/')}届` : j.yearMatch ? `${j.yearMatch.year}届校招` : '',
    (j.matchedKeywords || []).slice(0, 12).join(' / '),
    (j.reasons || []).join('；'),
    (j.gaps || []).join('；'),
    j.sourceName || j.source || '',
    j.extra?.account || '',
    j.extra?.batch || '',
    deadlineOf(j),
    j.extra?.applyMethod || '',
    j.publishTime || '',
    j.url || '',
    j.titleObfuscated && !j.titleRepaired ? '是' : '',
  ];
}


export function toCsv(result) {
  const lines = [HEADERS.map(csvCell).join(',')];
  result.jobs.forEach((j, i) => lines.push(row(j, i).map(csvCell).join(',')));
  // 加 BOM 让 Excel 正确识别 UTF-8
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function toMarkdown(result) {
  const p = result.resumeProfile || {};
  const out = [];
  out.push(`# 岗位匹配报告`);
  out.push('');
  out.push(`- 生成时间：${new Date(result.createdAt).toLocaleString('zh-CN')}`);
  out.push(`- 耗时：${(result.durationMs / 1000).toFixed(1)} 秒`);
  out.push(`- 画像：${p.summary || '-'}`);
  out.push(`- 目标岗位：${(p.targetRoles || []).join('、') || '-'}`);
  out.push(`- 期望城市：${(p.preferredCities || []).join('、') || '不限'}`);
  out.push(`- 技能关键词：${(p.keywords || []).slice(0, 25).join('、') || '-'}`);
  out.push('');
  out.push(`## 检索统计`);
  out.push('');
  out.push(`| 指标 | 数值 |`);
  out.push(`| --- | --- |`);
  out.push(`| 抓取原始岗位 | ${result.stats?.rawCount ?? '-'} |`);
  out.push(`| 去重后 | ${result.stats?.afterDedupe ?? '-'} |`);
  out.push(`| 返回结果 | ${result.jobs.length} |`);
  out.push(`| 智联招聘 | ${result.stats?.zhaopin ?? 0} |`);
  out.push(`| 实习僧 | ${result.stats?.shixiseng ?? 0} |`);
  out.push(`| 全网搜索 | ${result.stats?.web ?? 0} |`);
  out.push(`| 微信公众号 | ${result.stats?.wechat ?? 0} 篇公告${result.stats?.wechatJobs ? `（抽出 ${result.stats.wechatJobs} 个岗位）` : ''} |`);
  out.push('');
  out.push(`## 推荐岗位（共 ${result.jobs.length} 个）`);
  out.push('');
  result.jobs.forEach((j, i) => {
    out.push(`### ${i + 1}. ${j.title} — ${j.company || '未知公司'}  【${j.score ?? '-'} 分 · ${verdictOf(j)}】`);
    out.push('');
    out.push(`- 城市：${j.city || '-'}${j.district ? ' ' + j.district : ''}`);
    out.push(`- 薪资：${j.salary || '未标注'}｜学历：${j.education || '未标注'}｜经验：${j.experience || '未标注'}｜类型：${j.jobType || '未标注'}`);
    if (j.matchedKeywords?.length) out.push(`- 命中关键词：${j.matchedKeywords.slice(0, 12).join('、')}`);
    if (j.reasons?.length) out.push(`- 匹配理由：${j.reasons.join('；')}`);
    if (j.gaps?.length) out.push(`- 待补差距：${j.gaps.join('；')}`);
    if (j.extra?.batch) out.push(`- 招聘批次：${j.extra.batch}`);
    if (j.extra?.deadline || j.extra?.expire) out.push(`- 截止时间：${deadlineOf(j)}`);
    if (j.extra?.applyMethod) out.push(`- 投递方式：${j.extra.applyMethod}`);
    out.push(`- 来源：${j.sourceName || j.source}${j.publishTime ? '｜发布：' + j.publishTime : ''}`);
    if (j.extra?.articleTitle) out.push(`- 公告标题：${j.extra.articleTitle}`);
    out.push(`- 链接：${j.url || '-'}`);
    out.push('');
  });
  if (result.errors?.length) {
    out.push(`## 运行告警`);
    out.push('');
    result.errors.forEach((e) => out.push(`- ${e}`));
    out.push('');
  }
  return out.join('\n');
}

export function toJson(result) {
  return JSON.stringify(result, null, 2);
}

export function exportResult(result, format = 'json') {
  const f = String(format).toLowerCase();
  if (f === 'csv') return { body: toCsv(result), ext: 'csv', mime: 'text/csv; charset=utf-8' };
  if (f === 'md' || f === 'markdown') return { body: toMarkdown(result), ext: 'md', mime: 'text/markdown; charset=utf-8' };
  return { body: toJson(result), ext: 'json', mime: 'application/json; charset=utf-8' };
}
