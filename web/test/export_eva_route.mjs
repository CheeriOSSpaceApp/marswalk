// Export the current Jezero EVA route for the rover-validation report.
// Run from web/: node test/export_eva_route.mjs
import fs from 'node:fs';
import { plan } from '../src/planner.js';

const dir = new URL('../public/data/jezero/', import.meta.url);
const common = new URL('../public/data/common/', import.meta.url);
const json = (base, file) => JSON.parse(fs.readFileSync(new URL(file, base)));
const bin = (file, Type) => {
  const b = fs.readFileSync(new URL(file, dir));
  return new Type(b.buffer, b.byteOffset, b.byteLength / Type.BYTES_PER_ELEMENT);
};

const targets = json(dir, 'targets.geojson');
const byKind = kind => targets.features.filter(f => f.properties.kind === kind);
const site = {
  meta: json(dir, 'meta.json'),
  targets,
  suit: json(common, 'suit.json'),
  params: json(common, 'params.json'),
  alerts: json(common, 'alerts.json'),
  layers: {
    elevation: bin('elevation.f32', Float32Array),
    slope: bin('slope.f32', Float32Array),
    roughness: bin('roughness.f32', Float32Array),
    hazard: bin('hazard.u8', Uint8Array),
    viewshed: bin('viewshed.u8', Uint8Array),
  },
};

const habitat = byKind('habitat')[0].geometry.coordinates;
const depots = byKind('depot').map(f => f.geometry.coordinates);
const science = byKind('science')[0].geometry.coordinates;
const result = plan(site, { start: habitat, stops: [...depots, science], goal: habitat });
if (result.error) throw new Error(`Could not export EVA route: ${result.error}`);

const fullRoute = result.path.geometry.coordinates;
const scienceIndex = fullRoute.reduce((best, point, index) => {
  const distance = Math.hypot(point[0] - science[0], point[1] - science[1]);
  return distance < best.distance ? { distance, index } : best;
}, { distance: Infinity, index: fullRoute.length - 1 }).index;
const outboundRoute = fullRoute.slice(0, scienceIndex + 1);
const out = new URL('../../pipeline/out/jezero_eva_route.geojson', import.meta.url);
fs.mkdirSync(new URL('../../pipeline/out/', import.meta.url), { recursive: true });
fs.writeFileSync(out, JSON.stringify({
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: {
      route: 'MarsWalk EVA-1',
      from_waypoint: 'habitat-threeforks-lz',
      to_waypoint: 'sci-wildcat-ridge',
      planner_stats: result.stats,
    },
    geometry: { type: 'LineString', coordinates: outboundRoute },
  }],
}, null, 2));
console.log(`Exported ${result.path.geometry.coordinates.length} route vertices to ${out.pathname}`);
