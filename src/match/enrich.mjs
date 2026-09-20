// 岗位 JD 补全：对入围岗位抓取详情页正文，供 LLM 精排使用
import * as zhaopin from '../sources/zhaopin.mjs';
import * as shixiseng from '../sources/shixiseng.mjs';
import { pool } from '../util/text.mjs';

const FETCHERS = {
  [zhaopin.meta.id]: zhaopin.fetchDetail,
  [shixiseng.meta.id]: shixiseng.fetchDetail,
};

/**
 * 并发补全岗位详情
 * @param {object[]} jobs 已排序的岗位（只取前 topN）
 */
export async function enrichJobs(jobs, { topN = 12, concurrency = 3, log = () => {}, signal } = {}) {
  const targets = jobs.slice(0, topN).filter((j) => !j.description && j.source !== 'web');
  let done = 0;
  let ok = 0;

  await pool(targets, concurrency, async (job) => {
    if (signal?.aborted) return;
    const fetcher = FETCHERS[job.source];
    if (!fetcher || !job.url) return;
    try {
      const r = await fetcher(job);
      if (r?.description && r.description.length > 60) {
        job.description = r.description;
        ok++;
      }
      if (r?.companyInfo && !job.extra?.companyInfo) {
        job.extra = { ...(job.extra || {}), companyInfo: r.companyInfo };
      }
    } catch (e) {
      job.enrichError = e.message;
    } finally {
      done++;
      if (done % 3 === 0 || done === targets.length) log(`JD 补全 ${done}/${targets.length}`);
    }
  });

  return { enriched: ok, attempted: targets.length };
}
