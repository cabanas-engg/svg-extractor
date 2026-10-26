// In-memory stand-in for IndexedDB. Used by Node tests and as a fallback when
// the browser refuses to persist (private mode, quota).

export function memoryStorage() {
  const meta = new Map();
  const blobs = new Map();
  const sessions = new Map();
  return {
    async list() {
      return [...meta.values()]
        .map(({ name, size, modified, assets }) => ({ name, size, modified, assets }))
        .sort((a, b) => b.modified - a.modified)
        .slice(0, 20);
    },
    async getMeta(name) {
      return meta.get(name) || null;
    },
    async getBytes(name) {
      return blobs.get(name) || null;
    },
    async getSession(name) {
      return sessions.has(name) ? structuredClone(sessions.get(name)) : null;
    },
    async putFile(name, bytes, info) {
      blobs.set(name, bytes);
      meta.set(name, { ...info, name });
    },
    async saveSession(name, session, assets) {
      const m = meta.get(name);
      if (m) m.assets = assets;
      const { stale, ...rest } = session;
      sessions.set(name, structuredClone(rest));
    },
    async delete(name) {
      meta.delete(name);
      blobs.delete(name);
      sessions.delete(name);
    },
  };
}
