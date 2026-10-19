/** 搜索页 */

import { h, clear, debounce } from '../util/dom.js';
import { fmtPrice, fmtPct, dirClass } from '../util/format.js';
import { suggest } from '../data/sources/search.js';
import { getQuotes } from '../data/quotes.js';
import { addItem, hasItem, addNTeam, hasNTeam, subscribe } from '../core/store.js';
import { marketLabel, kindLabel, kindClass, codeText } from '../data/symbols.js';
import { toast } from './toast.js';

const HOT = [
  { label: '沪深300ETF', q: '沪深300ETF' },
  { label: '科创50', q: '科创50' },
  { label: '纳指100', q: '纳斯达克100' },
  { label: '恒生科技', q: '恒生科技' },
  { label: '黄金', q: '黄金' },
  { label: '贵州茅台', q: '贵州茅台' },
  { label: '中证500', q: '中证500' },
  { label: '半导体', q: '半导体' },
];

export function initSearch(opt) {
  const input = opt.input;
  const body = opt.body;
  const clearBtn = opt.clearBtn;
  const onAdded = opt.onAdded;
  const onView = opt.onView;

  let seq = 0;
  let lastKeyword = '';
  let lastResults = [];

  const renderEmpty = () => {
    clear(body);
    body.appendChild(h('div.sec-title', { text: '热门搜索' }));
    const chips = h('div.hot');
    for (const item of HOT) {
      chips.appendChild(h('button.chip', {
        type: 'button',
        text: item.label,
        onclick: () => {
          input.value = item.q;
          clearBtn.hidden = false;
          runSearch(item.q);
          input.blur();
        },
      }));
    }
    body.appendChild(chips);
    body.appendChild(h('div.search__hint', {
      html: '支持搜索 <strong>A 股个股</strong>、<strong>场内 ETF</strong>、<strong>港股</strong>、<strong>主要指数</strong><br>也可直接输入 6 位代码',
    }));
  };

  const rowOf = item => {
    const added = hasItem(item.id);
    const ntAdded = hasNTeam(item.id);
    const priceEl = h('span.srow__price.num', { text: '--' });
    const pctEl = h('span.srow__price.num', { text: '' });

    const addBtn = h('button.srow__add', {
      type: 'button',
      class: added ? 'is-added' : '',
      'aria-label': added ? '已加入自选' : '加入自选',
      text: added ? '✓ 自选' : '+ 自选',
      onclick: e => {
        e.stopPropagation();
        if (hasItem(item.id)) {
          toast('已在自选');
          return;
        }
        const res = addItem(item);
        if (res.ok) {
          toast('已加入自选');
          addBtn.classList.add('is-added');
          addBtn.textContent = '✓ 自选';
          onAdded?.(item.id);
        } else {
          toast(res.reason || '添加失败');
        }
      },
    });

    const ntBtn = h('button.srow__nt', {
      type: 'button',
      class: ntAdded ? 'is-added' : '',
      'aria-label': ntAdded ? '已加入国家队' : '加入国家队',
      text: ntAdded ? '✓ 国家队' : '+ 国家队',
      onclick: e => {
        e.stopPropagation();
        if (hasNTeam(item.id)) {
          toast('已在国家队');
          return;
        }
        const res = addNTeam(item);
        if (res.ok) {
          toast('已加入国家队');
          ntBtn.classList.add('is-added');
          ntBtn.textContent = '✓ 国家队';
        } else {
          toast(res.reason || '添加失败');
        }
      },
    });

    const row = h('div.srow', {
      dataset: { id: item.id },
      onclick: () => onView?.(item.id),
    }, [
      h('div.srow__main', {}, [
        h('div.srow__head', {}, [
          h('span.srow__name', { text: item.name }),
          h(`span.badge.${kindClass(item).trim()}`, { text: kindLabel(item) }),
        ]),
        h('div.srow__sub', {}, [
          h('span', { text: codeText(item.id) }),
          h('span', { text: marketLabel(item) }),
        ]),
      ]),
      h('div.srow__right', {}, [h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' } }, [priceEl, pctEl]), h('div.srow__acts', {}, [ntBtn, addBtn])]),
    ]);

    return { row, priceEl, pctEl };
  };

  const renderResults = list => {
    clear(body);
    lastResults = list;

    if (!list.length) {
      body.appendChild(h('div.search__hint', { text: '没有找到相关标的，换个关键词试试' }));
      return;
    }

    const frag = document.createDocumentFragment();
    const refs = [];
    for (const item of list) {
      const r = rowOf(item);
      refs.push({ item, ...r });
      frag.appendChild(r.row);
    }
    body.appendChild(frag);

    // 一次性批量补价格（1 个请求）
    const ids = list.map(x => x.id);
    getQuotes(ids, { maxAge: 10_000 }).then(map => {
      for (const ref of refs) {
        const q = map.get(ref.item.id);
        if (!q) continue;
        ref.priceEl.textContent = fmtPrice(q.price, q.digits ?? 2);
        ref.pctEl.textContent = fmtPct(q.pct);
        ref.pctEl.className = 'srow__price num ' + dirClass(q.pct);
      }
    }).catch(() => { /* 价格只是锦上添花 */ });
  };

  const runSearch = debounce(async keyword => {
    const k = (keyword || '').trim();
    if (!k) { renderEmpty(); return; }
    const my = ++seq;
    lastKeyword = k;
    try {
      const list = await suggest(k);
      if (my !== seq) return;
      renderResults(list);
    } catch {
      if (my !== seq) return;
      clear(body);
      body.appendChild(h('div.search__hint', { text: '搜索失败，请检查网络后重试' }));
    }
  }, 250);

  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    runSearch(input.value);
  });

  input.addEventListener('search', () => runSearch(input.value));

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    renderEmpty();
    input.focus();
  });

  // 自选 / 国家队变化时刷新「已添加」状态
  subscribe(type => {
    if (type !== 'add' && type !== 'remove' && type !== 'nteam') return;
    if (!lastKeyword || !lastResults.length) return;
    renderResults(lastResults);
  });

  renderEmpty();

  return {
    focus() {
      // 进搜索页不自动弹键盘，避免遮挡
    },
    reset() {
      input.value = '';
      clearBtn.hidden = true;
      renderEmpty();
    },
  };
}
