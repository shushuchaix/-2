// 生成应用图标 build/icon.ico
//
// 零依赖：自己编码 PNG（zlib + CRC32），再按 ICO 容器格式打包多尺寸。
// 图案是「雷达/靶心」：蓝色渐变圆角底 + 白色同心环 + 准星 + 一个目标点。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'build');

/* ------------------------------ PNG 编码 ------------------------------ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA 像素缓冲 → PNG */
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // 每行前加一个 filter 字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ 绘制 ------------------------------ */
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 圆角矩形的有符号距离（用于抗锯齿） */
function roundedRectDistance(px, py, halfW, halfH, radius) {
  const qx = Math.abs(px) - (halfW - radius);
  const qy = Math.abs(py) - (halfH - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * 单点采样：返回 [r,g,b,a]，a 为 0..1
 * 坐标已归一化到 [-1, 1]
 */
function sample(nx, ny) {
  const half = 0.97; // 留一点外边距
  const radius = 0.42;
  const d = roundedRectDistance(nx, ny, half, half, radius);
  // 1px 宽的抗锯齿过渡（在归一化空间里约等于 2/size，用固定值即可）
  const bgAlpha = clamp01(0.5 - d * 60);
  if (bgAlpha <= 0) return [0, 0, 0, 0];

  // 背景：左上到右下的蓝色渐变
  const t = clamp01((nx + ny + 2) / 4);
  let r = lerp(0x36, 0x1b, t);
  let g = lerp(0x76, 0x47, t);
  let b = lerp(0xff, 0xcc, t);

  const dist = Math.hypot(nx, ny);

  // 同心环：三圈白色细环
  const rings = [0.34, 0.58, 0.82];
  for (const rr of rings) {
    const w = 0.035;
    const ringAlpha = clamp01(1 - Math.abs(dist - rr) / w);
    if (ringAlpha > 0) {
      const a = ringAlpha * 0.92;
      r = lerp(r, 255, a);
      g = lerp(g, 255, a);
      b = lerp(b, 255, a);
    }
  }

  // 准星：十字线（只画到外环以内）
  if (dist < 0.9) {
    const armW = 0.026;
    const onCross = Math.abs(nx) < armW || Math.abs(ny) < armW;
    if (onCross) {
      // 十字端点做一点淡出
      const fade = clamp01((0.9 - dist) / 0.12) * 0.85;
      r = lerp(r, 255, fade);
      g = lerp(g, 255, fade);
      b = lerp(b, 255, fade);
    }
  }

  // 目标点：右上方向的实心小圆（雷达捕捉到的目标）
  const tx = 0.30;
  const ty = -0.30;
  const td = Math.hypot(nx - tx, ny - ty);
  const dotAlpha = clamp01(1 - (td - 0.085) * 90);
  if (dotAlpha > 0) {
    r = lerp(r, 255, dotAlpha);
    g = lerp(g, 255, dotAlpha);
    b = lerp(b, 255, dotAlpha);
  } else if (td < 0.16) {
    // 目标点外的一圈光晕
    const halo = clamp01((0.16 - td) / 0.075) * 0.35;
    r = lerp(r, 255, halo);
    g = lerp(g, 255, halo);
    b = lerp(b, 255, halo);
  }

  return [r, g, b, bgAlpha];
}

/** 用 3×3 超采样渲染一张 size×size 的 RGBA 图 */
function render(size) {
  const SS = 3;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const nx = (px / size) * 2 - 1;
          const ny = (py / size) * 2 - 1;
          const [sr, sg, sb, sa] = sample(nx, ny);
          // 预乘 alpha 后再平均，避免边缘出现黑边
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }
      const n = SS * SS;
      const aAvg = a / n;
      const i = (y * size + x) * 4;
      if (aAvg > 0) {
        // r/g/b 是「已乘 alpha 的累加和」，除以 a 得到 alpha 加权平均色。
        // 注意这里得到的是 0..255 的颜色值，不能再套 clamp01。
        const to255 = (v) => Math.round(v / a < 0 ? 0 : v / a > 255 ? 255 : v / a);
        buf[i] = to255(r);
        buf[i + 1] = to255(g);
        buf[i + 2] = to255(b);
        buf[i + 3] = Math.round(clamp01(aAvg) * 255);
      }
    }
  }
  return buf;
}

/* ------------------------------ ICO 打包 ------------------------------ */
/** 多尺寸 PNG 打包成 ICO（Vista+ 支持内嵌 PNG） */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(images.length, 4);

  const dirSize = 16 * images.length;
  let offset = 6 + dirSize;
  const entries = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size; // 256 用 0 表示
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0; // 调色板数
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/* ------------------------------ 主流程 ------------------------------ */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('\n=== 生成应用图标 ===\n');
const images = [];
for (const size of SIZES) {
  const rgba = render(size);
  const png = encodePng(rgba, size, size);
  images.push({ size, png });
  console.log(`  ${String(size).padStart(3)}×${size}  PNG ${String(png.length).padStart(6)} 字节`);
}

const ico = buildIco(images);
const icoPath = path.join(OUT_DIR, 'icon.ico');
fs.writeFileSync(icoPath, ico);

// 顺便导出一张 256 的 PNG，便于预览与文档使用
const previewPath = path.join(OUT_DIR, 'icon.png');
fs.writeFileSync(previewPath, images[images.length - 1].png);

console.log(`\n  ✅ ${path.relative(ROOT, icoPath)}（${(ico.length / 1024).toFixed(1)} KB，${SIZES.length} 个尺寸）`);
console.log(`  ✅ ${path.relative(ROOT, previewPath)}（预览图）\n`);

// 自检：ICO 头是否合法
const check = fs.readFileSync(icoPath);
const okType = check.readUInt16LE(2) === 1;
const okCount = check.readUInt16LE(4) === SIZES.length;
const firstPngOffset = check.readUInt32LE(6 + 12);
const okPng = check.subarray(firstPngOffset, firstPngOffset + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
console.log(`  自检：type=${okType ? 'icon ✓' : '✗'}  数量=${okCount ? SIZES.length + ' ✓' : '✗'}  内嵌 PNG=${okPng ? '✓' : '✗'}\n`);

process.exit(okType && okCount && okPng ? 0 : 1);
