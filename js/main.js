/**
 * 应用入口
 *
 * 页面模块按需加载：首屏只有看板是必需的，其余七个页面（含详情页与图表）
 * 第一次点进去才下载。实测首屏 600KB → 约 400KB，代价是切 tab 时多一次
 * 模块请求（本地 ~10ms，线上 gzip 后更小）。
 *
 * 两条约束写在这里，免得后来者踩：
 *  1. 懒加载之后 switchTab 是异步的。await 回来必须先确认 currentTab 还是
 *     原来那个，否则用户连点两个 tab 会让上一页的轮询在后台空转。
 *  2. 主题切换、__app 调试入口都要按「可能还没加载」来写，不能假定实例存在。
 */

import { qs } from './util/dom.js';
import { initStore, applyTheme, applySkin, getPrefs, setPref, subscribe, restoreDefaultItems } from './core/store.js';
import { createRouter } from './core/router.js';
import { Board } from './ui/board.js';
import { initSearch } from './ui/search.js';
import { initSettings } from './ui/settings.js';
import { createPullRefresh } from './ui/pullRefresh.js';
import { toast } from './ui/toast.js';
import { GBK_SUPPORTED } from './data/http.js';

const pages = {
  board: qs('#page-board'),
  indices: qs('#page-indices'),
  analysis: qs('#page-analysis'),
  bonds: qs('#page-bonds'),
  nteam: qs('#page-nteam'),
  hao: qs('#page-hao'),
  search: qs('#page-search'),
  settings: qs('#page-settings'),
};

const TAB_NAMES = ['board', 'indices', 'analysis', 'bonds', 'nteam', 'hao', 'search', 'settings'];

let currentTab = 'board';

/**
 * 底栏可横向滚动之后，选中的那一项要自动滑到中间，
 * 否则从路由切到靠后的页面时（比如设置），用户看不到选中态。
 * 用 offsetLeft 算而不是 scrollIntoView：后者会连带竖直方向一起滚。
 */
function revealTab(name) {
  const bar = document.querySelector('.tabbar');
  const btn = bar && bar.querySelector(`.tabbar__item[data-tab="${name}"]`);
  if (!bar || !btn) return;
  if (bar.scrollWidth <= bar.clientWidth + 1) return;   // 不用滚就别动
  const left = btn.offsetLeft - (bar.clientWidth - btn.offsetWidth) / 2;
  bar.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
}

/**
 * 底栏两端渐隐：按当前滚动位置决定哪一侧该淡出。
 * 到尽头的一侧收成 0px，否则明明滑到底了还把最后一项弄淡，反而像残缺。
 */
function syncTabFade() {
  const bar = document.querySelector('.tabbar');
  if (!bar) return;
  const max = bar.scrollWidth - bar.clientWidth;
  if (max <= 1) {
    bar.style.setProperty('--tab-fade-l', '0px');
    bar.style.setProperty('--tab-fade-r', '0px');
    return;
  }
  const x = bar.scrollLeft;
  bar.style.setProperty('--tab-fade-l', x > 4 ? '16px' : '0px');
  bar.style.setProperty('--tab-fade-r', x < max - 4 ? '20px' : '0px');
}

