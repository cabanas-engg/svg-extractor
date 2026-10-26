// Minimal PNG encoder for embedding PDF.js-decoded images into exported SVGs.
// Handles the three ImageKind layouts PDF.js hands back, plus 1-bit stencil
// masks (painted in the current fill colour).
//
// Deflate comes from fflate's browser build so the same module runs under Node
// (CLI, tests) and in the static client. Output is a Uint8Array, which
// fs.writeFileSync and the browser both accept.
import { zlibSync } from 'fflate/browser';

const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u32be(n) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function latin1(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function chunk(type, data) {
  const td = concatBytes([latin1(type), data]);
  return concatBytes([u32be(data.length), td, u32be(crc32(td))]);
}

/** Base64 of a byte array. Works in Node and browsers (no Buffer). */
export function bytesToBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(bin);
}

function toRGBA(img, maskColor) {
  const { width, height, kind, data } = img;
  const out = new Uint8Array(width * height * 4);
  if (maskColor) {
    // Stencil mask, already normalised by PDF.js so that a 0 bit = painted.
    // (Not yet verified against a real file containing image masks.)
    const r = parseInt(maskColor.slice(1, 3), 16), g = parseInt(maskColor.slice(3, 5), 16), b = parseInt(maskColor.slice(5, 7), 16);
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const o = (y * width + x) * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = bit ? 0 : 255;
      }
    }
    return out;
  }
  if (kind === RGBA_32BPP) {
    out.set(new Uint8Array(data.buffer, data.byteOffset, width * height * 4));
    return out;
  }
  if (kind === RGB_24BPP) {
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      out[i * 4] = data[j]; out[i * 4 + 1] = data[j + 1]; out[i * 4 + 2] = data[j + 2]; out[i * 4 + 3] = 255;
    }
    return out;
  }
  if (kind === GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const o = (y * width + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
      }
    }
    return out;
  }
  throw new Error(`unsupported image kind ${kind}${img.bitmap ? ' (ImageBitmap)' : ''}`);
}

export function encodePNG(img, maskColor = null) {
  if (!img?.width || !img?.height) throw new Error('missing image data');
  const { width, height } = img;
  const rgba = toRGBA(img, maskColor);
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
