// Node session file (<file>.extract.json). The editable model itself is in
// session-core.js, which the browser build imports directly.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { SESSION_VERSION, createSession as createSessionCore } from './session-core.js';

export {
  SESSION_VERSION,
  selectInBox,
  assetElements,
  addManualAsset,
  mergeAssets,
  splitAsset,
  updateAsset,
  deleteAsset,
  redetectPage,
} from './session-core.js';

export const defaultSessionPath = (file) => `${file}.extract.json`;

export function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function createSession(parsed, opts) {
  const sha256 = parsed.sha256 || hashFile(parsed.file);
  const withHash = sha256 === parsed.sha256 ? parsed : { ...parsed, sha256 };
  return createSessionCore(withHash, opts);
}

export function loadSession(file, sourceFile) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (s.version !== SESSION_VERSION) throw new Error(`${file}: unsupported session version ${s.version}`);
  if (sourceFile && s.source?.sha256 && s.source.sha256 !== hashFile(sourceFile)) {
    s.stale = true; // caller decides whether to warn or re-detect
  }
  return s;
}

export function saveSession(file, session) {
  const { stale, ...rest } = session;
  fs.writeFileSync(file, JSON.stringify(rest, null, 1) + '\n');
}

/**
 * The session for a parsed file: the saved one if present (flagged `stale` if
 * the source changed since), otherwise a fresh detection, saved straight away.
 */
export function openSession(parsed, { sessionPath = defaultSessionPath(parsed.file), redetect = false, opts = {} } = {}) {
  if (!redetect && fs.existsSync(sessionPath)) return { session: loadSession(sessionPath, parsed.file), fromDisk: true, sessionPath };
  const session = createSession(parsed, opts);
  saveSession(sessionPath, session);
  return { session, fromDisk: false, sessionPath };
}
