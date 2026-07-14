"use strict";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dosDate };
}

/** Assembles a ZIP archive from `entries` (each `{ name, data }`, data a string or
 *  Uint8Array) into a Blob, using the STORE method (no compression) for every entry. EPUB
 *  only requires its mimetype entry to be stored uncompressed; storing everything else too
 *  avoids needing a deflate implementation, at the cost of a somewhat larger file. Entry
 *  order is preserved, so callers that need the EPUB mimetype-first convention should put
 *  it first in `entries`. */
export function createZipBlob(entries) {
  const encoder = new TextEncoder();
  const { time, dosDate } = dosDateTime(new Date());
  const chunks = [];
  const centralRecords = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(dataBytes);

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint16(6, 0, true);
    localHeader.setUint16(8, 0, true);
    localHeader.setUint16(10, time, true);
    localHeader.setUint16(12, dosDate, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, dataBytes.length, true);
    localHeader.setUint32(22, dataBytes.length, true);
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);

    chunks.push(new Uint8Array(localHeader.buffer), nameBytes, dataBytes);
    centralRecords.push({ nameBytes, crc, size: dataBytes.length, offset });
    offset += 30 + nameBytes.length + dataBytes.length;
  }

  const centralStart = offset;
  for (const rec of centralRecords) {
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, 0, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, time, true);
    header.setUint16(14, dosDate, true);
    header.setUint32(16, rec.crc, true);
    header.setUint32(20, rec.size, true);
    header.setUint32(24, rec.size, true);
    header.setUint16(28, rec.nameBytes.length, true);
    header.setUint16(30, 0, true);
    header.setUint16(32, 0, true);
    header.setUint16(34, 0, true);
    header.setUint16(36, 0, true);
    header.setUint32(38, 0, true);
    header.setUint32(42, rec.offset, true);

    chunks.push(new Uint8Array(header.buffer), rec.nameBytes);
    offset += 46 + rec.nameBytes.length;
  }
  const centralSize = offset - centralStart;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, centralRecords.length, true);
  end.setUint16(10, centralRecords.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);
  chunks.push(new Uint8Array(end.buffer));

  return new Blob(chunks, { type: "application/epub+zip" });
}
