/**
 * 国家队 · 汇总比照页
 *
 * 入口是底部汇总卡的两个格子：点「成交量」进成交量比照，点「资金量」进资金量比照。
 * 同一个页面按 mode 切换指标，按 win 切换窗口（今日 / 昨日 / 5 日 / 10 日 / 30 日）。
 *
 * 为什么不做成页面上的一张常驻卡：
 *   五个窗口 × 两个指标 = 十种视图，常驻卡只能固定一个窗口，
 *   想换个窗口就得再来一张卡，列表会越来越长；做成二级页，
 *   窗口和指标都在页内切，主列表保持干净。
 *
 * 纯展示组件：数据由 NTeam 算好传进来，这里不碰网络。
 */

import { h, clear } from '../util/dom.js';
import { fmtVolume, fmtSignedBig, dirClass } from '../util/format.js';

/** 窗口定义，days=0 表示单日（由调用方按交易日历取最后一根 / 倒数第二根） */
export const SUM_WINS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'd5', label: '5 日' },
  { key: 'd10', label: '10 日' },
  { key: 'd30', label: '30 日' },
];

const MODE_TITLE = {
  vol: '成交量汇总比照',
  flow: '资金量汇总比照',
};

/** 超过这个数量就不画了，再长也没人一行行看 */
const MAX_ROWS = 60;

export class NTeamSum {
  /**
   * @param {{onClose?:()=>void, onWin?:(key:string)=>void}} [opt]
   */
  constructor(opt = {}) {
    this.onClose = opt.onClose || (() => {});
    this.onWin = opt.onWin || (() => {});

    /** 'vol' | 'flow' */
    this.mode = 'vol';
    /** SUM_WINS 里的 key */
    this.win = 'd5';
    /** 数据是否还在加载（由外部通过 update 的 meta 传入） */
    this.loading = false;

    this.titleEl = h('div.ns__title', { text: '' });
    this.metaL = h('div.ns__meta-l', { text: '' });
    this.metaR = h('div.ns__meta-r', { text: '' });
    this.legendEl = h('div.ns__lg');
    this.bodyEl = h('div.ns__body');
    this.noteEl = h('p.ns__note');

    this.tabBtns = new Map();
    const tabs = h('div.ns__tabs', {}, SUM_WINS.map(w => {
      const btn = h('button.ns__tab' + (w.key === this.win ? '.is-on' : ''), {
        type: 'button',
        text: w.label,
        onclick: () => this.setWin(w.key),
      });
      this.tabBtns.set(w.key, btn);
      return btn;
    }));

    const back = h('button.ns__back', {
      type: 'button',
      'aria-label': '返回',
      html: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">'
        + '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" '
        + 'stroke-linecap="round" stroke-linejoin="round"/></svg>',
      onclick: () => this.onClose(),
    });

    this.el = h('div.ns', { hidden: true }, [
      h('div.ns__bar', {}, [back, this.titleEl]),
      tabs,
      h('div.ns__meta', {}, [this.metaL, this.metaR]),
      this.legendEl,
      this.bodyEl,
      this.noteEl,
    ]);
    document.body.appendChild(this.el);
  }

  get open() {
    return !this.el.hidden;
  }

  /**
   * 打开 / 切换指标
   * @param {'vol'|'flow'} mode
   */
  show(mode) {
    this.mode = mode === 'flow' ? 'flow' : 'vol';
    this.titleEl.textContent = MODE_TITLE[this.mode];
    this.el.classList.toggle('ns--flow', this.mode === 'flow');
    this.syncTabs();
    this.paintLegend();
    this.el.hidden = false;
    // 打开瞬间先清空，避免上一次的另一种指标的内容残留一帧
    clear(this.bodyEl);
    this.metaL.textContent = '';
    this.metaR.textContent = '';
  }

  hide() {
    this.el.hidden = true;
  }

  setWin(key) {
    if (key === this.win) return;
    this.win = key;
    this.syncTabs();
    this.onWin(key);
  }

