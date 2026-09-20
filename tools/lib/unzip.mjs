// 零依赖 ZIP 解压器
//
// 为什么不用 extract-zip：沙箱环境下 electron 的 postinstall 会静默失败，
// 而自己实现只依赖 zlib，行为完全可控，也顺便能给出精确进度。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** 定位并解析中央目录，返回条目列表 */
export function readCentralDirectory(buf) {
  // 从尾部回扫 EOCD（尾部可能有注释，最多 64KB）
  let eocd = -1;
  const start = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('不是有效的 ZIP：找不到中央目录结束记录');

  let entryCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let cdSize = buf.readUInt32LE(eocd + 12);

  // ZIP64：当字段为 0xFFFFFFFF 时，真实值在同目录的 ZIP64 EOCD 里
  const needsZip64 = entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff;
  if (needsZip64) {
    const locOff = eocd - 20;
    if (locOff >= 0 && buf.readUInt32LE(locOff) === SIG_EOCD64_LOC) {
      const z64 = Number(buf.readBigUInt64LE(locOff + 8));
      if (buf.readUInt32LE(z64) === SIG_EOCD64) {
        entryCount = Number(buf.readBigUInt64LE(z64 + 32));
        cdSize = Number(buf.readBigUInt64LE(z64 + 40));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // 从扩展字段里取 ZIP64 尺寸
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e);
        const size = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xffffffff) {
            uncompSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (compSize === 0xffffffff) {
            compSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (localOffset === 0xffffffff) {
            localOffset = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          break;
        }
        e += 4 + size;
      }
    }

    const isDir = name.endsWith('/');
    entries.push({ name, method, compSize, uncompSize, localOffset, isDir, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 读取单个条目的原始数据 */
function readEntryData(buf, entry) {
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== SIG_LOCAL) throw new Error(`条目 ${entry.name} 的本地头无效`);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`条目 ${entry.name} 使用了不支持的压缩方式 ${entry.method}`);
}

/**
 * 解压整个 ZIP 到目标目录
 * @param {string} zipPath
 * @param {string} destDir
 * @param {(done:number,total:number,current:string)=>void} onProgress
 */
export function extractZip(zipPath, destDir, onProgress = null) {
  const buf = fs.readFileSync(zipPath);
  const entries = readCentralDirectory(buf);
  const files = entries.filter((e) => !e.isDir);
  fs.mkdirSync(destDir, { recursive: true });

  let done = 0;
  for (const entry of entries) {
    // 防目录穿越
    const target = path.resolve(destDir, entry.name);
    if (!target.startsWith(path.resolve(destDir))) {
      throw new Error(`ZIP 条目路径越界：${entry.name}`);
    }
    if (entry.isDir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readEntryData(buf, entry));
    done++;
    if (onProgress) onProgress(done, files.length, entry.name);
  }
  return { files: files.length, entries: entries.length };
}
