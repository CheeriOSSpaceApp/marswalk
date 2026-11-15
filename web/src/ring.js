// ring.js — real no-return zone from Eric's costToHome raster (docs/INTEGRATION.md §6).
// A cell is beyond no-return if walking home from it would not fit in the O2 left:
//     costToHome[i] > usable_o2_min − o2_used_min − pending ingress          (Rule 1, O2)
//  or distToHome[i] > walkback_m                                             (Rule 2, ICES walkback)
// costToHome already includes the alert state (o2_x), so it is re-requested whenever the state changes.
import L from 'leaflet';

export function createRing(map, bounds, meta) {
  const W = meta.width, H = meta.height;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d'), img = ctx.createImageData(W, H);
  if (!map.getPane('ringPane')) { map.createPane('ringPane').style.zIndex = 450; map.getPane('ringPane').style.pointerEvents = 'none'; }  // above the image layers (overlay pane = 400), below markers
  const layer = L.imageOverlay(canvas.toDataURL(), bounds, { opacity: 0.55, interactive: false, pane: 'ringPane' });
  let data = null, lastLeft = null, busy = false, url = null;

  function paint(left) {
    const { costToHome: cth, distToHome: dth, walkback_m: wb } = data, d = img.data, lim = wb ?? Infinity;
    for (let i = 0; i < W * H; i++) {
      const out = !(cth[i] <= left) || dth[i] > lim;           // Infinity (unreachable) also counts as "out"
      d[4 * i] = 120; d[4 * i + 1] = 0; d[4 * i + 2] = 10; d[4 * i + 3] = out ? 170 : 0;
    }
    ctx.putImageData(img, 0, 0);
    canvas.toBlob(b => { if (!b) return; const u = URL.createObjectURL(b); layer.setUrl(u); if (url) URL.revokeObjectURL(url); url = u; busy = false; });
  }
  return {
    layer,
    get ready() { return !!data; },
    get usable() { return data?.usable_o2_min ?? null; },
    // O2-min to walk home from [lon,lat] at the current state (null if not loaded)
    costAt(lon, lat) {
      if (!data) return null;
      const [x0, y0, x1, y1] = meta.bbox;
      const col = Math.floor((lon - x0) / (x1 - x0) * W), row = Math.floor((y1 - lat) / (y1 - y0) * H);
      if (col < 0 || row < 0 || col >= W || row >= H) return Infinity;
      return data.costToHome[row * W + col];
    },
    setData(d) { data = d; lastLeft = null; },
    // left = O2-min still available for walking home. Repaints only when it moved ≥ 1 min (repaint ≈ 30–60 ms).
    update(left, force = false) {
      if (!data || busy) return;
      if (!force && lastLeft != null && Math.abs(left - lastLeft) < 1) return;
      busy = true; lastLeft = left; paint(left);
    },
  };
}
