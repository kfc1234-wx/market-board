/**
 * 全 A 档位明细页
 *
 * 从「全 A 涨跌分布」点某个档位进来，看这一档里到底是哪些股票。
 * 版式与「好人好股」的区间明细页共用同一套 .hb（同一产品的同类页面不该有两种长相），
 * 差别只在数据量：全市场五千多只里，最大一档（0~3%）有两千多家，
 * 一次全塞进 DOM 就是近万个节点，手机上滑一下要掉帧。
 *
 * 所以分批渲染：先 120 行，底部哨兵进入视口再追加 120 行。
 * 用 IntersectionObserver 而不是 scroll 监听——省掉每帧算 scrollTop 的开销，
 * 而且手指快速滑动时它是自然连续的，不用用户去点「加载更多」。
 * 按钮仍然保留（观察器在少数旧浏览器 / 无障碍场景下不一定可靠），点它也追加。
 *
 * 数据（含档位归属）由调用方从 breadth.js 取好后传进来：
 * 这个组件不认识行情源，也不知道涨跌停怎么判，只负责把一批行画出来。
 *
 * 根节点多带一个 hb--all：body 里同时躺着「好人好股」那层面板（同款 .hb 版式），
 * 两个都是直接挂 body 的全屏层。共用样式是故意的，但查询/埋点需要能区分是谁，
 * 否则 document.querySelector('.hb') 拿到的是先建的那个。
 */

import { h, clear } from '../util/dom.js';
import { fmtPct, fmtPrice, fmtBig, dirClass } from '../util/format.js';

/** 每批追加行数：120 行约 480 个节点，一帧内追加完不卡 */
const PAGE = 120;

/** 6 位代码 → 详情页用的 id（北交所 4/8/920 开头走 bj） */
const idOf = code => (
  /^6/.test(code) ? 'sh' + code
    : /^(0|3)/.test(code) ? 'sz' + code
      : 'bj' + code
);

const clock = ts => {
  const d = new Date(ts || Date.now());
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
};

export class AllPanel {
  /** @param {{onOpen?: (id: string) => void}} [opt] */
  constructor(opt = {}) {
    this.onOpen = opt.onOpen || (() => {});

    /** @type {Array<object>} 当前档位的全量行（已按涨跌幅降序） */
    this.list = [];
    /** 已经画出来的行数 */
    this.shown = 0;
    this.bucket = null;

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

    this.el = h('div.hb.hb--all', { hidden: true }, [
      h('div.hb__bar', {}, [back, h('div.hb__titles', {}, [this.titleEl, this.subEl])]),
      this.bodyEl,
    ]);
    document.body.appendChild(this.el);

    // 追加哨兵：放在列表末尾，进入视口（含下方 320px 预读区）就再画一批
    this.moreEl = h('button.hb__more', { type: 'button' });
    this.moreEl.onclick = () => this.append();
    this.io = new IntersectionObserver(entries => {
      if (this.el.hidden) return;
      if (entries.some(e => e.isIntersecting)) this.append();
    }, { root: this.bodyEl, rootMargin: '320px 0px' });
    this.io.observe(this.moreEl);

    // 全屏层挂在 body 上，不归路由管：按系统返回键或改 hash 时要自己收起，
    // 否则会盖住目标页面，看起来像卡死（与 hao 的区间明细页同一处理）
    window.addEventListener('hashchange', () => {
      if (!this.el.hidden) this.hide();
    });
  }

  /**
   * @param {object} p
   * @param {string} p.label 档位名，如「涨停」「跌 0~3%」
   * @param {Array<object>} p.rows 该档全部个股（调用方已筛好）
   * @param {number} [p.at] 快照时间戳
   * @param {boolean} [p.partial] 抓取时有分片失败，名单可能缺几只
   * @param {boolean} [p.stale] 行情源挂了，用的是上一次的快照
   */
  show({ bucket, label, rows, at, partial, stale }) {
    this.bucket = bucket;
    // 排序留在这里而不是数据层：数据层的 rows 是共享快照，就地排序会污染
    // 下一次点别的档位看到的结果（sort 是原地操作，filter 出来的新数组也一样
    // 装着同一批行对象，但数组本身是新的是安全的）
    this.list = rows.slice().sort((a, b) => b.pct - a.pct);
    this.shown = 0;

    this.titleEl.textContent = label || '名单';

    const sumAmt = this.list.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const bits = [];
    if (this.list.length) bits.push(`${this.list.length} 只`, '涨跌幅降序');
    else bits.push('此区间暂无个股');
    if (sumAmt > 0) bits.push(`成交额 ${fmtBig(sumAmt)}`);
    bits.push(clock(at));
    if (stale) bits.push('旧数据');
    else if (partial) bits.push('部分缺失');
    this.subEl.textContent = bits.join(' · ');

    clear(this.bodyEl);
    this.el.hidden = false;
    this.bodyEl.scrollTop = 0;

    if (!this.list.length) {
      this.bodyEl.appendChild(h('div.hb__empty', {}, [
        h('p.hb__empty-title', { text: '这一档没有股票' }),
        h('p.hb__empty-sub', { text: '换一个档位看看，或返回查看其它分布' }),
      ]));
      return;
    }

    this.bodyEl.appendChild(this.moreEl);
    this.append();
  }

  hide() {
    this.el.hidden = true;
    this.bucket = null;
    this.list = [];
    this.shown = 0;
    clear(this.bodyEl);
  }

  /** 追加一批行 */
  append() {
    if (this.el.hidden || !this.list.length) return;
    if (this.shown >= this.list.length) return;

    const end = Math.min(this.shown + PAGE, this.list.length);
    // 用 fragment 一次性插入，避免 120 次 appendChild 触发 120 次布局
    const frag = document.createDocumentFragment();

    for (let i = this.shown; i < end; i++) {
      const r = this.list[i];
      const price = h('span.hb__price', { text: fmtPrice(r.price) });
      const pct = h('span.hb__pct', {
        text: fmtPct(r.pct),
        class: 'hb__pct ' + dirClass(r.pct),
      });

      const row = h('button.hb__row', { type: 'button', dataset: { id: idOf(r.code) } }, [
        h('span.hb__main', {}, [
          h('span.hb__name', { text: r.name }),
          h('span.hb__meta', {}, [h('span.hb__code', { text: r.code })]),
        ]),
        h('span.hb__right', {}, [price, pct]),
      ]);
      row.onclick = () => {
        // 进详情前先收起：详情层 z-index 低于这层，不收起会把详情压在下面
        this.hide();
        this.onOpen(idOf(r.code));
      };
      frag.appendChild(row);
    }

    this.shown = end;
    // 行插在哨兵之前：哨兵必须始终是最后一颗，否则观察器提前命中、一次全加载完
    this.bodyEl.insertBefore(frag, this.moreEl);

    const rest = this.list.length - this.shown;
    this.moreEl.hidden = rest <= 0;
    this.moreEl.textContent = rest > 0
      ? `加载更多（已显示 ${this.shown} / ${this.list.length}）`
      : '';
  }

  destroy() {
    this.io?.disconnect();
    this.el.remove();
  }
}
