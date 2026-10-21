import {
  resolveDataLayout,
  writeCacheJsonSync,
  validKnownCache,
} from "../infrastructure/storage/layout.mjs";
// 实习僧标题「字体混淆」解码器
//
// 背景：实习僧列表页用一套每次请求随机生成的图标字体渲染岗位标题，
// 数据里留下的是私有区码点（如 &#xe26c&#xe8fc&#xec1f&#xe8fc后&#xef0f开发 = "Java后端开发"）。
//
// 解法：详情页的 <title> 是明文，且混淆是「一码点对一字符」的等长替换。
// 因此抓少量详情页做「已知明文」样本，即可反推映射表，进而解码同批次全部标题。
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "../config.mjs";

const PUA_RE = /[\uE000-\uF8FF]/;

export function hasPua(s = "") {
  return PUA_RE.test(String(s));
}

/** 尝试把混淆串与明文对齐，学习映射。返回本次新学到的条目数。 */
export function learnFromPair(obf, plain, map) {
  if (!obf || !plain || obf.length !== plain.length) return 0;
  // 先验证非私有区字符是否逐位一致，不一致说明对齐不可靠
  for (let i = 0; i < obf.length; i++) {
    if (!PUA_RE.test(obf[i]) && obf[i] !== plain[i]) return 0;
  }
  let learned = 0;
  for (let i = 0; i < obf.length; i++) {
    const c = obf[i];
    if (!PUA_RE.test(c)) continue;
    if (map.__conflicted?.has(c)) continue;
    const want = plain[i];
    const known = map.get(c);
    if (known === undefined) {
      map.set(c, want);
      learned++;
    } else if (known !== want) {
      // 同一码点在不同请求中含义不同 → 字体轮换了，本次映射不可信
      map.delete(c);
      map.__conflicted ||= new Set();
      map.__conflicted.add(c);
      map.__conflicts = (map.__conflicts || 0) + 1;
    }
  }
  return learned;
}

/** 用映射表解码；未覆盖的私有区字符原样保留（显示时会被剥离） */
export function decodeWithMap(text, map) {
  if (!text) return "";
  let out = "";
  for (const ch of String(text)) {
    if (PUA_RE.test(ch)) {
      const m = map.get(ch);
      out += m === undefined ? ch : m;
    } else {
      out += ch;
    }
  }
  return out;
}

/** 覆盖率：混淆串中能被映射表解出的私有区字符比例 */
export function coverage(text, map) {
  const chars = [...String(text)].filter((c) => PUA_RE.test(c));
  if (!chars.length) return 1;
  const hit = chars.filter((c) => map.has(c)).length;
  return hit / chars.length;
}

/* ------------------------- 映射表持久化 ------------------------- */
const FILE = path.join(resolveDataLayout(DATA_ROOT).cache, "font-map.json");

export function loadPersistedMap(filename = FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!validKnownCache("font-map.json", raw)) return new Map();
    const map = new Map(Object.entries(raw.map || {}));
    map.__savedAt = raw.savedAt;
    map.__conflicts = raw.conflicts || 0;
    return map;
  } catch {
    return new Map();
  }
}

export function persistMap(map, filename = FILE) {
  const clean = {};
  for (const [k, v] of map) {
    if (k.startsWith("__")) continue;
    clean[k] = v;
  }
  try {
    writeCacheJsonSync(filename, {
      savedAt: new Date().toISOString(),
      size: Object.keys(clean).length,
      map: clean,
    });
    return true;
  } catch {
    return false;
  }
}

export function mapSize(map) {
  let n = 0;
  for (const k of map.keys()) if (!k.startsWith("__")) n++;
  return n;
}
