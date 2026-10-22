/**
 * 好人好股页
 *
 * 结构照搬国家队页的「全 A 涨跌分布」，但统计对象换成本地名单里的 80 只票：
 * 顶部涨/平/跌比例带 + 五对左右对称档位（绿左红右）。
 * 差别是每一档都能点——点进去是该档位内的名单明细，这是「全 A 分布」做不到的，
 * 因为那 5000 多只票没有一份可跳转的清单。
 *
 * 涨跌停口径：名单全为主板，涨跌幅限制 ±10%，故 |pct| ≥ 9.8% 判为涨/跌停。
 * 不做「精确到分」的封板价推算——那要用昨收价和板块涨跌幅限制重算，
 * 名单里将来若混入 ST（±5%）或创业板（±20%）就会全错，宁可粗一点。
 */

import { h, clear } from '../util/dom.js';
import { fmtPct, fmtPrice, fmtBig, dirClass } from '../util/format.js';
import { getQuotes, invalidate } from '../data/quotes.js';
import { getDividends } from '../data/dividend.js';
import { HAO_LIST } from '../data/hao.js';

/** 报价 15s 一轮；80 只分两批请求，一轮约 2.6s */
const REFRESH_MS = 15 * 1000;

/** 股息率取数失败后的冷却：别让 15s 轮询把同一个坏请求打成死循环 */
const DIV_RETRY_MS = 60 * 1000;

/** 五对档位：与国家队页「全 A 涨跌分布」同一版式，方便左右对照 */
const PAIRS = [
  { dn: ['dt', '跌停'], up: ['zt', '涨停'] },
  { dn: ['dn7', '<-7%'], up: ['up7', '>7%'] },
  { dn: ['dn57', '5~7%'], up: ['up57', '5~7%'] },
  { dn: ['dn35', '3~5%'], up: ['up35', '3~5%'] },
  { dn: ['dn03', '0~3%'], up: ['up03', '0~3%'] },
];

const LABEL = {
  zt: '涨停', up7: '涨 >7%', up57: '涨 5~7%', up35: '涨 3~5%', up03: '涨 0~3%',
  dt: '跌停', dn7: '跌 <-7%', dn57: '跌 5~7%', dn35: '跌 3~5%', dn03: '跌 0~3%',
  flat: '平盘', up: '全部上涨', down: '全部下跌', all: '全部名单',
};

/** 涨跌幅 → 档位 key，边界与 PAIRS 的标签严格一致 */
export function bucketOf(p) {
  if (!Number.isFinite(p)) return null;
  if (p >= 9.8) return 'zt';
  if (p > 7) return 'up7';
  if (p > 5) return 'up57';
  if (p > 3) return 'up35';
  if (p > 0) return 'up03';
  if (p === 0) return 'flat';
  if (p > -3) return 'dn03';
  if (p > -5) return 'dn35';
  if (p > -7) return 'dn57';
  if (p > -9.8) return 'dn7';
  return 'dt';
}

function matchBucket(r, key) {
  if (!r || !r.ok) return false;
  if (key === 'all') return true;
  if (key === 'up') return r.pct > 0;
  if (key === 'down') return r.pct < 0;
  if (key === 'flat') return r.pct === 0;
  return bucketOf(r.pct) === key;
}

const clock = ts => {
  const d = new Date(ts || Date.now());
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
};

export class Hao {
  constructor({ listEl, statusEl, onOpen }) {
    this.listEl = listEl;
    this.statusEl = statusEl;
    this.onOpen = onOpen;

    /** @type {Array<{id:string,code:string,name:string,price:number,pct:number,ok:boolean}>} */
    this.rows = [];
    this.at = 0;
    this.active = false;
    this.loading = false;
    this.timer = 0;

    this.panel = new BucketPanel({ onOpen });

    this.onVisible = () => {
      if (!this.active || document.hidden) return;
      if (Date.now() - this.at > REFRESH_MS) this.load();
    };
    document.addEventListener('visibilitychange', this.onVisible);

    this.build();
  }

  /* ---------------- 结构 ---------------- */

