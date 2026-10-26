// HTTP backend for the local Node review server. The static build aliases this
// module to client/backend.js; keep the method names in step with that file.

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

const backend = {
  request,
  thumbURL(asset, key) {
    return `/api/assets/${encodeURIComponent(asset.id)}.svg?k=${key}`;
  },
  downloadHref(asset, ext, scale) {
    const id = encodeURIComponent(asset.id);
    if (ext === 'png') return `/api/assets/${id}.png?download&scale=${scale ?? 3}`;
    return `/api/assets/${id}.svg?download`;
  },
  async readAsset(id) {
    const res = await fetch(`/api/assets/${encodeURIComponent(id)}.svg`);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.text();
  },
  pdfOpenParams() {
    return { url: `/api/source?v=${Date.now()}` };
  },
  exportZipHref(opts) {
    return `/api/export.zip?formats=${opts.formats.join(',')}&scale=${opts.scale}`;
  },
  exportFolder(opts) {
    return request('POST', '/api/export', opts);
  },
  async upload(file) {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  },
};

export default backend;
