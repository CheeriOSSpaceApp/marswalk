// Console <-> tablet messaging (same browser). Messages: {type: 'plan'|'alert'|'position', payload}
const ch = new BroadcastChannel('marswalk');
export const send = (type, payload) => ch.postMessage({ type, payload });
export const onMessage = (fn) => ch.addEventListener('message', e => fn(e.data));
