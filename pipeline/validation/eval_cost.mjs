// Evalúa el cellCost REAL de cost.js (Ana) sobre una lista de celdas, sin reimplementarlo.
// Uso: node eval_cost.mjs <cost.js> <dataDir> <cells.json> <out.json>
//   cells.json = [[row, col], ...]   ->   out.json = [minutos_O2_por_metro | null(=Infinity), ...]
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const [costPath, dataDir, cellsPath, outPath] = process.argv.slice(2);
const { cellCost } = await import(pathToFileURL(path.resolve(costPath)).href);
const meta = JSON.parse(readFileSync(path.join(dataDir, "meta.json")));
const params = JSON.parse(readFileSync(path.join(dataDir, "params.json")));
params.cell_m = meta.cell_m; // el valor real del grid sale de meta.json (params.json lo marca como mock)
const f32 = (f) => { const b = readFileSync(path.join(dataDir, f)); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const u8 = (f) => { const b = readFileSync(path.join(dataDir, f)); return new Uint8Array(b.buffer, b.byteOffset, b.length); };
const layers = { slope: f32("slope.f32"), roughness: f32("roughness.f32"), hazard: u8("hazard.u8") };
try { layers.viewshed = u8("viewshed.u8"); } catch { /* opcional */ }
const N = meta.width * meta.height;
for (const [k, v] of Object.entries(layers)) if (v.length !== N) throw new Error(`${k}: ${v.length} != ${N}`);
const cells = JSON.parse(readFileSync(cellsPath));
const state = {}; // cost.js no usa state (las alertas las aplica el planner); validación sin alertas
const out = cells.map(([r, c]) => { const v = cellCost(r * meta.width + c, layers, params, state); return Number.isFinite(v) ? v : null; });
writeFileSync(outPath, JSON.stringify(out));
console.log(`cellCost evaluado en ${out.length} celdas; Infinity: ${out.filter((v) => v === null).length}`);
