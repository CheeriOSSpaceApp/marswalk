import L from 'leaflet';

// Turn a width×height Uint8 raster into a transparent PNG overlay. colorOf(v) -> [r,g,b,a] (0-255)
function rasterOverlay(arr, meta, bounds, colorOf) {
  const c = document.createElement('canvas'); c.width = meta.width; c.height = meta.height;
  const ctx = c.getContext('2d'), img = ctx.createImageData(meta.width, meta.height);
  for (let i = 0; i < arr.length; i++) img.data.set(colorOf(arr[i]), i * 4);
  ctx.putImageData(img, 0, 0);
  return L.imageOverlay(c.toDataURL(), bounds, { opacity: 0.8 });
}

const KIND_COLOR = { habitat: '#ffffff', depot: '#f2c94c', science: '#6fcf97', shelter: '#56ccf2' };

// Returns [{id, label, layer, on, opacity}]; `onAddStop(lonlat, name)` is called from target popups
export function buildLayers(site, name, bounds, onAddStop) {
  const { meta, layers, targets } = site;
  const png = (file, op) => site.url(file) ? L.imageOverlay(site.url(file), bounds, { opacity: op }) : L.layerGroup();
  const out = [
    { id: 'hillshade', label: 'Hillshade', layer: png('hillshade.png', 0.9), on: true, opacity: true },
    { id: 'ortho', label: 'Ortho', layer: png('ortho.png', 0.9), on: false, opacity: true },
    { id: 'slope', label: 'Slope', layer: png('slope.png', 0.7), on: false, opacity: true },
  ];
  if (layers.hazard) out.push({ id: 'hazard', label: 'Hazard (yellow caution, red forbidden)', opacity: true, on: false,
    layer: rasterOverlay(layers.hazard, meta, bounds, v => v === 2 ? [220, 40, 40, 190] : v === 1 ? [255, 200, 0, 150] : [0, 0, 0, 0]) });
  if (layers.viewshed) out.push({ id: 'viewshed', label: 'No comms line-of-sight', opacity: true, on: false,
    layer: rasterOverlay(layers.viewshed, meta, bounds, v => v ? [0, 0, 0, 0] : [30, 60, 200, 150]) });

  const rover = site.url('rover_traverse.geojson') ? fetch(site.url('rover_traverse.geojson')).then(r => r.ok ? r.json() : null) : Promise.resolve(null);
  const roverLayer = L.geoJSON(null, { style: { color: '#bb86fc', weight: 3, dashArray: '6 4' } });
  rover.then(g => g && roverLayer.addData(g));
  out.push({ id: 'rover', label: 'Rover traverse', layer: roverLayer, on: false });

  const tl = L.geoJSON(targets, {
    pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 7, weight: 2, color: '#000', fillColor: KIND_COLOR[f.properties.kind] || '#fff', fillOpacity: 1, bubblingMouseEvents: false }),
    onEachFeature: (f, l) => {
      const p = f.properties, box = document.createElement('div');
      let los = '';
      if (layers.viewshed) {                      // line of sight to the habitat at this target (same idea as pipeline/check_targets_los.py)
        const [x0, y0, x1, y1] = meta.bbox, [lon, lat] = f.geometry.coordinates;
        const col = Math.floor((lon - x0) / (x1 - x0) * meta.width), row = Math.floor((y1 - lat) / (y1 - y0) * meta.height);
        const v = row >= 0 && col >= 0 && row < meta.height && col < meta.width ? layers.viewshed[row * meta.width + col] : 0;
        los = v ? '<span style="color:#2e9e5b">● comms: line of sight</span><br>' : '<span style="color:#c0392b">○ comms: NO line of sight</span><br>';
      }
      box.innerHTML = `<b>${p.name}</b><br>${p.kind} · science value ${p.science_value}/5<br>${los}${p.notes || ''}<br>`;
      if (p.kind !== 'habitat') {
        const b = document.createElement('button'); b.textContent = 'Add as stop';
        b.onclick = () => { onAddStop(f.geometry.coordinates, p.name, p.photo_id, p.kind); l.closePopup(); };
        box.appendChild(b);
      }
      l.bindPopup(box);
    },
  });
  const targetLegend = [
    { color: KIND_COLOR.habitat, name: 'White', meaning: 'Habitat (start and end of the EVA)' },
    { color: KIND_COLOR.depot, name: 'Yellow', meaning: 'Sample depot (drop zones with tubes)' },
    { color: KIND_COLOR.science, name: 'Green', meaning: 'Science target' },
    { color: KIND_COLOR.shelter, name: 'Blue', meaning: 'Shelter / safe point' },
  ];
  out.push({ id: 'targets', label: 'Targets', layer: tl, on: true, legend: targetLegend });
  return out;
}