  build() {
    if (!this.listEl) return;
    clear(this.listEl);

    // ---- 概览卡 ----
    this.medianEl = h('strong.hs__median-v', { text: '--' });
    this.avgEl = h('span.hs__avg', { text: '平均 --' });
    this.timeEl = h('span.hs__time', { text: '统计中' });
    this.countEl = h('span.hs__count', { text: '' });

    this.segUp = this.makeSeg('up', 'hs__seg--up');
    this.segFlat = this.makeSeg('flat', 'hs__seg--flat');
    this.segDown = this.makeSeg('down', 'hs__seg--dn');
    this.lgUp = h('button.hs__lg.hs__lg--up', { type: 'button', text: '上涨 --' });
    this.lgFlat = h('button.hs__lg.hs__lg--flat', { type: 'button', text: '平 --' });
    this.lgDown = h('button.hs__lg.hs__lg--dn', { type: 'button', text: '下跌 --' });
    this.lgUp.onclick = () => this.openBucket('up');
    this.lgFlat.onclick = () => this.openBucket('flat');
    this.lgDown.onclick = () => this.openBucket('down');

    this.listEl.appendChild(h('section.hs', {}, [
      h('header.hs__head', {}, [
        h('h2.hs__title', {}, [
          h('span', { text: '好人好股' }),
          this.countEl,
        ]),
        this.timeEl,
      ]),
      h('div.hs__main', {}, [
        h('div.hs__median', {}, [
          h('span.hs__k', { text: '中位涨跌幅' }),
          this.medianEl,
        ]),
        this.avgEl,
      ]),
      h('div.hs__split', {}, [this.segUp, this.segFlat, this.segDown]),
      h('div.hs__legend', {}, [this.lgUp, this.lgFlat, this.lgDown]),
    ]));

    // ---- 分布卡 ----
    const allBtn = h('button.hdist__all', {
      type: 'button',
      text: `查看全部 ${HAO_LIST.length} 只名单`,
      onclick: () => this.openBucket('all'),
    });

    this.listEl.appendChild(h('section.hdist', {}, [
      h('header.hdist__head', {}, [
        h('h2.hdist__title', { text: '涨跌分布' }),
        h('span.hdist__hint', { text: '点档位看名单' }),
      ]),
      this.buildRows(),
      allBtn,
    ]));

    // ---- 两极速览：只放 3+3，够看今天名单里谁最强/最弱；
    //      想看完整的走「查看全部名单」，不必在首页滚 80 行
    this.pickLead = h('div.hpick__col');
    this.pickLag = h('div.hpick__col');
    this.listEl.appendChild(h('section.hpick', {}, [
      h('header.hpick__head', {}, [
        h('h2.hpick__title', { text: '名单速览' }),
        h('span.hpick__hint', { text: '按涨跌幅' }),
      ]),
      h('div.hpick__cols', {}, [
        h('div.hpick__side', {}, [
          h('span.hpick__k.hpick__k--up', { text: '领涨' }),
          this.pickLead,
        ]),
        h('div.hpick__side', {}, [
          h('span.hpick__k.hpick__k--dn', { text: '领跌' }),
          this.pickLag,
        ]),
      ]),
    ]));

    this.noteEl = h('p.hs__note', {
      text: '名单来自本地表格（A股主板国资科技成长，2026Q3），去重后 '
        + `${HAO_LIST.length} 只。涨跌停按主板 ±10% 口径，|涨跌幅| ≥ 9.8% 计入。`,
    });
    this.listEl.appendChild(this.noteEl);
  }

  makeSeg(key, cls) {
    const btn = h(`button.hs__seg.${cls}`, {
      type: 'button',
      dataset: { b: key },
      'aria-label': LABEL[key],
    });
    btn.onclick = () => this.openBucket(key);
    return btn;
  }

