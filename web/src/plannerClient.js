// plannerClient.js — What Santiago imports. Hides the worker behind Promises.
//
//   import { createPlanner } from './plannerClient.js';
//   const planner = createPlanner();
//   const { meta } = await planner.init('mock');            // later: 'jezero'
//   const res = await planner.plan({ start: [lon, lat], stops: [], goal: [lon, lat] });
//   if (res.error) ...; else L.geoJSON(res.path).addTo(map); show(res.stats);

export function createPlanner() {
  const worker = new Worker(new URL('./planner.worker.js', import.meta.url), { type: 'module' });
  let nextId = 0;
  const pending = new Map(); // id -> {resolve, reject}

  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };

  const call = (type, payload) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, payload });
    });

  return {
    init: (site) => call('init', { site }),
    plan: (req) => call('plan', req),
    // req: {current:[lon,lat], alert, state?, o2_used_min?} -> plan + {state, replan:{destination,...}}
    // Keep the returned `state` and pass it in the next call so alerts stack.
    replan: (req) => call('replan', req),
    // -> {costToHome: Float32Array (O2-min per cell), usable_o2_min}. For the no-return ring.
    costToHome: (req = {}) => call('costToHome', req),
    terminate: () => worker.terminate(),
  };
}