  syncTabs() {
    for (const [k, btn] of this.tabBtns) btn.classList.toggle('is-on', k === this.win);
  }

  paintLegend() {
    const isFlow = this.mode === 'flow';
    this.legendEl.textContent = '';
    this.legendEl.appendChild(h('span.ns__lg-item', {}, [
      h(`i.ns__dot.ns__dot--${isFlow ? 'flow' : 'vol'}`),
      h('span', { text: isFlow ? '净流入（红）/ 净流出（绿）' : '成交量' }),
    ]));
    this.legendEl.appendChild(h('span.ns__sort', {
      text: isFlow ? '按净额降序' : '按成交量降序',
    }));
  }

  /**
   * @param {Array<{id:string,name:string,kind:string,value:number,series:Array<{date:string,v:number}>,days:number}>} rows
   * @param {{start?:string,end?:string,tradeDays?:number,loading?:boolean}} [meta]
   */
  update(rows, meta = {}) {
    if (!this.open) return;

    const list = Array.isArray(rows) ? rows : [];
    const isFlow = this.mode === 'flow';

    /* 排序：有数据在前；有数据内部按数值降序（资金量正数天然靠前，负数沉底） */
    const sorted = [...list].sort((a, b) => {
      const ha = Number.isFinite(a.value);
      const hb = Number.isFinite(b.value);
      if (ha !== hb) return ha ? -1 : 1;
      return (b.value || 0) - (a.value || 0);
    }).slice(0, MAX_ROWS);

    const vals = sorted.filter(r => Number.isFinite(r.value)).map(r => r.value);
    const maxAbs = Math.max(1, ...vals.map(Math.abs));
    const sum = vals.reduce((s, v) => s + v, 0);
    const posSum = vals.filter(v => v > 0).reduce((s, v) => s + v, 0);

    /* ---- 顶部摘要 ---- */
    const { start = '', end = '', tradeDays = 0 } = meta;
    // 单日窗口起止是同一天，写「10-22 ~ 10-22」只会让人多看一眼
    const range = start && end
      ? (start === end ? short(start) : `${short(start)} ~ ${short(end)}`)
      : '';
    this.metaL.textContent = range + (tradeDays > 1 ? ` · ${tradeDays} 个交易日` : '');

    if (!vals.length) {
      this.metaR.textContent = meta.loading ? '加载中…' : '暂无数据';
      this.metaR.className = 'ns__meta-r';
    } else if (isFlow) {
      this.metaR.textContent = `合计 ${fmtSignedBig(sum, 1)}`;
      this.metaR.className = 'ns__meta-r ' + dirClass(sum);
    } else {
      this.metaR.textContent = `合计 ${fmtVolume(sum, 1)}手`;
      this.metaR.className = 'ns__meta-r';
    }

    /* ---- 列表 ---- */
    clear(this.bodyEl);

    if (!sorted.length) {
      this.bodyEl.appendChild(h('div.ns__empty', {}, [
        h('p.ns__empty-title', { text: '清单里还没有标的' }),
        h('p.ns__empty-sub', { text: '回到国家队页添加几只，再回来比照' }),
      ]));
      this.noteEl.textContent = '';
      this.noteEl.hidden = true;
      return;
    }

    for (const r of sorted) {
      this.bodyEl.appendChild(this.row(r, maxAbs, posSum));
    }

    /* ---- 脚注 ---- */
    // 全部标的都还没有数（刚打开、日线还在拉）：不要报「N 只取不到数据」，
    // 那会把「还没加载」说成「取不到」，用户会以为坏了
    if (meta.loading && !vals.length) {
      this.noteEl.textContent = '日线加载中，列表会逐只补上…';
      this.noteEl.hidden = false;
      return;
    }

    const missing = sorted.filter(r => !Number.isFinite(r.value)).length;
    const partial = sorted.filter(r => Number.isFinite(r.value) && meta.tradeDays > 1
      && r.days > 0 && r.days < meta.tradeDays).length;

    let note = isFlow
      ? '净流入＝主动买 − 主动卖，与列表页「今日净流入」同口径；窗口内逐日累加，不做去重或折算。'
        + '底部汇总卡只统计 ETF（15s 实时口径），本页含清单内全部标的，两者合计对不上是正常的'
      : '成交量为手数，条形按本窗口最大值线性归一。ETF 与个股量能常差数百倍，'
        + '差距过大时小值只保留 1px 可见宽度，精确比较看右侧数字与占比';

    if (partial) note += `。带 * 的标的本窗口只有部分交易日数据（停牌或新上市），数值偏小`;
    if (missing) note += `。${missing} 只取不到数据，已沉底显示 --`;

    this.noteEl.textContent = note;
    this.noteEl.hidden = false;
  }