  /** 五对档位：半区各自是一个按钮，点左右半边进的是不同档位 */
  buildRows() {
    const box = h('div.hdist__rows-body');
    this.cells = [];

    for (const pair of PAIRS) {
      const dnBar = h('i.hdist__bar.hdist__bar--dn');
      const upBar = h('i.hdist__bar.hdist__bar--up');
      const dnNum = h('span.hdist__num.hdist__num--dn', { text: '–' });
      const upNum = h('span.hdist__num.hdist__num--up', { text: '–' });

      const dnHalf = h('button.hdist__half.hdist__half--dn', {
        type: 'button',
        dataset: { b: pair.dn[0] },
      }, [
        dnNum,
        h('span.hdist__track.hdist__track--l', {}, [dnBar]),
        h('span.hdist__label', { text: pair.dn[1] }),
      ]);
      dnHalf.onclick = () => this.openBucket(pair.dn[0]);

      const upHalf = h('button.hdist__half.hdist__half--up', {
        type: 'button',
        dataset: { b: pair.up[0] },
      }, [
        h('span.hdist__label', { text: pair.up[1] }),
        h('span.hdist__track.hdist__track--r', {}, [upBar]),
        upNum,
      ]);
      upHalf.onclick = () => this.openBucket(pair.up[0]);

      box.appendChild(h('div.hdist__row', {}, [dnHalf, upHalf]));
      this.cells.push({ pair, dnBar, upBar, dnNum, upNum, dnHalf, upHalf });
    }
    return box;
  }

  /* ---------------- 数据 ---------------- */

  async load(force = false) {
    if (this.loading) return;
    this.loading = true;
    try {
      const ids = HAO_LIST.map(x => x.id);
      const map = await getQuotes(ids, force ? { maxAge: 0 } : undefined);

      this.rows = HAO_LIST.map(item => {
        const q = map.get(item.id);
        const ok = !!q && q.valid && !q.suspended;
        return {
          id: item.id,
          code: item.code,
          name: (q && q.name) || item.name,
          price: ok ? q.price : NaN,
          pct: ok ? q.pct : NaN,
          chg: ok ? q.change : NaN,
          amount: ok ? q.amount : 0,
          ok,
        };
      });
      this.at = Date.now();
      this.paint();
      this.panel.refresh(this.rows);
    } catch {
      if (!this.rows.length) this.setStatus('行情暂时取不到');
    } finally {
      this.loading = false;
    }
  }

  /* ---------------- 绘制 ---------------- */

  paint() {
    const rows = this.rows;
    const valid = rows.filter(r => r.ok);
    const total = HAO_LIST.length;

    this.countEl.textContent = `${total} 只`;

    if (!valid.length) {
      this.setStatus(this.at ? '行情暂时取不到' : '加载中…');
      return;
    }

    const up = valid.filter(r => r.pct > 0);
    const down = valid.filter(r => r.pct < 0);
    const flat = valid.filter(r => r.pct === 0);

    const pcts = valid.map(r => r.pct).sort((a, b) => a - b);
    const mid = pcts.length % 2
      ? pcts[(pcts.length - 1) / 2]
      : (pcts[pcts.length / 2 - 1] + pcts[pcts.length / 2]) / 2;
    const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;

    this.medianEl.textContent = fmtPct(mid);
    this.medianEl.className = 'hs__median-v ' + dirClass(mid);
    this.avgEl.textContent = `平均 ${fmtPct(avg)}`;
    this.timeEl.textContent = `${clock(this.at)}` + (valid.length < total ? ` · 缺 ${total - valid.length}` : '');
    this.setStatus(`${valid.length}/${total} 只有效 · ${clock(this.at)}`);

    // 比例带：零家数按 0 处理，避免留一条缝
    const segs = [[this.segUp, up.length], [this.segFlat, flat.length], [this.segDown, down.length]];
    for (const [el, n] of segs) {
      el.style.flex = n > 0 ? `${n} 1 0` : '0 0 0';
      el.hidden = n <= 0;
    }

    const share = n => valid.length ? (n / valid.length * 100).toFixed(0) : '0';
    this.lgUp.textContent = `上涨 ${up.length} · ${share(up.length)}%`;
    this.lgFlat.textContent = `平 ${flat.length}`;
    this.lgDown.textContent = `下跌 ${down.length} · ${share(down.length)}%`;

    // 档位家数
    const counts = {
      zt: 0, up7: 0, up57: 0, up35: 0, up03: 0,
      dt: 0, dn7: 0, dn57: 0, dn35: 0, dn03: 0,
    };
    for (const r of valid) {
      const k = bucketOf(r.pct);
      if (k && counts[k] !== undefined) counts[k] += 1;
    }

    // 条宽：80 只的档位差距不像全 A 那样跨数量级，但 0~3% 常是几十只、
    // 涨跌停只有 1~2 只，仍用开方压缩 + 4px 保底，让小档位看得见
    const max = Math.max(...Object.values(counts), 1);
    const width = n => n <= 0 ? '0' : `${Math.min(100, Math.max(4, Math.sqrt(n / max) * 100))}%`;

    // 两极：整体降序后取头尾，领跌那栏再翻一次让最惨的排最前
    const sorted = valid.slice().sort((a, b) => b.pct - a.pct);
    this.fillPicks(this.pickLead, sorted.slice(0, 3));
    this.fillPicks(this.pickLag, sorted.slice(-3).reverse());

    for (const c of this.cells) {
      const dn = counts[c.pair.dn[0]] || 0;
      const upN = counts[c.pair.up[0]] || 0;
      c.dnNum.textContent = dn;
      c.upNum.textContent = upN;
      c.dnBar.style.width = width(dn);
      c.upBar.style.width = width(upN);
      c.dnBar.hidden = dn <= 0;
      c.upBar.hidden = upN <= 0;
      // 空档位置灰：点进去只有空列表，不如直接告诉用户这里没人
      c.dnHalf.classList.toggle('is-empty', dn <= 0);
      c.upHalf.classList.toggle('is-empty', upN <= 0);
    }
  }

