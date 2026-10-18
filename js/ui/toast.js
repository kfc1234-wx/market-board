/** 轻提示 与 底部动作面板 */

import { h, clear } from '../util/dom.js';

const host = () => document.getElementById('toast-host');

let timer = 0;
let current = null;

/**
 * @param {string} text
 * @param {number} [ms]
 */
export function toast(text, ms = 1800) {
  const box = host();
  if (!box) return;

  if (current) {
    current.classList.add('is-out');
    const old = current;
    setTimeout(() => old.remove(), 200);
  }

  const el = h('div.toast', { text });
  box.appendChild(el);
  current = el;

  clearTimeout(timer);
  timer = setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 220);
    if (current === el) current = null;
  }, ms);
}

let snackEl = null;
let snackTimer = 0;

function dismissSnack() {
  clearTimeout(snackTimer);
  snackTimer = 0;
  const el = snackEl;
  snackEl = null;
  if (!el) return;
  el.classList.add('is-out');
  setTimeout(() => el.remove(), 220);
}

/**
 * 带一个操作按钮的提示条（删除撤销用）
 * 与 toast 分开管理：toast 会自动消失，snackbar 要留住按钮等用户点
 * @param {{text:string, actionLabel?:string, onAction?:() => void, ms?:number}} cfg
 */
export function snackbar(cfg) {
  const box = host();
  if (!box) return;

  dismissSnack();

  const el = h('div.snack');
  el.appendChild(h('span.snack__text', { text: cfg.text }));

  if (cfg.actionLabel) {
    el.appendChild(h('button.snack__btn', {
      type: 'button',
      text: cfg.actionLabel,
      onclick: () => {
        const fn = cfg.onAction;
        dismissSnack();
        fn?.();
      },
    }));
  }

  box.appendChild(el);
  snackEl = el;
  snackTimer = setTimeout(dismissSnack, cfg.ms ?? 4000);
}

/**
 * 底部动作面板
 * @param {{title?:string, actions:Array<{label:string, value:any, danger?:boolean}>}} cfg
 * @returns {Promise<any|null>}
 */export function actionSheet(cfg) {
  return new Promise(resolve => {
    const mask = h('div.mask');
    const sheet = h('div.sheet');

    if (cfg.title) sheet.appendChild(h('div.sheet__title', { text: cfg.title }));

    const close = value => {
      sheet.classList.add('is-out');
      mask.classList.add('is-out');
      setTimeout(() => { mask.remove(); sheet.remove(); }, 200);
      resolve(value);
    };

    for (const act of cfg.actions) {
      sheet.appendChild(h('button.sheet__item', {
        type: 'button',
        class: act.danger ? 'is-danger' : '',
        text: act.label,
        onclick: () => close(act.value),
      }));
    }

    sheet.appendChild(h('button.sheet__item.sheet__item--cancel', {
      type: 'button',
      text: '取消',
      onclick: () => close(null),
    }));

    mask.addEventListener('click', () => close(null));
    document.body.appendChild(mask);
    document.body.appendChild(sheet);
    requestAnimationFrame(() => {
      mask.classList.add('is-in');
      sheet.classList.add('is-in');
    });
  });
}

/** 安装提示（iOS 无 beforeinstallprompt，需要图文引导） */
export function installHint(text) {
  const box = host();
  if (!box) return;
  const el = h('div.toast', { text, style: { maxWidth: '78vw', lineHeight: '1.5' } });
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 220);
  }, 4200);
}

export { clear };
