// Shared input checks for the local server and the in-browser app.
// Errors carry a `status` so HTTP and the client router can agree.
import { DEFAULTS } from './detect.js';

export const MAX_UPLOAD = 300 * 1024 * 1024;
export const MAX_SCALE = 10;
export const PDF_COMPAT_MESSAGE =
  'This file is not PDF-compatible. Upload a PDF, or an .ai saved with "Create PDF Compatible File" turned on in Illustrator.';
const SOURCE_EXT = /\.(ai|pdf)$/i;

export function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

export function parseScale(v, fallback = 3) {
  if (v === undefined || v === null || v === '') return fallback;
  const s = Number(v);
  if (!Number.isFinite(s) || s <= 0 || s > MAX_SCALE) throw fail(400, `scale must be a number between 0 and ${MAX_SCALE}`);
  return s;
}

export function parseFormats(list) {
  const formats = (Array.isArray(list) ? list : []).map((f) => String(f).trim().toLowerCase()).filter(Boolean);
  if (!formats.length) throw fail(400, 'pick at least one format');
  for (const f of formats) if (f !== 'svg' && f !== 'png') throw fail(400, `unknown format ${f}`);
  return formats;
}

export function checkBox(b) {
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[2] <= b[0] || b[3] <= b[1]) {
    throw fail(400, 'bbox must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0');
  }
  return b;
}

// Only known, finite, non-negative thresholds; an empty field in the UI would
// otherwise arrive as 0 (or NaN) and silently wreck detection.
export function parseOptions(options) {
  const out = {};
  for (const [k, v] of Object.entries(options || {})) {
    if (!(k in DEFAULTS)) throw fail(400, `unknown option ${k}`);
    const n = Number(v);
    if (v === '' || v === null || !Number.isFinite(n) || n < 0) throw fail(400, `${k} must be a number ≥ 0`);
    out[k] = n;
  }
  return out;
}

// Keep the name recognisable but filesystem- and IndexedDB-key-safe.
export function safeName(name) {
  const base = baseName(String(name || 'upload')).normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_');
  return (base.replace(/^\.+/, '') || 'upload').slice(0, 120);
}

export function baseName(file) {
  const s = String(file || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

export function isSourceName(name) {
  return SOURCE_EXT.test(name);
}