  fillPicks(box, list) {
    if (!box) return;
    clear(box);
    if (!list.length) {
      box.appendChild(h('span.hpick__empty', { text: '--' }));
      return;
    }
    for (const r of list) {
      const row = h('button.hpick__row', { type: 'button' }, [
        h('span.hpick__name', { text: r.name }),
        h('span.hpick__pct', { text: fmtPct(r.pct), class: 'hpick__pct ' + dirClass(r.pct) }),
      ]);
      row.onclick = () => this.onOpen?.(r.id);
      box.appendChild(row);
    }
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  openBucket(key) {
    const list = this.rows.filter(r => matchBucket(r, key));
    this.panel.show(key, list, this.rows);
  }

  /* ---------------- 生命周期 ---------------- */

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
      if (!document.hidden) await this.load();
      this.schedule();
    }, REFRESH_MS);
  }

  refreshNow() {
    invalidate();
    return this.load(true);
  }

  destroy() {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisible);
    this.panel.destroy();
  }
}

/* ==================== 区间明细页 ==================== */

/**
 * 全屏二级页：展示某一档位内的名单
 *
 * 为什么不用页面内的展开区：一档可能有三十多只，展开会把分布卡挤到屏幕外，
 * 用户看完还得往上滚回去换一档。独立页 + 返回，换档位只要退回再点。
 *
 * 股息率：名单里混着高股息（银行、运营商）和不分红（成长股），
 * 单看涨跌幅看不出这层差别，所以在行内补一条「股息率 x.xx%」。
 * 数据是日频的，一次批量取整档、缓存 1 小时；取不到的（不分红）标「未分红」，
 * 免得和「还没加载出来」的「--」混淆。
 */
class BucketPanel {
  constructor({ onOpen }) {
    this.onOpen = onOpen;
    this.bucket = null;
    this.rows = [];

    /** @type {Map<string, {dps:number,count:number,date:string}|null>} 股息快照；null=近 12 个月未分红 */
    this.div = new Map();
    /** @type {Map<string, number>} id → 上次请求时间，失败后冷却期内不重试 */
    this.tried = new Map();
    /** @type {Map<string, {el:HTMLElement, r:object}>} 本次渲染出来的股息节点 */
    this.divEls = new Map();

    this.titleEl = h('div.hb__title', { text: '' });
    this.subEl = h('div.hb__sub', { text: '' });
    this.bodyEl = h('div.hb__body');

    const back = h('button.hb__back', {
      type: 'button',
      'aria-label': '返回',
      html: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">'
        + '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" '
        + 'stroke-linecap="round" stroke-linejoin="round"/></svg>',
      onclick: () => this.hide(),
    });

    this.el = h('div.hb', { hidden: true }, [
      h('div.hb__bar', {}, [back, h('div.hb__titles', {}, [this.titleEl, this.subEl])]),
      this.bodyEl,
    ]);
    document.body.appendChild(this.el);
  }

