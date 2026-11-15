// presets.js — named EVA set-ups saved from the planner test bench and listed in the console.
// A preset = {id, name, saved_at, cfg} where cfg is the same object the bench sends with "Send to console":
//   {site, stops:[[lon,lat]], start_hour, o2_start_min, state:{o2_x?, visibility?}, route_label}
// Stored in this browser (localStorage); every open tab of the same browser sees changes at once.
import { send, onMessage } from './bus.js';

const KEY = 'marswalk:presets';
export function loadPresets(site = null) {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch {}
  return site ? list.filter(p => p.cfg?.site === site) : list;
}
function store(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
  send('presets', { count: list.length });           // tabs that miss the storage event still refresh
}
export function addPreset(name, cfg) {
  const list = loadPresets().filter(p => !(p.name === name && p.cfg?.site === cfg.site));   // same name = overwrite
  list.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, saved_at: Date.now(), cfg });
  store(list);
}
export function removePreset(id) { store(loadPresets().filter(p => p.id !== id)); }
export function onPresetsChange(fn) {
  window.addEventListener('storage', e => { if (e.key === KEY) fn(); });
  onMessage(m => { if (m.type === 'presets') fn(); });
}
const hh = h => `${String(Math.floor(h)).padStart(2, '0')}:${h % 1 ? '30' : '00'}`;
export function presetSummary(cfg, o2Total = 480) {
  const st = cfg.state || {}, cond = [st.o2_x > 1 && 'suit failure', st.visibility < 1 && 'dust'].filter(Boolean).join(' + ') || 'normal';
  const n = (cfg.stops || []).length;
  return `${n} points · O₂ ${Math.round((cfg.o2_start_min ?? o2Total) / o2Total * 100)} % · start ${hh(cfg.start_hour ?? 9)} · ${cond}`;
}
