// 岗位索引（持久层）测试
// 重点验证**跨检索**行为 —— 单次调用测不出「新增/消失」，必须模拟多轮。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 独立数据目录，避免碰真实的 data/job-index.json
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rjr-store-'));
process.env.RJR_DATA_DIR = TMP;

const store = await import('../src/store.mjs');

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

const job = (id, extra = {}) => ({
  id,
  title: `岗位 ${id}`,
  company: '某公司',
  city: '成都',
  source: 'test',
  sourceName: '测试源',
  url: `https://example.com/${id}`,
  score: 80,
  ...extra,
});

console.log('\n[1] 空索引');
{
  const idx = store.loadIndex();
  ok('文件不存在时返回空索引', idx.version === 1 && Object.keys(idx.jobs).length === 0);
  ok('有 runs 数组', Array.isArray(idx.runs));
}

console.log('\n[2] 首次检索：全部是新增');
{
  const d1 = store.upsert([job('a'), job('b'), job('c')], { runId: 'r1', at: '2026-09-01T10:00:00Z', persist: false });
  ok('3 条全部新增', d1.stats.added === 3, `added=${d1.stats.added}`);
  ok('没有「仍在」', d1.stats.ongoing === 0, String(d1.stats.ongoing));
  ok('没有「消失」（首次没有基线）', d1.stats.disappeared === 0, String(d1.stats.disappeared));
  store.saveIndex(d1.index);
  ok('索引文件已写入', fs.existsSync(store.INDEX_PATH), store.INDEX_PATH);
}

console.log('\n[3] 第二次检索：识别新增 + 仍在 + 消失');
{
  // a 仍在、c 消失、d 是新的
  const d2 = store.upsert([job('a'), job('b'), job('d')], { runId: 'r2', at: '2026-09-02T10:00:00Z', persist: false });
  console.log(`     新增 ${d2.stats.added} ｜ 仍在 ${d2.stats.ongoing} ｜ 消失 ${d2.stats.disappeared}`);
  ok('识别出 1 个新增', d2.stats.added === 1, JSON.stringify(d2.added));
  ok('新增的是 d', d2.added[0] === 'd');
  ok('识别出 2 个仍在', d2.stats.ongoing === 2, String(d2.stats.ongoing));
  ok('识别出 1 个消失', d2.stats.disappeared === 1, JSON.stringify(d2.disappeared));
  ok('消失的是 c', d2.disappeared[0] === 'c');
  store.saveIndex(d2.index);
}

console.log('\n[4] 存活时长与出现次数');
{
  const d3 = store.upsert([job('a')], { runId: 'r3', at: '2026-09-10T10:00:00Z', persist: false });
  const rec = d3.index.jobs.a;
  ok('seenCount 累加到 3', rec.seenCount === 3, String(rec.seenCount));
  ok('firstSeen 保持首次时间', rec.firstSeen === '2026-09-01T10:00:00Z', rec.firstSeen);
  ok('lastSeen 更新为本次', rec.lastSeen === '2026-09-10T10:00:00Z', rec.lastSeen);
  store.saveIndex(d3.index);

  // annotate 默认用真实当前时间；这里注入固定的「现在」以保证结果确定
  const { jobs } = store.annotate([job('a')], d3, { now: Date.parse('2026-09-10T10:00:00Z') });
  ok('annotate 算出已挂 9 天', jobs[0].tracking.daysListed === 9, String(jobs[0].tracking.daysListed));
  ok('annotate 标记非新增', jobs[0].tracking.isNew === false);
  ok('annotate 带出状态标签', jobs[0].tracking.statusLabel === '未处理', jobs[0].tracking.statusLabel);
}

console.log('\n[5] 分数变化被记录');
{
  const d = store.upsert([job('a', { score: 65 })], { runId: 'r4', at: '2026-09-11T10:00:00Z', persist: false });
  const rec = d.index.jobs.a;
  ok('score 更新为 65', rec.score === 65, String(rec.score));
  ok('scoreHistory 记了一条', (rec.scoreHistory || []).length === 1, JSON.stringify(rec.scoreHistory));
  // 分数没变时不该新增历史
  const d2 = store.upsert([job('a', { score: 65 })], { runId: 'r5', at: '2026-09-12T10:00:00Z', persist: false });
  ok('分数未变时不重复记录', (d2.index.jobs.a.scoreHistory || []).length === 1, String(d2.index.jobs.a.scoreHistory?.length));
  store.saveIndex(d2.index);
}

