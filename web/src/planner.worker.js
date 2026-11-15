// planner.worker.js — Runs the planner OFF the main thread so the map never freezes.
// Protocol (RPC over postMessage):
//   in:  {id, type: 'init'|'plan'|'replan'|'adapt'|'costToHome', payload}
//   out: {id, ok: true, result} | {id, ok: false, error}
// The worker loads its own copy of the layers (16 MB) once, on 'init'.

import { loadSite } from './data.js';
import { plan, replan, adapt, getCostToHome } from './planner.js';

let site = null;

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    let result;
    if (type === 'init') {
      site = await loadSite(payload.site);
      result = { meta: site.meta, targets: site.targets, alerts: site.alerts };
    } else if (type === 'plan') {
      if (!site) throw new Error('planner not initialized: call init(site) first');
      result = plan(site, payload);
    } else if (type === 'adapt') {
      if (!site) throw new Error('planner not initialized: call init(site) first');
      result = adapt(site, payload);
    } else if (type === 'replan') {
      if (!site) throw new Error('planner not initialized: call init(site) first');
      result = replan(site, payload);
    } else if (type === 'costToHome') {
      if (!site) throw new Error('planner not initialized: call init(site) first');
      result = getCostToHome(site, payload);
      // transfer the 4 MB buffer instead of copying it (zero-copy)
      self.postMessage({ id, ok: true, result }, [result.costToHome.buffer, result.distToHome.buffer]);
      return;
    } else {
      throw new Error('unknown message type: ' + type);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.stack || err) });
  }
};