  show(key, list, all) {
    this.bucket = key;
    this.rows = all || list;
    this.el.hidden = false;
    this.render();
  }

  hide() {
    this.el.hidden = true;
    this.bucket = null;
  }

  refresh(all) {
    this.rows = all;
    if (!this.el.hidden) this.render();
  }

  render() {
    const key = this.bucket;
    if (!key) return;

    const list = this.rows
      .filter(r => matchBucket(r, key))
      .sort((a, b) => b.pct - a.pct);

    const title = LABEL[key] || '名单';
    this.titleEl.textContent = title;

    const sumAmt = list.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    this.subEl.textContent = list.length
      ? `${list.length} 只 · 涨跌幅降序` + (sumAmt > 0 ? ` · 成交额 ${fmtBig(sumAmt)}` : '')
      : '此区间暂无个股';

    clear(this.bodyEl);
    this.divEls = new Map();

    if (!list.length) {
      this.bodyEl.appendChild(h('div.hb__empty', {}, [
        h('p.hb__empty-title', { text: '这一档没有名单内的股票' }),
        h('p.hb__empty-sub', { text: '换一个区间看看，或返回查看全部名单' }),
      ]));
      return;
    }

    for (const r of list) {
      const price = h('span.hb__price', { text: fmtPrice(r.price) });
      const pct = h('span.hb__pct', {
        text: fmtPct(r.pct),
        class: 'hb__pct ' + dirClass(r.pct),
      });

      // 先放占位，取到后由 paintDividends 就地改写，不重建行
      const divEl = h('span.hb__div', { text: '股息率 --' });
      this.divEls.set(r.id, { el: divEl, r });

      const row = h('button.hb__row', { type: 'button', dataset: { id: r.id } }, [
        h('span.hb__main', {}, [
          h('span.hb__name', { text: r.name }),
          h('span.hb__meta', {}, [
            h('span.hb__code', { text: r.code }),
            divEl,
          ]),
        ]),
        h('span.hb__right', {}, [price, pct]),
      ]);
      row.onclick = () => {
        // 进详情前先收起：详情页的 z-index 低于这层，不收起会把详情压在下面
        this.hide();
        this.onOpen?.(r.id);
      };
      this.bodyEl.appendChild(row);
    }

    this.paintDividends();
    this.ensureDividends(list);
  }

  /** 把已知的股息结果刷到行上；未知的保持「--」占位 */
  paintDividends() {
    for (const { el, r } of this.divEls.values()) {
      const v = this.div.get(r.id);
      if (v === undefined) continue;

      if (v === null) {
        el.textContent = '未分红';
        el.className = 'hb__div is-off';
        continue;
      }

      // 股息本身一小时才变，价格 15s 就变，收益率必须用当前价现算，
      // 不能直接搬缓存里那份（那是上次取数时的价）
      const y = Number.isFinite(r.price) && r.price > 0
        ? +((v.dps / r.price) * 100).toFixed(2)
        : v.yield;

      if (y == null) {
        // 停牌 / 无报价时退化成每股派现，总比一个 -- 有信息量
        el.textContent = `每股派现 ${v.dps.toFixed(2)} 元`;
        el.className = 'hb__div';
      } else {
        el.textContent = `股息率 ${y.toFixed(2)}%`;
        el.className = 'hb__div is-on';
      }
    }
  }

  async ensureDividends(list) {
    const now = Date.now();
    const todo = list.filter(r =>
      !this.div.has(r.id) && !(now - (this.tried.get(r.id) || 0) < DIV_RETRY_MS));
    if (!todo.length) return;

    // 先记账再发请求：15s 轮询会重进 render，没有这道闸门就会重复打同一批
    for (const r of todo) this.tried.set(r.id, now);

    const prices = {};
    for (const r of list) {
      if (Number.isFinite(r.price) && r.price > 0) prices[r.id] = r.price;
    }

    const map = await getDividends(todo.map(r => r.id), { prices });
    // 按 id 写进缓存：即使这期间换过档位、行已重建，数据也不会串
    for (const [id, v] of map) this.div.set(id, v);
    if (!this.el.hidden) this.paintDividends();
  }

  destroy() {
    this.el.remove();
  }
}
