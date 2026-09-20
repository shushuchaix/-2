// 岗位索引：跨检索的持久化层
//
// 为什么需要它：在此之前的每次检索都是**独立快照**（data/runs/*.json），
// 之间没有任何关联。于是这些事全都做不到：
//   · 「相比上次新增了哪些岗位」
//   · 「这个岗位挂了多久了」（长期挂着往往意味着有问题：薪资不符 / 要求过高 / 中介挂靠）
//   · 「我投了哪些、结果如何」（投递追踪）
//   · 「改完简历后哪些岗位分数上升了」
//
// GitHub 上的同类项目印证了这个判断：jobsync（★1255）、offeros 都是靠
// 「投递追踪」立住的，而不是靠数据源或算法。
//
// 设计取舍：
//   · 用单个 JSON 文件而不是 SQLite —— 为这个数据量引入数据库依赖不值得
//     （本项目生产依赖只有 pdfjs-dist，这是刻意的）
//   · 主键用 job.id —— 已实测跨检索稳定（77 个 id 中 45 个在多次检索里重复出现，
//     「同标题同公司却对应不同 id」的情况为 0）
//   · 写入用「临时文件 + 重命名」保证原子性，避免进程中断导致索引损坏
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './config.mjs';

const INDEX_FILE = path.join(DATA_ROOT, 'job-index.json');
const SCHEMA_VERSION = 1;

/** 投递状态机。用于投递追踪。 */
export const STATUSES = ['new', 'seen', 'interested', 'applied', 'interviewing', 'offer', 'rejected', 'ignored'];

export const STATUS_LABELS = {
  new: '未处理',
  seen: '已看过',
  interested: '感兴趣',
  applied: '已投递',
  interviewing: '面试中',
  offer: '已录用',
  rejected: '已拒',
  ignored: '不感兴趣',
};

/** 超过这个天数没再出现，且没有投递状态的记录会被清理 */
const STALE_DAYS = 120;

function emptyIndex() {
  return { version: SCHEMA_VERSION, updatedAt: '', jobs: {}, runs: [] };
}

export function loadIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (raw?.version !== SCHEMA_VERSION) return emptyIndex(); // 版本不符，重建
    return { ...emptyIndex(), ...raw, jobs: raw.jobs || {}, runs: raw.runs || [] };
  } catch {
    return emptyIndex();
  }
}

