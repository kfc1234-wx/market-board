/** 极简事件总线 */

const map = new Map();

export function on(type, fn) {
  if (!map.has(type)) map.set(type, new Set());
  map.get(type).add(fn);
  return () => off(type, fn);
}

export function off(type, fn) {
  const set = map.get(type);
  if (set) set.delete(fn);
}

export function emit(type, payload) {
  const set = map.get(type);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (e) { console.error(e); }
  }
}

export function once(type, fn) {
  const un = on(type, p => { un(); fn(p); });
  return un;
}
