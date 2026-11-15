import L from 'leaflet';

// Circle in metres on Mars as a polygon (Leaflet's L.circle assumes Earth's radius)
const R = 3396190, rad = x => x * Math.PI / 180, deg = x => x * 180 / Math.PI;
export function dist(a, b) {                     // metres between [lon,lat] points, equirectangular (fine at ~3 km)
  const x = rad(b[0] - a[0]) * Math.cos(rad((a[1] + b[1]) / 2)), y = rad(b[1] - a[1]);
  return R * Math.hypot(x, y);
}
export function ringPolygon(center, r) {          // center = [lon, lat]
  const pts = [];
  for (let a = 0; a < 360; a += 5) {
    const dy = r * Math.cos(rad(a)) / R, dx = r * Math.sin(rad(a)) / (R * Math.cos(rad(center[1])));
    pts.push([center[1] + deg(dy), center[0] + deg(dx)]);
  }
  return pts;
}

// Astronaut helmet marker. Pink on purpose: no other point on the map uses this color.
const HELMET = `<svg viewBox="0 0 32 32" width="34" height="34" xmlns="http://www.w3.org/2000/svg">
  <path d="M16 3C9 3 4 8.5 4 15v6c0 2 1 3 3 3h2l1 4h12l1-4h2c2 0 3-1 3-3v-6C28 8.5 23 3 16 3z" fill="#ff4fa3" stroke="#000" stroke-width="2"/>
  <rect x="8" y="10" width="16" height="9" rx="4.5" fill="#101820" stroke="#000" stroke-width="1.5"/>
  <path d="M11 12.5c2-1 5-1 7 0" stroke="#fff" stroke-width="1.5" fill="none" opacity=".75"/></svg>`;
export const helmetIcon = () => L.divIcon({ className: 'helmet', html: HELMET, iconSize: [34, 34], iconAnchor: [17, 17] });
