// report.test.mjs — mission report from a synthetic mission log. Run from web/: node test/report.test.mjs
import fs from 'node:fs';
import { buildReport, reportToMarkdown } from '../src/report.js';
const dir = new URL('../public/data/mock/', import.meta.url), com = new URL('../public/data/common/', import.meta.url);
const json = (u, f) => JSON.parse(fs.readFileSync(new URL(f, u)));
const bin = (f, T) => { const b = fs.readFileSync(new URL(f, dir)); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT); };
const site = { meta: json(dir, 'meta.json'), suit: json(com, 'suit.json'),
  layers: { slope: bin('slope.f32', Float32Array), hazard: bin('hazard.u8', Uint8Array), viewshed: bin('viewshed.u8', Uint8Array) } };
const h = site.meta.habitat, step = 0.0003;
const log = { mission_id: 'EVA-1', site: 'mock', crew: ['A. Kiki'], start_lmst: 9, planned: { stats: { distance_m: 700, duration_min: 60, o2_used_pct: 12 } },
  events: [
    { t_min: 0, type: 'phase', phase: 'prep' }, { t_min: 15, type: 'phase', phase: 'outbound' },
    ...Array.from({ length: 11 }, (_, k) => ({ t_min: 15 + k * 2, type: 'position', lon: h[0] + k * step, lat: h[1], o2_used_min: 15 + k * 2.2, dose_mSv: 0.001 * k })),
    { t_min: 35, type: 'phase', phase: 'working' }, { t_min: 35, type: 'arrive', id: 'x', name: 'Outcrop' },
    { t_min: 42, type: 'obstacle', lon: h[0], lat: h[1], radius_m: 20, kind: 'blocked', source: 'astronaut', note: 'boulder field' },
    { t_min: 50, type: 'map_correction', lon: h[0], lat: h[1], was: 'free', now: 'blocked', note: 'loose sand' },
    { t_min: 60, type: 'note', template: 'geology', text: 'laminated mudstone, 2 cm layers' },
    { t_min: 65, type: 'task_done', name: 'Outcrop', planned_min: 20, actual_min: 30 },
    { t_min: 65, type: 'adapt', decision: 'skip', dropped: [{ name: 'Crater rim', reason: 'not enough O2' }] },
    { t_min: 65, type: 'phase', phase: 'returning' }, { t_min: 90, type: 'phase', phase: 'ingress' },
    { t_min: 90, type: 'position', lon: h[0], lat: h[1], o2_used_min: 80, dose_mSv: 0.02 }, { t_min: 105, type: 'phase', phase: 'done' },
  ] };
const R = buildReport(log, site);
let fails = 0; const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!ok) fails++; };
check('phases add up to EVA time', Math.abs(Object.values(R.phases_min).reduce((a, b) => a + b, 0) - 105) < 0.01, JSON.stringify(R.phases_min));
check('walked distance from the track (out and back)', Math.abs(R.summary.distance_walked_m - 2 * 10 * 0.0003 * Math.PI / 180 * 3389500 * Math.cos(h[1] * Math.PI / 180)) < 3, `${R.summary.distance_walked_m} m`);
check('O2 % from last sample (80/480)', R.summary.o2_used_pct === 16.7);
check('battery = 120 W × 105 min = 210 Wh', R.summary.battery_used_Wh === 210);
check('overtime 10 min', R.overtime_min === 10);
check('map update + correction + note + adapt recorded', R.map_updates.length === 1 && R.map_corrections.length === 1 && R.notes.length === 1 && R.adaptations.length === 1);
check('LMST 09:00 -> ~10:42', R.time.start_lmst === '09:00' && R.time.end_lmst === '10:42', `${R.time.start_lmst} -> ${R.time.end_lmst}`);
const md = reportToMarkdown(R);
check('markdown renders', md.includes('# Mission report') && md.includes('Map corrections'));
console.log('\n' + md);
process.exit(fails ? 1 : 0);
