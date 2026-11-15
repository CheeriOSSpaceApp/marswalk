// ring.js — real no-return zone from Eric's costToHome raster (docs/INTEGRATION.md §6).
// A cell is beyond no-return if walking home from it would not fit in the O2 left:
//     costToHome[i] > usable_o2_min − o2_used_min − pending ingress          (Rule 1, O2)
//  or distToHome[i] > walkback_m                                             (Rule 2, ICES walkback)
// costToHome already includes the alert state (o2_x), so it is re-requested whenever the state changes.
import L from 'leaflet';
import { dist } from './geo.js';

export function createRing(map, bounds, meta) {
  const W = meta.width, H = meta.height;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d'), img = ctx.createImageData(W, H);
  if (!map.getPane('ringPane')) { map.createPane('ringPane').style.zIndex = 450; map.getPane('ringPane').style.pointerEvents = 'none'; }  // above the image layers (overlay pane = 400), below markers
  const layer = L.imageOverlay(canvas.toDataURL(), bounds, { opacity: 0.55, interactive: false, pane: 'ringPane' });
  let data = null, lastLeft = null, busy = false, url = null, live = false;

  function flush() {
    ctx.putImageData(img, 0, 0);
    canvas.toBlob(b => { if (!b) return; const u = URL.createObjectURL(b); layer.setUrl(u); if (url) URL.revokeObjectURL(url); url = u; busy = false; });
  }
  // Live safe zone (Eric's planner.safeZone, INTEGRATION §9.2): 0 no-return = dark red · 1 tight (< 30 min margin) = amber · 2 safe = clear
  function paintZone(zone) {
    const d = img.data;
    for (let i = 0; i < W * H; i++) {
      const z = zone[i];
      d[4 * i] = z === 1 ? 255 : 120; d[4 * i + 1] = z === 1 ? 170 : 0; d[4 * i + 2] = z === 1 ? 0 : 10; d[4 * i + 3] = z === 0 ? 170 : z === 1 ? 90 : 0;
    }
    flush();
  }
  function paint(left) {
    // Tier 2: with O₂ caches the safe zone is 'can reach home OR a cache' (Eric's costToSafety; null without caches)
    const { distToHome: dth, walkback_m: wb } = data, cth = data.costToSafety || data.costToHome, d = img.data, lim = wb ?? Infinity;
    for (let i = 0; i < W * H; i++) {
      const out = !(cth[i] <= left) || dth[i] > lim;           // Infinity (unreachable) also counts as "out"
      d[4 * i] = 120; d[4 * i + 1] = 0; d[4 * i + 2] = 10; d[4 * i + 3] = out ? 170 : 0;
    }
    flush();
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
      if (!data || busy || live) return;          // the live zone (when available) replaces the static ring
      if (!force && lastLeft != null && Math.abs(left - lastLeft) < 1) return;
      busy = true; lastLeft = left; paint(left);
    },
    get live() { return live; },
    showZone(z) { live = true; busy = true; paintZone(z.zone); },
  };
}

// Calls planner.safeZone when the astronaut moved >= 20 m or O₂ used changed >= 2 min (§9.2), or when forced (alert, refill, new plan).
// One request at a time; the newest pending one runs next. onZone(z) gets the full result (here_margin_min, wait_max_min, ...).
export function liveZone(planner, ring, getState, onZone = () => {}) {
  let last = null, running = false, queued = null, off = false;
  async function refresh(pos, used, force = false) {
    if (off || !pos) return;
    if (!force && last && dist(pos, last.pos) < 20 && Math.abs(used - last.used) < 2) return;
    if (running) { queued = { pos, used }; return; }
    running = true; last = { pos, used };
    try {
      const z = await planner.safeZone({ current: pos, o2_used_min: used, state: getState(), tight_min: 30 });
      if (z && !z.error && z.zone) { ring.showZone(z); onZone(z); }
    } catch (e) { console.warn('[ring] safeZone unavailable, static ring', e); off = true; }
    running = false;
    if (queued) { const q = queued; queued = null; refresh(q.pos, q.used, true); }
  }
  return { refresh, invalidate() { last = null; } };
}
