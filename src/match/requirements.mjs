// 「硬性要求」与「优先条件」的区分
//
// 为什么必须单独做这件事：中文招聘里，
//   「须持有注册消防工程师证书」  → 不满足 = 不录用（硬性）
//   「持有注册消防工程师证书者优先」→ 不满足只是少个加分（软性）
// 这两句只差几个字，但处理方式完全相反。
// 把它们当成一回事，会同时犯两个方向的错：
//   · 把软性当硬性 → 明明能投的岗位被**降分甚至剔除**（漏掉机会）
//   · 把硬性当软性 → 投了也白投（浪费精力）
//
// 早期版本就踩了这个坑：`/社招|社会招聘|有工作经验者优先/` 把
// 「有工作经验者优先」当成了社招信号，而社招在届别过滤里是**直接剔除**的 ——
// 等于因为一句「优先」把能投的岗位删掉了。

const SOFT =
  /优先|加分|更佳|从优|优先考虑|优先录用|有则更好|可放宽|条件优秀者|优秀者可|适当放宽|酌情|preferred/i;
const HARD =
  /必须|须持有|须具备|须取得|仅限|限招|硬性|要求持有|需持有|应具备|应当具备|务必|只招|仅招|谢绝|勿投|不满足.*(?:不予|取消)/;

/** 标点：用来切分句 */
const SEPARATORS = ['，', '。', '；', '\n', ';', ',', '！', '？', '|', '｜'];

/** 取出包含 [start, start+len) 的那个分句 */
export function clauseAt(text, start, len) {
  const s = String(text || '');
  const before = s.slice(0, start);
  let begin = 0;
  for (const sep of SEPARATORS) {
    const i = before.lastIndexOf(sep);
    if (i + 1 > begin) begin = i + 1;
  }
  const after = s.slice(start + len);
  let end = s.length;
  for (const sep of SEPARATORS) {
    const i = after.indexOf(sep);
    if (i >= 0 && start + len + i < end) end = start + len + i;
  }
  return s.slice(begin, end).trim();
}

/**
 * 判断文本里某处提到的是不是「软性（优先）条件」。
 * @param {string} text  全文
 * @param {string|RegExp} keyword 关键词
 * @returns {boolean} true = 只是优先条件（不满足不该被扣分/剔除）
 */
export function isSoftRequirement(text, keyword) {
  const s = String(text || '');
  if (!s) return false;
  let idx = -1;
  let len = 0;
  if (keyword instanceof RegExp) {
    const m = s.match(keyword);
    if (!m) return false;
    idx = m.index;
    len = m[0].length;
  } else {
    idx = s.indexOf(keyword);
    if (idx < 0) return false;
    len = keyword.length;
  }
  const clause = clauseAt(s, idx, len);
  // 同一分句里明确写了「必须/仅限」→ 即使带「优先」也按硬性处理
  if (HARD.test(clause)) return false;
  return SOFT.test(clause);
}

/** 文本里是否出现过任何软性措辞（粗粒度，用于整段判断） */
export function hasSoftMarker(text) {
  return SOFT.test(String(text || ''));
}

/** 文本里是否出现过任何硬性措辞 */
export function hasHardMarker(text) {
  return HARD.test(String(text || ''));
}
