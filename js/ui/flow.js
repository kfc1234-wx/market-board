/** ETF 资金流面板（详情页「资金」子 tab） */

import { h, clear } from '../util/dom.js';
import { fmtSignedBig, fmtPct, dirClass, fmtBig } from '../util/format.js';
import { getFlow } from '../data/flows.js';
import { FlowBarChart } from '../chart/flowbar.js';

const RANGES = [5, 10, 20];

/**
 * @param {HTMLElement} host
 * @param {string} id
 * @param {any} sym
 * @returns {{destroy:()=>void}}
 */
export function renderFlowPanel(host, id, sym) {
  let chart = null;
  let rows = [];
  let range = 20;
  let dead = false;

  const amountEl = h('span.flow__amount', { text: '--' });
  const pctEl = h('span.flow__pct', { text: '' });

  const mainCell = h('dd', { text: '--' });
  const mainPctCell = h('dd', { text: '--' });
  const sumCell = h('dd', { text: '--' });
  const streakCell = h('dd', { text: '--' });

  const grid = h('dl.flow__grid', {}, [
    h('div.flow__cell', {}, [h('dt', { text: '主力净额（特大单）' }), mainCell]),
    h('div.flow__cell', {}, [h('dt', { text: '主力净占比' }), mainPctCell]),
    h('div.flow__cell', {}, [h('dt', { text: '累计净流入' }), sumCell]),
    h('div.flow__cell', {}, [h('dt', { text: '连续流入/流出' }), streakCell]),
  ]);

  const rangeBar = h('div.flow__range');
  const rangeBtns = new Map();
  for (const n of RANGES) {
    const btn = h('button', {
      type: 'button',
      text: `${n}日`,
      class: n === range ? 'is-active' : '',
      onclick: () => {
        range = n;
        for (const [k, el] of rangeBtns) el.classList.toggle('is-active', k === n);
        paintStats();
        if (chart) chart.setData(rows.slice(-range));
      },
    });
    rangeBtns.set(n, btn);
    rangeBar.appendChild(btn);
  }

  const head = h('div.flow__head', {}, [
    h('div.flow__big', {}, [
      h('span.flow__big-label', { text: '当日净流入（盘口推断）' }),
      amountEl,
      pctEl,
    ]),
    rangeBar,
    grid,
  ]);

  const legend = h('div.chart-legend', {}, [
    h('span.legend-item', {}, [
      h('span.legend-dot', { style: { background: 'var(--up)' } }),
      h('span', { text: '净流入' }),
    ]),
    h('span.legend-item', {}, [
      h('span.legend-dot', { style: { background: 'var(--down)' } }),
      h('span', { text: '净流出' }),
    ]),
    h('span.legend-item', {}, [
      h('span.legend-dot', { style: { background: 'var(--chart-ma5)' } }),
      h('span', { text: 'MA5' }),
    ]),
  ]);

  const canvasHost = h('div.canvas-host');
  const stateEl = h('div.chart-state', { text: '加载资金流…' });

  const note = h('div.flow__note', {
    text: '口径说明：净流入 = 主动买入额 − 主动卖出额；主力净额为特大单口径（新浪）。'
      + '该数据由逐笔成交推断，不等同于 ETF 的真实申购赎回，仅供参考，不构成投资建议。',
  });

  const chartWrap = h('div.chartwrap', {}, [legend, canvasHost, stateEl]);
  const root = h('div.flow', {}, [head, chartWrap, note]);
  host.appendChild(root);

  function paintStats() {
    const today = rows[rows.length - 1];
    if (!today) {
      amountEl.textContent = '--';
      pctEl.textContent = '';
      return;
    }
    amountEl.textContent = fmtSignedBig(today.net);
    amountEl.className = 'flow__amount ' + dirClass(today.net);
    pctEl.textContent = fmtPct(today.netPct);
    pctEl.className = 'flow__pct ' + dirClass(today.net);

    mainCell.textContent = fmtSignedBig(today.main);
    mainCell.className = dirClass(today.main);

    mainPctCell.textContent = fmtPct(today.mainPct);
    mainPctCell.className = dirClass(today.mainPct);

    const sum = rows.slice(-range).reduce((s, r) => s + r.net, 0);
    sumCell.textContent = fmtSignedBig(sum);
    sumCell.className = dirClass(sum);

    // 连续同向天数
    let streak = 0;
    let dir = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const d = rows[i].net > 0 ? 1 : rows[i].net < 0 ? -1 : 0;
      if (!d) break;
      if (!dir) { dir = d; streak = 1; }
      else if (d === dir) streak++;
      else break;
    }
    if (!streak) {
      streakCell.textContent = '--';
      streakCell.className = '';
    } else {
      streakCell.textContent = `${dir > 0 ? '净流入' : '净流出'} ${streak} 天`;
      streakCell.className = dir > 0 ? 'text-up' : 'text-down';
    }
  }

  async function load() {
    const res = await getFlow(id);
    if (dead) return;

    rows = res.rows || [];
    if (!rows.length) {
      stateEl.hidden = false;
      clear(stateEl);
      stateEl.appendChild(h('div', { text: res.error === 'cooling' ? '请求过于频繁，稍后自动重试' : '暂无资金流数据' }));
      stateEl.appendChild(h('div.chart-state__hint', { text: '该标的可能不支持资金流统计' }));
      amountEl.textContent = '--';
      return;
    }

    stateEl.hidden = true;
    paintStats();

    chart = new FlowBarChart(canvasHost, {});
    chart.setData(rows.slice(-range));

    if (res.stale) {
      legend.appendChild(h('span.badge.badge--stale', { text: '延迟' }));
    }
  }

  load().catch(() => {
    if (dead) return;
    stateEl.hidden = false;
    clear(stateEl);
    stateEl.appendChild(h('div', { text: '资金流加载失败' }));
    stateEl.appendChild(h('div.chart-state__hint', { text: '下拉刷新或稍后再试' }));
  });

  return {
    destroy() {
      dead = true;
      if (chart) { chart.destroy(); chart = null; }
    },
  };
}
