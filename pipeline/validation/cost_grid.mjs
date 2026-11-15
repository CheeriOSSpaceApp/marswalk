// Calcula cellCost (cost.js REAL, sin modificar) en las 1 000 000 celdas -> Float32 LE (Infinity se conserva).
// Uso: node cost_grid.mjs <cost.js> <dataDir> <out.f32>
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
const [costPath, dataDir, outPath] = process.argv.slice(2);
const { cellCost } = await import(pathToFileURL(path.resolve(costPath)).href);
const meta = JSON.parse(readFileSync(path.join(dataDir, "meta.json")));
const params = JSON.parse(readFileSync(path.join(dataDir, "params.json")));
params.cell_m = meta.cell_m;
const f32 = (f) => { const b = readFileSync(path.join(dataDir, f)); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
const u8 = (f) => { const b = readFileSync(path.join(dataDir, f)); return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
const layers = { slope: f32("slope.f32"), roughness: f32("roughness.f32"), hazard: u8("hazard.u8"), viewshed: u8("viewshed.u8") };
const N = meta.width * meta.height, out = new Float32Array(N);
for (let i = 0; i < N; i++) out[i] = cellCost(i, layers, params, {});
writeFileSync(outPath, Buffer.from(out.buffer));
let inf = 0, mn = Infinity, mx = 0; for (const v of out) { if (!Number.isFinite(v)) inf++; else { mn = Math.min(mn, v); mx = Math.max(mx, v); } }
console.log(JSON.stringify({ cells: N, infinite: inf, min_per_m: mn, max_per_m: mx }));
