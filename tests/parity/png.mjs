// A PNG reader and writer for the parity gate, in Node alone: the compare no longer needs a browser to look at a screenshot, so a corrupt or truncated image is an error the gate can name and a test can plant.
// Reads 8-bit, non-interlaced images of every colour type a Playwright screenshot is written in (grey, RGB, palette, grey + alpha, RGBA); anything else throws, and so does a chunk whose CRC is wrong.
// Pixels are composited over white, the way the browser canvas the gate used to draw them did.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function chunksOf(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG (bad signature)');
  const chunks = [];
  let at = 8;
  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw new Error('PNG truncated inside a chunk header');
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const end = at + 8 + length;
    if (end + 4 > bytes.length) throw new Error(`PNG truncated inside the ${type} chunk`);
    const data = bytes.subarray(at + 8, end);
    if (crc32(bytes.subarray(at + 4, end)) !== bytes.readUInt32BE(end)) throw new Error(`PNG ${type} chunk fails its CRC`);
    chunks.push({ type, data });
    at = end + 4;
    if (type === 'IEND') break;
  }
  if (!chunks.length || chunks[chunks.length - 1].type !== 'IEND') throw new Error('PNG has no IEND chunk (truncated)');
  return chunks;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Decodes a PNG to `{ width, height, rgba }` (rgba: Uint8ClampedArray, composited over white, alpha 255). Throws on anything it cannot read whole. */
export function decodePng(bytes) {
  const chunks = chunksOf(bytes);
  const header = chunks.find((c) => c.type === 'IHDR');
  if (!header || header.data.length !== 13) throw new Error('PNG has no IHDR');
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const [depth, colorType, , , interlace] = header.data.subarray(8);
  if (depth !== 8 || interlace !== 0 || !(colorType in CHANNELS)) throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${colorType}, interlace ${interlace})`);
  if (width < 1 || height < 1 || width * height > 200_000_000) throw new Error(`PNG size ${width}x${height} is not readable`);
  const palette = chunks.find((c) => c.type === 'PLTE')?.data;
  const transparency = chunks.find((c) => c.type === 'tRNS')?.data;
  if (colorType === 3 && !palette) throw new Error('palette PNG has no PLTE');
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const bpp = CHANNELS[colorType];
  const stride = width * bpp;
  if (raw.length !== (stride + 1) * height) throw new Error(`PNG data is ${raw.length} bytes, expected ${(stride + 1) * height}`);
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y > 0 ? px[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`PNG row ${y} has filter type ${filter}`);
      px[y * stride + x] = v & 255;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    let r;
    let g;
    let b;
    let a = 255;
    if (colorType === 0 || colorType === 4) {
      r = g = b = px[i * bpp];
      if (colorType === 4) a = px[i * bpp + 1];
    } else if (colorType === 3) {
      const index = px[i];
      r = palette[index * 3];
      g = palette[index * 3 + 1];
      b = palette[index * 3 + 2];
      a = transparency && index < transparency.length ? transparency[index] : 255;
    } else {
      r = px[i * bpp];
      g = px[i * bpp + 1];
      b = px[i * bpp + 2];
      if (colorType === 6) a = px[i * bpp + 3];
    }
    rgba[i * 4] = Math.round((r * a + 255 * (255 - a)) / 255);
    rgba[i * 4 + 1] = Math.round((g * a + 255 * (255 - a)) / 255);
    rgba[i * 4 + 2] = Math.round((b * a + 255 * (255 - a)) / 255);
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** Encodes `{ width, height, rgba }` (RGBA, 8 bits) as a PNG. */
export function encodePng({ width, height, rgba }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const DIFFERS_ABOVE = 48;
/**
 * The pixel diff the parity gate reports: both images padded to the larger size with white, a pixel differs when its channels differ by more than 48 in total.
 * Returns `{ ratio, sizeA, sizeB, image }`; `image` is a PNG (the second image faded, every differing pixel red) when anything differs, else null.
 */
export function pixelDiff(aBytes, bBytes) {
  const a = decodePng(aBytes);
  const b = decodePng(bBytes);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const at = (img, x, y) => (x < img.width && y < img.height ? (y * img.width + x) * 4 : -1);
  const out = new Uint8ClampedArray(width * height * 4);
  let diff = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const ia = at(a, x, y);
      const ib = at(b, x, y);
      const pa = ia < 0 ? [255, 255, 255] : [a.rgba[ia], a.rgba[ia + 1], a.rgba[ia + 2]];
      const pb = ib < 0 ? [255, 255, 255] : [b.rgba[ib], b.rgba[ib + 1], b.rgba[ib + 2]];
      const differs = Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]) > DIFFERS_ABOVE;
      if (differs) diff += 1;
      const o = (y * width + x) * 4;
      out[o] = differs ? 255 : Math.round((pb[0] + 765) / 4);
      out[o + 1] = differs ? 0 : Math.round((pb[1] + 765) / 4);
      out[o + 2] = differs ? 0 : Math.round((pb[2] + 765) / 4);
      out[o + 3] = 255;
    }
  }
  return { ratio: diff / (width * height), sizeA: [a.width, a.height], sizeB: [b.width, b.height], image: diff > 0 ? encodePng({ width, height, rgba: out }) : null };
}
