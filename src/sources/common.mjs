// 各岗位源共用的工具
//
// 为什么要有这个文件：`normSchool` / `isOwnSchool` 原本在 university.mjs 和 chenyun.mjs
// 里各写了一份（当时图省事直接复制，还写了「保持一致的口径」的注释）。
// 但**复制出来的东西不会自动保持一致** —— 将来只改一处，另一处就变成隐形 bug。
// 校名匹配这种逻辑一旦不一致，就会出现「同一份简历在两个源里被判成本校/非本校」。
// 所以统一到这里。

/** 去掉校区 / 括号备注 / 空白，便于校名比对 */
export function normSchool(s) {
  return String(s || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, "")
    .replace(/(新校区|老校区|校区|分校|本部)$/g, "")
    .trim();
}

/**
 * 判断某个学校条目是不是用户本校。
 *
 * 必须做**规范化后精确比对**，不能用子串包含：
 *   '西安电子科技大学'.includes('电子科技大学') === true   ← 但这是两所完全不同的学校
 *   '东北大学秦皇岛分校'.includes('东北大学')   === true   ← 同样是两所不同的学校，就业网也不同
 * 早期版本用了双向 includes，导致成都「电子科技大学」的学生被判定成本校是西安电子科技大学。
 */
export function isOwnSchool(entry, profile = {}) {
  const school = normSchool(profile.school);
  if (!school || !entry) return false;
  const names = [entry.name, ...(entry.aliases || [])]
    .map(normSchool)
    .filter(Boolean);
  return names.some((n) => n === school);
}

/** 生成带重试的抓取（各源通用）：网络抖动不该让整轮检索失败 */
export async function fetchWithRetry(url, opts = {}) {
  const { sourceFetch } = await import("./request-context.mjs");
  return sourceFetch(url, opts);
}
