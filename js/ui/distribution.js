/**
 * 全 A 涨跌分布卡片（国家队页底部）
 *
 * 版式对齐通达信「涨跌家数分布」：
 *   顶部一条涨/平/跌比例带，下面 5 行左右对称的档位（左跌右涨，绿左红右），
 *   条长按家数线性映射，最小 3px 保证极端小档位也能看见。
 *
 * 头部单独给「中位涨跌幅」——这正是通达信 880009（全 A 中位指数）的单日口径，
 * 看它比看上证更能反映手里股票的真实冷暖。
 */

import { h, clear } from '../util/dom.js';

/** 快照时间，精确到秒——30 秒一轮，只到分钟看不出在动 */
const clock = ts => {
  const d = new Date(ts || Date.now());
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
};
import { fmtPct, dirClass } from '../util/format.js';

/**
 * 按需加载：breadth.js 会连带拉进 40KB 的静态代码表（pool-a.js），
 * 而只有进国家队页才用得上，没必要让首屏跟着一起下载。
 */
let breadthMod = null;
async function loadBreadth(force) {
  if (!breadthMod) breadthMod = await import('../data/breadth.js');
  return breadthMod.getBreadth(force ? { force: true } : undefined);
}

/** 左右配对：左侧=跌（绿），右侧=涨（红），从上到下由极端到温和 */
const PAIRS = [
  { dn: ['dt', '跌停'], up: ['zt', '涨停'] },
  { dn: ['dn7', '<-7%'], up: ['up7', '>7%'] },
  { dn: ['dn57', '5~7%'], up: ['up57', '5~7%'] },
  { dn: ['dn35', '3~5%'], up: ['up35', '3~5%'] },
  { dn: ['dn03', '0~3%'], up: ['up03', '0~3%'] },
];

/** 盘中 30 秒一轮（跟国家队报价的 15s 节奏错开）；收盘后靠 breadth 的 TTL 空转 */
const REFRESH_MS = 30 * 1000;

export class Distribution {
  /** @param {HTMLElement} el 挂载点 */
  constructor(el) {
    this.el = el;
    this.data = null;
    this.timer = 0;
    this.active = false;
    this.building = false;

    this.build();
  }

  build() {
    clear(this.el);

    this.barUp = h('i.dist__seg.dist__seg--up');
    this.barFlat = h('i.dist__seg.dist__seg--flat');
    this.barDown = h('i.dist__seg.dist__seg--dn');

    this.medianEl = h('strong.dist__median-v', { text: '--' });
    this.metaEl = h('span.dist__meta', { text: '统计中' });
    this.legendEl = h('div.dist__legend');

    this.rowsEl = h('div.dist__rows');

    this.card = h('section.dist', {}, [
      h('header.dist__head', {}, [
        h('h2.dist__title', { text: '全 A 涨跌分布' }),
        this.metaEl,
      ]),
      h('div.dist__median', {}, [
        h('span.dist__median-k', { text: '中位涨跌幅' }),
        this.medianEl,
        h('span.dist__median-tag', { text: '= 880009 单日口径' }),
      ]),
      h('div.dist__split', {}, [this.barUp, this.barFlat, this.barDown]),
      this.legendEl,
      this.rowsEl,
    ]);

    this.el.appendChild(this.card);
    this.buildRows();
  }

  /** 行骨架只建一次，后续只改数字和条宽 */
  buildRows() {
    this.cells = [];
    for (const pair of PAIRS) {
      const dnBar = h('i.dist__bar.dist__bar--dn');
      const upBar = h('i.dist__bar.dist__bar--up');
      const dnNum = h('span.dist__num.dist__num--dn', { text: '–' });
      const upNum = h('span.dist__num.dist__num--up', { text: '–' });

      this.rowsEl.appendChild(h('div.dist__row', {}, [
        dnNum, h('span.dist__track.dist__track--l', {}, [dnBar]), h('span.dist__label', { text: pair.dn[1] }),
        h('span.dist__label.dist__label--r', { text: pair.up[1] }), h('span.dist__track.dist__track--r', {}, [upBar]), upNum,
      ]));

      this.cells.push({ pair, dnBar, upBar, dnNum, upNum });
    }
  }

  paint() {
    const d = this.data;
    if (!d) return;

    const b = d.buckets;
    this.metaEl.textContent = `${d.total} 只 · ${clock(d.at)}` + (d.stale ? ' · 旧数据' : '');

    this.medianEl.textContent = fmtPct(d.median);
    this.medianEl.className = 'dist__median-v ' + dirClass(d.median);

    // 顶部分布带：按涨/平/跌的实际家数分 flex，零家数直接隐藏避免留缝
    const segs = [[this.barUp, d.up], [this.barFlat, d.flat], [this.barDown, d.down]];
    for (const [el, n] of segs) {
      el.style.flex = n > 0 ? `${n} 1 0` : '0 0 0';
      el.hidden = n <= 0;
    }

    clear(this.legendEl);
    const pct = n => d.total ? (n / d.total * 100) : 0;
    this.legendEl.appendChild(h('span.dist__lg.dist__lg--up', { text: `上涨 ${d.up} · ${pct(d.up).toFixed(0)}%` }));
    this.legendEl.appendChild(h('span.dist__lg.dist__lg--flat', { text: `平 ${d.flat}` }));
    this.legendEl.appendChild(h('span.dist__lg.dist__lg--dn', { text: `下跌 ${d.down} · ${pct(d.down).toFixed(0)}%` }));

    // 条宽：家数差距是数量级的（0~3% 有两千多家，涨跌停只有几十家），
    // 线性映射会把两端小档位压成一条缝，改用开方压缩，最小 4px 保底。
    const max = Math.max(b.up03, b.dn03, b.up35, b.dn35, b.up57, b.dn57, b.up7, b.dn7, b.zt, b.dt, 1);
    const width = n => n <= 0 ? '0' : `${Math.min(100, Math.max(4, Math.sqrt(n / max) * 100))}%`;

    for (const c of this.cells) {
      const dn = b[c.pair.dn[0]] ?? 0;
      const up = b[c.pair.up[0]] ?? 0;
      c.dnNum.textContent = dn;
      c.upNum.textContent = up;
      c.dnBar.style.width = width(dn);
      c.upBar.style.width = width(up);
      c.dnBar.hidden = dn <= 0;
      c.upBar.hidden = up <= 0;
    }
  }

  async load(force = false) {
    if (this.building) return;
    this.building = true;
    try {
      const d = await loadBreadth(force);
      this.data = d;
      this.paint();
    } catch {
      if (!this.data) {
        this.metaEl.textContent = '暂时取不到';
      }
    } finally {
      this.building = false;
    }
  }

  start() {
    this.active = true;
    this.load();
    this.schedule();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (!this.active) return;
      // 页面在前台才刷，切后台不白烧流量
      if (!document.hidden) await this.load();
      this.schedule();
    }, REFRESH_MS);
  }

  /** 回到前台时补一次 */
  resume() {
    if (this.active && !document.hidden) this.load();
  }
}