  row(r, maxAbs, posSum) {
    const isFlow = this.mode === 'flow';
    const has = Number.isFinite(r.value);
    const series = Array.isArray(r.series) ? r.series : [];

    /* 值 */
    let text = '--';
    let cls = 'ns__val';
    if (has) {
      text = isFlow ? fmtSignedBig(r.value, 1) : `${fmtVolume(r.value, 1)}手`;
      if (isFlow) cls = 'ns__val ' + dirClass(r.value);
    }

    /* 条形 */
    let fill = null;
    let axis = null;
    if (has && r.value !== 0) {
      if (isFlow) {
        // 中轴向两侧生长：正负混排时，单向条只能比绝对值、看不出方向
        const pct = Math.min(50, (Math.abs(r.value) / maxAbs) * 50);
        axis = h('i.ns__axis');
        fill = h('i.ns__fill', {
          class: r.value > 0 ? 'ns__fill--up' : 'ns__fill--dn',
          style: r.value > 0
            ? { left: '50%', width: pct + '%' }
            : { right: '50%', width: pct + '%' },
        });
      } else {
        // 线性归一，只给 1px 硬下限保证「有数据」这件事可见。
        // 不做百分比下限：同一清单里 ETF 与个股的量能差两个数量级以上
        // （实测 5 日：创业板ETF 1.7 亿手 vs 茅台 18.8 万手，约 900 倍），
        // 用百分比抬高小值会让它看起来比真实更大的标的还长，反而看错顺序。
        const pct = Math.min(100, (r.value / maxAbs) * 100);
        fill = h('i.ns__fill.ns__fill--vol', {
          style: { width: `max(1px, ${pct.toFixed(3)}%)` },
        });
      }
    }

    /* 第二行说明 */
    let sub = '';
    if (!has) {
      sub = '无数据';
    } else if (isFlow) {
      const inN = series.filter(d => d.v > 0).length;
      const outN = series.filter(d => d.v < 0).length;
      sub = [inN ? `流入 ${inN} 天` : '', outN ? `流出 ${outN} 天` : '']
        .filter(Boolean).join(' · ') || '持平';
    } else {
      const share = posSum > 0 ? (r.value / posSum) * 100 : 0;
      // 0.04% 写成「0.0%」会让人以为真的是零，不如直接说小于 0.1%
      sub = share >= 0.1 ? `占清单 ${share.toFixed(1)}%` : '占清单 <0.1%';
    }

    const days = r.days || 0;
    const partial = has && days > 0 && r.wantDays > 1 && days < r.wantDays;

    return h('div.ns__row' + (has ? '' : '.is-empty'), { dataset: { id: r.id } }, [
      h('div.ns__l1', {}, [
        h('span.ns__name', { text: r.name || r.id }),
        r.kind === 'etf' ? h('span.ns__tag', { text: 'ETF' }) : null,
        h(`span`, {
          class: cls,
          text: has && partial ? text + '*' : text,
        }),
      ]),
      h('div.ns__track', {}, [axis, fill]),
      h('div.ns__l2', { text: sub }),
    ]);
  }

  destroy() {
    this.el.remove();
  }
}

/** '2026-10-22' → '10-22'，同一年内的窗口不需要年份 */
function short(d) {
  const s = String(d || '');
  return s.length >= 10 ? s.slice(5) : s;
}