/** 原子写入：先写临时文件再重命名，避免写一半崩溃把索引弄坏 */
export function saveIndex(index) {
  index.version = SCHEMA_VERSION;
  index.updatedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
    const tmp = `${INDEX_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index), 'utf8');
    fs.renameSync(tmp, INDEX_FILE);
  } catch (e) {
    // 索引写失败不应该让整次检索失败 —— 它只是增强功能
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

/** 清理长期未出现的记录（保留有投递状态的） */
function prune(index, now = Date.now()) {
  const cutoff = now - STALE_DAYS * 864e5;
  let removed = 0;
  for (const [id, rec] of Object.entries(index.jobs)) {
    const active = rec.status && !['new', 'seen'].includes(rec.status);
    if (active) continue; // 有投递进展的一律保留
    if (new Date(rec.lastSeen || 0).getTime() < cutoff) {
      delete index.jobs[id];
      removed++;
    }
  }
  return removed;
}

/**
 * 把本次检索的结果并入索引，返回与「本次之前」的差异。
 *
 * 【设计教训】上一版这里只计算差异、不写盘，要求调用方自己再调 saveIndex()。
 * 结果是测试通过（测试里手动保存了）、管道里索引永远是空的 —— 因为没人记得调。
 * 「必须记得保存」这种接口迟早会被漏掉，所以改成**默认自己持久化**；
 * 只有测试需要连续模拟多轮时才传 persist:false。
 *
 * @param {object[]} jobs   本次最终结果
 * @param {object}   meta   { runId, at, persist }
 * @returns {{added:string[], ongoing:string[], disappeared:string[], stats:object}}
 */
export function upsert(jobs = [], { runId = '', at = new Date().toISOString(), persist = true } = {}) {
  const index = loadIndex();
  const now = Date.parse(at) || Date.now();
  const ids = new Set(jobs.map((j) => j.id).filter(Boolean));

  const added = [];
  const ongoing = [];

  for (const job of jobs) {
    if (!job.id) continue;
    const rec = index.jobs[job.id];
    if (rec) {
      rec.lastSeen = at;
      rec.seenCount = (rec.seenCount || 1) + 1;
      rec.title = job.title || rec.title;
      rec.company = job.company || rec.company;
      rec.url = job.url || rec.url;
      // 分数变化历史：只记变化，避免无限增长
      const prev = rec.score;
      if (typeof job.score === 'number' && job.score !== prev) {
        rec.score = job.score;
        rec.scoreHistory = [...(rec.scoreHistory || []).slice(-9), { at, score: job.score }];
      }
      ongoing.push(job.id);
    } else {
      index.jobs[job.id] = {
        id: job.id,
        title: job.title || '',
        company: job.company || '',
        city: job.city || '',
        source: job.source || '',
        sourceName: job.sourceName || '',
        url: job.url || '',
        score: typeof job.score === 'number' ? job.score : null,
        scoreHistory: [],
        firstSeen: at,
        lastSeen: at,
        seenCount: 1,
        status: 'new',
        note: '',
        expire: job.extra?.expire || job.extra?.deadline || '',
      };
      added.push(job.id);
    }
  }

  // 消失检测：上次记录里出现过、这次没出现。
  // 只限定「最近 7 天内还见过」—— 更久远的本来就不该再出现，报出来只是噪声。
  //
  // 【坑】不要加 `seenCount > 1` 这类条件。上一版加了，结果「只出现过一次就下架」的岗位
  // 永远测不出来 —— 而新岗位突然下架恰恰是最需要提醒的情况（可能刚招满）。
  const disappeared = [];
  const sevenDaysAgo = now - 7 * 864e5;
  for (const [id, rec] of Object.entries(index.jobs)) {
    if (ids.has(id)) continue;
    const last = Date.parse(rec.lastSeen || 0);
    if (last >= sevenDaysAgo) disappeared.push(id);
  }

  index.runs = [...(index.runs || []).slice(-49), { runId, at, count: jobs.length, added: added.length }];
  const pruned = prune(index, now);

  const saved = persist ? saveIndex(index) : { ok: true };

  return {
    added,
    ongoing,
    disappeared,
    saved,
    stats: {
      total: Object.keys(index.jobs).length,
      added: added.length,
      ongoing: ongoing.length,
      disappeared: disappeared.length,
      pruned,
      persisted: saved.ok,
    },
    index,
  };
}

/**
 * 把差异信息附到岗位对象上，供前端展示。
 * @param {object[]} jobs
 * @param {object} diff    upsert() 的返回值
 * @param {{now?:number}} [opts] 可注入「现在」的时间戳，便于测试得到确定性结果
 */
export function annotate(jobs = [], diff, { now = Date.now() } = {}) {
  const addedSet = new Set(diff.added || []);
  const disSet = new Set(diff.disappeared || []);
  const index = diff.index || loadIndex();
  for (const job of jobs) {
    const rec = index.jobs?.[job.id];
    job.tracking = {
      isNew: addedSet.has(job.id),
      firstSeen: rec?.firstSeen || '',
      lastSeen: rec?.lastSeen || '',
      seenCount: rec?.seenCount || 1,
      status: rec?.status || 'new',
      statusLabel: STATUS_LABELS[rec?.status || 'new'],
      // 挂了多久 —— 长期挂着值得警惕（可能薪资不符 / 要求过高 / 中介挂靠）
      daysListed: rec?.firstSeen ? Math.max(0, Math.floor((now - Date.parse(rec.firstSeen)) / 864e5)) : 0,
      expire: rec?.expire || '',
    };
  }
  return { jobs, disappearedIds: [...disSet] };
}

/** 改投递状态 */
export function setStatus(id, status, note = '') {
  if (!STATUSES.includes(status)) throw new Error(`未知状态：${status}`);
  const index = loadIndex();
  const rec = index.jobs[id];
  if (!rec) throw new Error('索引里没有这个岗位');
  rec.status = status;
  if (note) rec.note = note;
  rec.statusUpdatedAt = new Date().toISOString();
  saveIndex(index);
  return rec;
}

/** 按状态汇总（投递看板用） */
export function summary() {
  const index = loadIndex();
  const byStatus = {};
  for (const s of STATUSES) byStatus[s] = 0;
  let stale = 0;
  const now = Date.now();
  for (const rec of Object.values(index.jobs)) {
    byStatus[rec.status || 'new'] = (byStatus[rec.status || 'new'] || 0) + 1;
    if ((rec.seenCount || 1) >= 5 && ['new', 'seen'].includes(rec.status || 'new')) stale++;
  }
  return {
    total: Object.keys(index.jobs).length,
    byStatus,
    statusLabels: STATUS_LABELS,
    // 「挂了 ≥5 次检索还没处理」= 长期存在的岗位，值得单独看一眼
    staleCount: stale,
    runs: (index.runs || []).length,
    updatedAt: index.updatedAt,
  };
}

/** 列出岗位（投递看板用），可按状态筛 */
export function listJobs({ status = '', limit = 200 } = {}) {
  const index = loadIndex();
  let arr = Object.values(index.jobs);
  if (status) arr = arr.filter((r) => (r.status || 'new') === status);
  return arr
    .sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''))
    .slice(0, limit);
}

export const INDEX_PATH = INDEX_FILE;
