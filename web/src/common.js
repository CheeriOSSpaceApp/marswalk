import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { loadSite } from './site.js';

// Mars Trek basemap (global, 232 m/px): context only, our own rasters matter at ~3 km scale.
const TREK = 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg';

export const getSiteName = () => new URLSearchParams(location.search).get('site') || 'jezero';      // jezero first; any missing file falls back to mock (see site.js)
export const dataUrl = (name, file) => `${import.meta.env.BASE_URL}data/${name}/${file}`;
// contract bbox [lonMin, latMin, lonMax, latMax] -> Leaflet [[lat,lon],[lat,lon]]
export const toBounds = ([lonMin, latMin, lonMax, latMax]) => [[latMin, lonMin], [latMax, lonMax]];

export async function createSiteMap() {
  const status = document.getElementById('status');
  const name = getSiteName();
  document.getElementById('site').textContent = name;

  let site;
  try { site = await loadSite(name); if (!site.meta) throw new Error(`meta.json not found for "${name}"`); }
  catch (e) { status.textContent = e.message; throw e; }

  const notes = [];
  if (site.fellBack.length) notes.push(site.fellBack.length <= 3 ? `Using mock for: ${site.fellBack.join(', ')}` : `${site.fellBack.length} file(s) not in ${name}/: using mock (list in the browser console)`);
  const bounds = toBounds(site.meta.bbox);
  const map = L.map('map', { crs: L.CRS.EPSG4326, maxZoom: 18, zoomSnap: 0.25 }); // Mars grids are equirectangular
  const basemap = L.tileLayer(TREK, { maxNativeZoom: 7, maxZoom: 18, noWrap: true, attribution: 'NASA/JPL · USGS · Mars Trek' });
  // Sanity check: every target must lie inside meta.bbox, otherwise files come from different sites
  const [x0, y0, x1, y1] = site.meta.bbox;
  const outside = (site.targets?.features || []).filter(f => { const [x, y] = f.geometry.coordinates; return x < x0 || x > x1 || y < y0 || y > y1; });
  if (outside.length) {
    const msg = `${outside.length} target(s) fall outside meta.bbox: targets.geojson and meta.json/rasters are from different sites.`;
    console.warn(msg); notes.push(msg);
  }
  if (status && notes.length) status.textContent = notes.join(' · ');
  map.fitBounds(bounds);
  return { map, site, name, bounds, basemap };
}
