/** 极简 DOM 工具 */

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * 创建元素
 * @param {string} tag 可带 class，如 'div.row'
 * @param {object|null} [props] 属性 / dataset / 事件（on开头）
 * @param {Array|string|Node} [children]
 */
export function h(tag, props, children) {
  const [name, ...rest] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (rest.length) el.className = rest.join(' ');

  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k in el && k !== 'list') {
        try { el[k] = v; } catch { el.setAttribute(k, v); }
      } else {
        el.setAttribute(k, v);
      }
    }
  }

  append(el, children);
  return el;
}

export function append(el, children) {
  if (children == null) return el;
  if (Array.isArray(children)) {
    for (const c of children) append(el, c);
    return el;
  }
  el.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
  return el;
}

/** 从 HTML 字符串建节点 */
export function fromHTML(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

/** 清空子节点 */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** 事件绑定，返回解绑函数 */
export function on(el, type, handler, opt) {
  el.addEventListener(type, handler, opt);
  return () => el.removeEventListener(type, handler, opt);
}

/** 防抖 */
export function debounce(fn, wait = 250) {
  let t = 0;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** 节流到下一帧 */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}
