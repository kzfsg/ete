// Minimal APNG assembler: stitches same-sized PNG frames into one animated PNG. No deps.

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

type Chunk = { type: string; data: Buffer };

export function parseChunks(png: Buffer): Chunk[] {
  if (!png.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  const chunks: Chunk[] = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('latin1');
    chunks.push({ type, data: png.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return chunks;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Builds an APNG from PNG frames that share one IHDR (same size, depth, colour type).
 * `delayMs` applies to every frame; the animation loops forever.
 */
export function buildApng(frames: Buffer[], delayMs: number): Buffer {
  if (frames.length === 0) throw new Error('no frames');
  const first = parseChunks(frames[0]!);
  const ihdr = first.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('first frame has no IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const out: Buffer[] = [SIG, chunk('IHDR', ihdr.data)];
  // Keep ancillary chunks that affect decoding (palette, transparency, gamma) from the first frame.
  for (const c of first) if (['PLTE', 'tRNS', 'gAMA', 'sRGB', 'iCCP'].includes(c.type)) out.push(chunk(c.type, c.data));
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  actl.writeUInt32BE(0, 4); // loop forever
  out.push(chunk('acTL', actl));

  let seq = 0;
  frames.forEach((png, i) => {
    const chunks = i === 0 ? first : parseChunks(png);
    const h = chunks.find((c) => c.type === 'IHDR')!;
    if (!h.data.equals(ihdr.data)) throw new Error(`frame ${i + 1} has a different IHDR (size/format) from frame 1`);
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(width, 4);
    fctl.writeUInt32BE(height, 8);
    fctl.writeUInt32BE(0, 12); // x
    fctl.writeUInt32BE(0, 16); // y
    fctl.writeUInt16BE(Math.max(1, Math.round(delayMs)), 20); // delay_num
    fctl.writeUInt16BE(1000, 22); // delay_den
    fctl.writeUInt8(0, 24); // dispose: none
    fctl.writeUInt8(0, 25); // blend: source
    out.push(chunk('fcTL', fctl));
    for (const c of chunks.filter((c) => c.type === 'IDAT')) {
      if (i === 0) out.push(chunk('IDAT', c.data));
      else {
        const s = Buffer.alloc(4);
        s.writeUInt32BE(seq++);
        out.push(chunk('fdAT', Buffer.concat([s, c.data])));
      }
    }
  });
  out.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(out);
}

export function apngFrameCount(png: Buffer): number {
  const actl = parseChunks(png).find((c) => c.type === 'acTL');
  return actl ? actl.data.readUInt32BE(0) : 1;
}
