/** 数字滚动动画 */

const rafs = new WeakMap();
const reduce = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

/**
 * 把元素文本从旧值平滑过渡到新值
 * @param {HTMLElement} el
 * @param {number} to
 * @param {(v:number)=>string} format
 * @param {number} [duration]
 */
export function tickTo(el, to, format, duration = 420) {
  if (!el) return;

  const prevRaf = rafs.get(el);
  if (prevRaf) cancelAnimationFrame(prevRaf);

  if (!Number.isFinite(to)) {
    el.textContent = format(to);
    el.dataset.raw = '';
    return;
  }

  const fromRaw = Number(el.dataset.raw);
  el.dataset.raw = String(to);

  // 首次渲染 / 无动画偏好 / 变化太小 → 直接落值
  const tiny = Number.isFinite(fromRaw) && Math.abs(to - fromRaw) < Math.max(Math.abs(fromRaw) * 0.0002, 1e-9);
  if (!Number.isFinite(fromRaw) || reduce() || tiny) {
    el.textContent = format(to);
    return;
  }

  const t0 = performance.now();
  const from = fromRaw;

  const step = now => {
    const p = Math.min(1, (now - t0) / duration);
    const v = from + (to - from) * easeOutCubic(p);
    el.textContent = format(v);
    if (p < 1) rafs.set(el, requestAnimationFrame(step));
    else {
      el.textContent = format(to);
      rafs.delete(el);
    }
  };
  rafs.set(el, requestAnimationFrame(step));
}

/** 直接落值（不做动画） */
export function setText(el, text, raw) {
  if (!el) return;
  const prevRaf = rafs.get(el);
  if (prevRaf) cancelAnimationFrame(prevRaf);
  el.textContent = text;
  if (raw != null) el.dataset.raw = String(raw);
  else el.dataset.raw = '';
}