console.log('\n[6] 投递状态');
{
  const rec = store.setStatus('a', 'applied', '已投递，等回复');
  ok('状态写入成功', rec.status === 'applied');
  ok('备注写入成功', rec.note === '已投递，等回复');
  ok('reload 后状态还在', store.loadIndex().jobs.a.status === 'applied');
  ok('状态有中文标签', store.STATUS_LABELS.applied === '已投递');
  let threw = false;
  try {
    store.setStatus('a', '瞎写的状态');
  } catch {
    threw = true;
  }
  ok('非法状态被拒绝', threw);
  let threw2 = false;
  try {
    store.setStatus('不存在的id', 'applied');
  } catch {
    threw2 = true;
  }
  ok('不存在的 id 被拒绝', threw2);
}

console.log('\n[7] 投递看板汇总');
{
  store.upsert([job('a'), job('b'), job('e')], { runId: 'r6', at: '2026-09-13T10:00:00Z', persist: false });
  const s = store.summary();
  console.log(`     总计 ${s.total} ｜ 状态分布 ${JSON.stringify(s.byStatus)}`);
  ok('总计正确', s.total >= 4, String(s.total));
  ok('已投递计数为 1', s.byStatus.applied === 1, String(s.byStatus.applied));
  ok('有状态标签表', Object.keys(s.statusLabels).length === 8);
  const applied = store.listJobs({ status: 'applied' });
  ok('按状态筛出 1 条', applied.length === 1 && applied[0].id === 'a', JSON.stringify(applied.map((x) => x.id)));
  ok('可按状态筛出空集', store.listJobs({ status: 'offer' }).length === 0);
}

console.log('\n[8] 清理：长期未出现且无投递进展的记录');
{
  // b 最后一次出现是 09-02，模拟「现在」是 09-13 之后很久
  const idx = store.loadIndex();
  // 直接验证 prune 的判据：把 b 的 lastSeen 改到 200 天前
  idx.jobs.b.lastSeen = new Date(Date.now() - 200 * 864e5).toISOString();
  store.saveIndex(idx);
  const d = store.upsert([job('a')], { runId: 'r7', persist: false });
  ok('过期无进展记录被清理', !d.index.jobs.b, `b 仍存在：${JSON.stringify(d.index.jobs.b)}`);
  ok('有投递状态的记录不被清理', Boolean(d.index.jobs.a), 'a 被误删');
  ok('清理数已统计', d.stats.pruned >= 1, String(d.stats.pruned));
}

console.log('\n[8b] upsert 必须自己写盘（回归：曾经要求调用方手动保存，导致管道里索引永远为空）');
{
  fs.rmSync(store.INDEX_PATH, { force: true });
  const d = store.upsert([job('auto1'), job('auto2')], { runId: 'rauto' });
  ok('upsert 默认已持久化', d.stats.persisted === true);
  ok('索引文件确实被创建', fs.existsSync(store.INDEX_PATH), store.INDEX_PATH);
  const reloaded = store.loadIndex();
  ok('无需手动保存即可重新读到', Object.keys(reloaded.jobs).length === 2, String(Object.keys(reloaded.jobs).length));
  // persist:false 时不应写盘
  fs.rmSync(store.INDEX_PATH, { force: true });
  store.upsert([job('x1')], { runId: 'rno', persist: false });
  ok('persist:false 时不写盘', !fs.existsSync(store.INDEX_PATH));
}

console.log('\n[9] 健壮性');
{
  // 索引文件损坏时不应抛异常，而是当作空索引
  fs.writeFileSync(store.INDEX_PATH, '{ 这不是合法 JSON', 'utf8');
  const idx = store.loadIndex();
  ok('损坏的索引文件不抛异常', idx.version === 1 && Object.keys(idx.jobs).length === 0);
  // 版本不符时重建
  fs.writeFileSync(store.INDEX_PATH, JSON.stringify({ version: 999, jobs: { x: {} } }), 'utf8');
  ok('版本不符时重建', Object.keys(store.loadIndex().jobs).length === 0);
  // 没有 id 的岗位被忽略而不是写坏数据
  const d = store.upsert([{ title: '没有id' }, job('ok1')], { runId: 'r8', persist: false });
  ok('缺 id 的岗位被跳过', d.stats.added === 1, String(d.stats.added));
  ok('有效岗位正常入库', Boolean(d.index.jobs.ok1));
  // 空数组不报错
  ok('空数组不报错', store.upsert([], { runId: 'r9', persist: false }).stats.added === 0);
  // runs 历史有上限
  const many = store.loadIndex();
  ok('runs 历史有上限（≤50）', (many.runs || []).length <= 50, String(many.runs?.length));
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