const boot = () => {
  initStore();
  applyTheme();
  applySkin();   // 首屏脚本已经设过一次，这里再对一次，顺带落盘老数据的迁移结果

  const tabbar = qs('#tabbar');
  if (tabbar) {
    tabbar.addEventListener('scroll', syncTabFade, { passive: true });
    window.addEventListener('resize', syncTabFade, { passive: true });
    syncTabFade();
  }
  subscribe((type) => {
    if (type === 'prefs') { /* 由调用方处理 */ }
  });

  // ---------- 看板（首屏唯一常驻模块） ----------
  const board = new Board({
    listEl: qs('#board-list'),
    emptyEl: qs('#board-empty'),
    statusEl: qs('#board-status'),
    sortBtn: qs('#board-sort'),
    sortLabel: qs('#board-sort-label'),
    editBtn: qs('#board-edit'),
    onOpen: id => router.go('/s/' + id),
    onAdd: () => router.go('/search'),
  });

  // ---------- 搜索（小、且要即时响应输入） ----------
  const search = initSearch({
    input: qs('#search-input'),
    body: qs('#search-body'),
    clearBtn: qs('#search-clear'),
    onAdded: id => {
      board.highlight(id);
      setTimeout(() => router.go('/board'), 320);
    },
    onView: id => router.go('/s/' + id),
  });

  // ---------- 设置 ----------
  const settings = initSettings({
    body: qs('#settings-body'),
    onThemeChange: () => {
      board.paint();
      // 未加载的页面没有可重绘的内容，加载时会用当前主题新建，不必管
      const d = registry.detail;
      if (d && d.active) d.repaintTheme();
      for (const name of ['indices', 'analysis', 'bonds']) {
        const inst = registry[name];
        if (!inst) continue;
        if (typeof inst.repaintTheme === 'function') inst.repaintTheme();
        else if (typeof inst.repaint === 'function') inst.repaint();
      }
    },
  });

  // ---------- 路由 ----------
  const router = createRouter(async route => {
    if (route.name === 'detail') {
      const d = await ensure('detail');
      if (d) d.open(route.id);
      return;
    }
    const d = registry.detail;
    if (d && d.active) d.hide();
    switchTab(route.name);
  }, TAB_NAMES);

  /** name → 已创建的实例 */
  const registry = Object.create(null);
  /** name → 正在进行的加载 Promise（并发进入同一页时只下载一次） */
  const pending = Object.create(null);

  /**
   * 每个懒加载页的加载方式与装配方式。
   * status 用来在加载期间保持「连接中」；pull 是 [滚动容器, 指示器]。
   */
  const lazyDefs = {
    indices: {
      load: () => import('./ui/indices.js').then(m => m.Indices),
      make: C => new C({
        listEl: qs('#indices-list'),
        statusEl: qs('#indices-status'),
        onOpen: id => router.go('/s/' + id),
      }),
      pull: ['#indices-list', '#indices-pull'],
    },
    analysis: {
      load: () => import('./ui/analysis.js').then(m => m.Analysis),
      make: C => new C({
        bodyEl: qs('#analysis-body'),
        statusEl: qs('#analysis-status'),
      }),
      pull: ['#analysis-body', '#analysis-pull'],
    },
    bonds: {
      load: () => import('./ui/bonds.js').then(m => m.Bonds),
      make: C => new C({
        bodyEl: qs('#bonds-body'),
        statusEl: qs('#bonds-status'),
      }),
      pull: ['#bonds-body', '#bonds-pull'],
    },
    nteam: {
      load: () => import('./ui/nteam.js').then(m => m.NTeam),
      make: C => new C({
        listEl: qs('#nteam-list'),
        summaryEl: qs('#nteam-sum'),
        volVal: qs('#nteam-vol'),
        volNote: qs('#nteam-volnote'),
        flowVal: qs('#nteam-flow'),
        flowNote: qs('#nteam-flownote'),
        statusEl: qs('#nteam-status'),
        editBtn: qs('#nteam-edit'),
        onOpen: id => router.go('/s/' + id),
        onAdd: () => router.go('/search'),
      }),
      pull: ['#nteam-list', '#nteam-pull'],
    },
    hao: {
      load: () => import('./ui/hao.js').then(m => m.Hao),
      make: C => new C({
        listEl: qs('#hao-list'),
        statusEl: qs('#hao-status'),
        onOpen: id => router.go('/s/' + id),
      }),
      pull: ['#hao-list', '#hao-pull'],
    },
    // 详情页连同 chart/kline.js、chart/trend.js 一共 67KB，只有点开个股才用得上
    detail: {
      load: () => import('./ui/detail.js').then(m => m.Detail),
      make: C => new C({
        root: qs('#page-detail'),
        onBack: () => router.go('/' + currentTab),
      }),
    },
  };

  function ensure(name) {
    if (registry[name]) return Promise.resolve(registry[name]);
    if (pending[name]) return pending[name];
    const def = lazyDefs[name];
    if (!def) return Promise.resolve(null);

    pending[name] = def.load()
      .then(C => def.make(C))
      .then(inst => {
        registry[name] = inst;
        delete pending[name];
        if (def.pull) {
          createPullRefresh({
            scroller: qs(def.pull[0]),
            indicator: qs(def.pull[1]),
            onRefresh: () => inst.refreshNow(),
          });
        }
        return inst;
      })
      .catch(err => {
        // 不缓存失败，下次进这个 tab 会重试
        delete pending[name];
        throw err;
      });
    return pending[name];
  }

  const switchTab = async name => {
    currentTab = name;
    setPref('lastTab', name);

    for (const [key, el] of Object.entries(pages)) {
      if (el) el.hidden = key !== name;
    }
    for (const btn of document.querySelectorAll('.tabbar__item')) {
      btn.classList.toggle('is-active', btn.dataset.tab === name);
    }
    revealTab(name);

    // 先把所有在跑的页面停掉，再启动当前页：
    // 懒加载是异步的，不等它回来就启下一页，会出现两页同时轮询。
    board.stop();
    for (const key of Object.keys(registry)) {
      const inst = registry[key];
      if (inst && typeof inst.stop === 'function') inst.stop();
    }

    if (name === 'settings') { settings.render(); return; }
    if (name === 'search') { search.focus(); return; }
    if (name === 'board') { board.start(); return; }

    let inst;
    try {
      inst = await ensure(name);
    } catch {
      toast('页面加载失败，检查网络后再点一次', 2400);
      return;
    }
    // 等模块这段时间里用户可能已经切走，别把上一页启动起来
    if (currentTab !== name) return;
    if (inst && typeof inst.start === 'function') inst.start();
  };

  // ---------- tabbar ----------
  for (const btn of document.querySelectorAll('.tabbar__item')) {
    btn.addEventListener('click', () => router.go('/' + btn.dataset.tab));
  }

  // ---------- 空态按钮 ----------
  qs('#board-empty-btn')?.addEventListener('click', () => router.go('/search'));
  qs('#board-empty-restore')?.addEventListener('click', () => {
    const n = restoreDefaultItems();
    toast(n ? `已恢复默认清单（${n} 个）` : '默认清单已在列表里');
  });

  // ---------- 下拉刷新（看板常驻，其余在 ensure 里绑定） ----------
  createPullRefresh({
    scroller: qs('#board-list'),
    indicator: qs('#pull-indicator'),
    onRefresh: () => board.refreshNow(),
  });

  // ---------- 排序按钮初始文案 ----------
  const sortText = { pctDesc: '涨跌幅', chgDesc: '涨跌额', flowDesc: '净流入', nameAsc: '名称' };
  const label = qs('#board-sort-label');
  if (label) label.textContent = sortText[getPrefs().sort] || '排序';

  // ---------- 启动 ----------
  const initial = (location.hash || '').replace(/^#\/?/, '');
  const first = TAB_NAMES.includes(initial) ? initial : (getPrefs().lastTab || 'board');
  if (!location.hash) {
    history.replaceState(null, '', '#' + first);
  }
  switchTab(TAB_NAMES.includes(initial) ? initial : (TAB_NAMES.includes(first) ? first : 'board'));
  router.start();
  // 注意：不再额外 board.start()——switchTab 已经按当前页决定启停了，
  // 无条件再启一次会让看板在其它页面后台空转轮询。

  // ---------- 环境提示 ----------
  if (!GBK_SUPPORTED) {
    toast('当前浏览器不支持 GBK 解码，行情可能显示异常', 3000);
  }

  // ---------- 自检（只在 ?debug=1 时加载，省掉 8KB + 它拖的 39KB 代码表） ----------
  if (new URLSearchParams(location.search).get('debug') === '1') {
    setTimeout(async () => {
      toast('正在运行数据源自检…', 1200);
      const m = await import('./dev/selftest.js');
      const results = await m.runSelfTest();
      m.showSelfTestPanel(results);
    }, 600);
  }

  // ---------- PWA ----------
  registerSW();

  /**
   * 调试入口。
   * 懒加载之后页面实例可能是 undefined，用 getter 让原有写法
   * （__app.analysis.data 之类）在页面已打开时照旧可用。
   */
  window.__app = {
    board, search, settings, router,
    get indices() { return registry.indices; },
    get analysis() { return registry.analysis; },
    get bonds() { return registry.bonds; },
    get nteam() { return registry.nteam; },
    get hao() { return registry.hao; },
    get detail() { return registry.detail; },
  };
};

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;

  // 本地开发默认不注册 SW（否则改了代码却一直拿到缓存旧文件）；
  // 想在本机验证 PWA 行为时加 ?sw=1
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const forceSW = new URLSearchParams(location.search).get('sw') === '1';
  if (isLocal && !forceSW) return;

  navigator.serviceWorker.register('sw.js').then(reg => {
    const bar = qs('#update-bar');
    const btn = qs('#update-btn');

    const prompt = worker => {
      if (!bar) return;
      bar.hidden = false;
      btn.onclick = () => {
        worker.postMessage('SKIP_WAITING');
        bar.hidden = true;
      };
    };

    if (reg.waiting) prompt(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) prompt(sw);
      });
    });

    let refreshed = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshed) return;
      refreshed = true;
      location.reload();
    });

    // 装到桌面的 PWA 不会「关掉再开」，可能几十天都不做一次导航，
    // 浏览器的自动更新检查也就一直不触发。这里主动补两刀：
    // 回到前台时查一次，长时间挂着时每 10 分钟查一次（都限流到 60s 一次）。
    let lastCheck = 0;
    const checkUpdate = () => {
      const now = Date.now();
      if (now - lastCheck < 60_000) return;
      lastCheck = now;
      reg.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkUpdate();
    });
    setInterval(checkUpdate, 10 * 60_000);
    checkUpdate();
  }).catch(() => { /* 离线安装环境忽略 */ });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
