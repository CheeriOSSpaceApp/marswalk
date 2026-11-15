// Ejecuta el planner REAL de Eric (planner.js + data.js) en Node, sin navegador y sin modificarlo.
// Uso (desde la raíz del repo):
//   node pipeline/validation/run_planner.mjs web/src jezero <lonA> <latA> <lonB> <latB> docs/validation/planner_route_433_455.json
//
// planner.worker.js hace:  site = await loadSite(siteName);  result = plan(site, payload)
// Aquí se hace lo mismo. Como loadSite() probablemente usa fetch('/data/<site>/...') (rutas del servidor
// de Vite), se redirige fetch a web/public/<ruta>. Si data.js usa otra ruta base, ajustar PUBLIC_DIR.
// ⚠ Confirmar con Eric el formato de payload: aquí se pasa {start:[lon,lat], stops:[], goal:[lon,lat], state:{}}.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const [srcDir, siteName, lonA, latA, lonB, latB, outPath] = process.argv.slice(2);
const PUBLIC_DIR = path.resolve("web/public");

globalThis.fetch = async (url) => {
  const u = String(url).replace(/^https?:\/\/[^/]+/, "").replace(/^\.?\//, "");
  const file = path.join(PUBLIC_DIR, u);
  let buf;
  try { buf = await readFile(file); } catch { return { ok: false, status: 404, url: file }; } // data.js usa su fallback
  return { ok: true, status: 200, url: file,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => JSON.parse(buf.toString("utf8")), text: async () => buf.toString("utf8") };
};

const { loadSite } = await import(pathToFileURL(path.resolve(srcDir, "data.js")).href);
const { plan } = await import(pathToFileURL(path.resolve(srcDir, "planner.js")).href);
const site = await loadSite(siteName);
const payload = { start: [Number(lonA), Number(latA)], stops: [], goal: [Number(lonB), Number(latB)], state: {} };
const t0 = performance.now();
const res = plan(site, payload);
console.log(`plan() en ${(performance.now() - t0).toFixed(0)} ms; stats:`, JSON.stringify(res.stats));
// compare_rover_route.py lee {path: LineString} (y guarda stats tal cual)
await writeFile(outPath, JSON.stringify({ engine: "planner.js (Eric)", ...res }));
