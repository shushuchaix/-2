// 简历文本提取：txt / md / pdf / docx / doc(尽力而为)
import {readDocx} from './docx.mjs';

const MAX_BYTES = 20 * 1024 * 1024;

function decodeBest(buffer) {
  // 先按 UTF-8 解码，若出现大量替换字符则回退 GBK
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > utf8.length * 0.02) {
    for (const enc of ['gbk', 'gb18030', 'big5']) {
      try {
        const alt = new TextDecoder(enc, { fatal: false }).decode(buffer);
        const badAlt = (alt.match(/\uFFFD/g) || []).length;
        if (badAlt < bad) return alt;
      } catch {
        /* 该编码不可用则跳过 */
      }
    }
  }
  return utf8.replace(/^\uFEFF/, '');
}

/* -------------------------------- PDF -------------------------------- */
async function parsePdf(buffer) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (e) {
    throw new Error(`PDF 解析依赖未安装（请在项目目录执行 npm install）：${e.message}`);
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    useWorkerFetch: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    const lines = [];
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      }
    }
    if (line) lines.push(line);
    pages.push(lines.join('\n'));
    page.cleanup();
  }
  await doc.destroy();
  return pages.join('\n');
}

/* ------------------------------ 入口 ------------------------------ */
export async function extractResumeText(buffer, filename = '') {
  if (!buffer || buffer.length === 0) throw new Error('文件为空');
  if (buffer.length > MAX_BYTES) throw new Error(`文件过大（${(buffer.length / 1048576).toFixed(1)}MB），上限 20MB`);

  const ext = (filename.split('.').pop() || '').toLowerCase();
  const isPdfMagic = buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  const isZipMagic = buffer[0] === 0x50 && buffer[1] === 0x4b;

  if (ext === 'pdf' || isPdfMagic) {
    const text = await parsePdf(buffer);
    return { text: cleanupResumeText(text), format: 'pdf' };
  }
  if (ext === 'docx' || (isZipMagic && ext !== 'doc')) {
    try {
      const result = readDocx(buffer);
      return { text: cleanupResumeText(result.text), format: 'docx', warnings:result.warnings,parserVersion:'docx-2' };
    } catch (e) {
      if (ext === 'docx') throw new Error(`DOCX 解析失败：${e.message}`);
    }
  }
  if (ext === 'doc') {
    throw new Error('不支持旧版 .doc 格式，请另存为 .docx 或 PDF 后重试');
  }
  const text = decodeBest(buffer);
  return { text: cleanupResumeText(text), format: ext || 'txt',warnings:[],parserVersion:'text-2' };
}

/** 简历文本清洗：压缩空行、去重复行 */
export function cleanupResumeText(text = '') {
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim());

  const out = [];
  let blank = 0;
  for (const l of lines) {
    if (!l) {
      blank++;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    out.push(l);
  }
  return out.join('\n').trim();
}

export function looksLikeResume(text = '') {
  if (!text || text.length < 80) return false;
  const hits = ['教育', '经历', '项目', '技能', '实习', '工作', '学历', '专业', '毕业', '证书', '奖项', '自我评价', '求职']
    .filter((k) => text.includes(k)).length;
  return hits >= 2 || text.length > 300;
}
