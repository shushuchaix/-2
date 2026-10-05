import zlib from "node:zlib";
export function readZipEntries(
  buffer,
  { maxExpandedBytes = 41943040, maxEntries = 5000 } = {},
) {
  const fail = (message) => {
    throw new Error("ZIP " + message);
  };
  const bounds = (offset, size) => {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + size > buffer.length
    )
      fail("offset out of bounds");
  };
  if (!Buffer.isBuffer(buffer) || buffer.length < 22)
    fail("truncated directory");
  let eocd = -1;
  for (let p = buffer.length - 22; p >= Math.max(0, buffer.length - 65557); p--)
    if (
      buffer.readUInt32LE(p) === 0x06054b50 &&
      p + 22 + buffer.readUInt16LE(p + 20) === buffer.length
    ) {
      eocd = p;
      break;
    }
  if (eocd < 0) fail("missing directory");
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6))
    fail("multi disk unsupported");
  const count = buffer.readUInt16LE(eocd + 10),
    size = buffer.readUInt32LE(eocd + 12),
    start = buffer.readUInt32LE(eocd + 16);
  if (count > maxEntries || count === 65535 || start + size > eocd)
    fail("directory size/entry limit");
  let p = start,
    expanded = 0;
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    bounds(p, 46);
    if (p + 46 > start + size || buffer.readUInt32LE(p) !== 0x02014b50)
      fail("invalid directory entry");
    const flags = buffer.readUInt16LE(p + 8),
      method = buffer.readUInt16LE(p + 10),
      compressed = buffer.readUInt32LE(p + 20),
      plainSize = buffer.readUInt32LE(p + 24);
    const nameSize = buffer.readUInt16LE(p + 28),
      extra = buffer.readUInt16LE(p + 30),
      comment = buffer.readUInt16LE(p + 32),
      local = buffer.readUInt32LE(p + 42);
    bounds(p + 46, nameSize + extra + comment);
    if (p + 46 + nameSize + extra + comment > start + size)
      fail("invalid directory size");
    const name = buffer.toString("utf8", p + 46, p + 46 + nameSize);
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes(":") ||
      name.split("/").includes("..") ||
      name.includes("\0")
    )
      fail("unsafe path");
    if (entries.has(name)) fail("duplicate path");
    if (flags & 1) fail("encrypted entry unsupported");
    if (method !== 0 && method !== 8) fail("unsupported compression method");
    if (plainSize > maxExpandedBytes - expanded) fail("expanded size limit");
    bounds(local, 30);
    if (local >= start || buffer.readUInt32LE(local) !== 0x04034b50)
      fail("invalid local offset");
    if (buffer.readUInt16LE(local + 8) !== method)
      fail("compression header mismatch");
    const localName = buffer.readUInt16LE(local + 26),
      localExtra = buffer.readUInt16LE(local + 28),
      dataStart = local + 30 + localName + localExtra;
    bounds(local + 30, localName + localExtra);
    if (buffer.toString("utf8", local + 30, local + 30 + localName) !== name)
      fail("path header mismatch");
    bounds(dataStart, compressed);
    if (dataStart + compressed > start)
      fail("compressed data overlaps directory");
    let data;
    try {
      data =
        method === 0
          ? Buffer.from(buffer.subarray(dataStart, dataStart + compressed))
          : zlib.inflateRawSync(
              buffer.subarray(dataStart, dataStart + compressed),
              { maxOutputLength: Math.max(1, maxExpandedBytes - expanded) },
            );
    } catch (error) {
      fail("expansion limit or invalid compression: " + error.message);
    }
    if (data.length !== plainSize) fail("expanded size mismatch");
    expanded += data.length;
    if (expanded > maxExpandedBytes) fail("expanded size limit");
    entries.set(name, data);
    p += 46 + nameSize + extra + comment;
  }
  if (p !== start + size) fail("directory size mismatch");
  return entries;
}
