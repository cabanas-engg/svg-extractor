// Minimal ZIP writer (deflate, no zip64) so an export can be one download.
// Enough for icon batches; not a general archiver. Pure JS (fflate) so the
// browser build and the Node server share it.
import { deflateSync } from 'fflate/browser';
import { crc32, concatBytes } from './png.js';

function u16le(n) {
  return new Uint8Array([n & 255, (n >>> 8) & 255]);
}
function u32le(n) {
  return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
}
function utf8(s) {
  return new TextEncoder().encode(s);
}
function bytes(data) {
  if (typeof data === 'string') return utf8(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

/** @param files { name: string, data: string|Uint8Array }[] */
export function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

  for (const f of files) {
    const name = utf8(f.name);
    const raw = bytes(f.data);
    const deflated = deflateSync(raw);
    const stored = deflated.length >= raw.length; // already-compressed PNGs
    const body = stored ? raw : deflated;
    const crc = crc32(raw);

    const local = concatBytes([
      u32le(0x04034b50),
      u16le(20), // version needed
      u16le(0x0800), // UTF-8 names
      u16le(stored ? 0 : 8),
      u16le(time),
      u16le(date),
      u32le(crc),
      u32le(body.length),
      u32le(raw.length),
      u16le(name.length),
      u16le(0),
    ]);
    locals.push(local, name, body);

    const cen = concatBytes([
      u32le(0x02014b50),
      u16le(20), // version made by
      u16le(20),
      u16le(0x0800),
      u16le(stored ? 0 : 8),
      u16le(time),
      u16le(date),
      u32le(crc),
      u32le(body.length),
      u32le(raw.length),
      u16le(name.length),
      u16le(0), // extra
      u16le(0), // comment
      u16le(0), // disk
      u16le(0), // int attr
      u32le(0), // ext attr
      u32le(offset),
    ]);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }

  const cenBuf = concatBytes(central);
  const end = concatBytes([
    u32le(0x06054b50),
    u16le(0),
    u16le(0),
    u16le(files.length),
    u16le(files.length),
    u32le(cenBuf.length),
    u32le(offset),
    u16le(0),
  ]);
  return concatBytes([...locals, cenBuf, end]);
}
