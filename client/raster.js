// Browser PNG path. resvg-wasm matches the CLI renderer closely (same library,
// bundled Liberation Sans for captions). If the wasm file fails to load, fall
// back to drawing the SVG into a canvas so export still produces a PNG.
import { initWasm, Resvg } from '@resvg/resvg-wasm';

let fontBuffer = null;
let mode = 'pending';
let ready = Promise.resolve();
let note = null;

function assetURL(name) {
  return new URL(name, import.meta.url).href;
}

export function startRasterizer() {
  ready = (async () => {
    try {
      const [wasmRes, fontRes] = await Promise.all([
        fetch(assetURL('resvg.wasm')),
        fetch(assetURL('LiberationSans-Regular.ttf')),
      ]);
      if (!wasmRes.ok) throw new Error(`resvg.wasm HTTP ${wasmRes.status}`);
      if (!fontRes.ok) throw new Error(`font HTTP ${fontRes.status}`);
      await initWasm(await wasmRes.arrayBuffer());
      fontBuffer = new Uint8Array(await fontRes.arrayBuffer());
      mode = 'wasm';
      note = null;
    } catch (e) {
      mode = 'canvas';
      note = `PNG export is using the browser's SVG renderer (${e.message}). Output can differ slightly from the command-line tool.`;
      console.warn(note);
    }
  })();
  return ready;
}

export function rasterNote() {
  return note;
}

export async function rasterize(svg, { scale = 3, background } = {}) {
  await ready;
  if (mode === 'wasm') return wasmPNG(svg, { scale, background });
  return canvasPNG(svg, { scale, background });
}

function wasmPNG(svg, { scale, background }) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: scale },
    background,
    font: {
      fontBuffers: fontBuffer ? [fontBuffer] : [],
      defaultFontFamily: 'Liberation Sans',
      sansSerifFamily: 'Liberation Sans',
      serifFamily: 'Liberation Sans',
      monospaceFamily: 'Liberation Sans',
    },
  });
  const rendered = resvg.render();
  try {
    return rendered.asPng();
  } finally {
    rendered.free();
    resvg.free();
  }
}

function canvasPNG(svg, { scale, background }) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  const w = Number(root.getAttribute('width')) || 1;
  const h = Number(root.getAttribute('height')) || 1;
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(async (out) => {
        URL.revokeObjectURL(url);
        if (!out) {
          reject(new Error('the browser could not encode this SVG as a PNG'));
          return;
        }
        resolve(new Uint8Array(await out.arrayBuffer()));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('the browser could not draw this SVG'));
    };
    img.src = url;
  });
}
