/** 应用入口 */

import { qs } from './util/dom.js';
import { initStore, applyTheme, getPrefs, setPref, subscribe } from './core/store.js';
import { createRouter } from './core/router.js';
import { Board } from './ui/board.js';
import { Indices } from './ui/indices.js';
import { Bonds } from './ui/bonds.js';
import { NTeam } from './ui/nteam.js';
import { Detail } from './ui/detail.js';
import { initSearch } from './ui/search.js';
import { initSettings } from './ui/settings.js';
import { createPullRefresh } from './ui/pullRefresh.js';
import { toast } from './ui/toast.js';
import { runSelfTest, showSelfTestPanel } from './dev/selftest.js';
import { GBK_SUPPORTED } from './data/http.js';

const pages = {
  board: qs('#page-board'),
  indices: qs('#page-indices'),
  bonds: qs('#page-bonds'),
  nteam: qs('#page-nteam'),
  search: qs('#page-search'),
  settings: qs('#page-settings'),
};

const TAB_NAMES = ['board', 'indices', 'bonds', 'nteam', 'search', 'settings'];

let currentTab = 'board';

const boot = () => {
  initStore();
  applyTheme();
  subscribe((type) => {
    if (type === 'prefs') { /* 由调用方处理 */ }
  });

  // ---------- 看板 ----------
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

  // ---------- 指数 ----------
  const indices = new Indices({
    listEl: qs('#indices-list'),
    statusEl: qs('#indices-status'),
    onOpen: id => router.go('/s/' + id),
  });

  // ---------- 国债 ----------
  const bonds = new Bonds({
    bodyEl: qs('#bonds-body'),
    statusEl: qs('#bonds-status'),
  });

  // ---------- 国家队 ----------
  const nteam = new NTeam({
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
  });

  // ---------- 详情 ----------
  const detail = new Detail({
    root: pages.detail || qs('#page-detail'),
    onBack: () => router.go('/' + currentTab),
  });

  // ---------- 搜索 ----------
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
      indices.repaint();
      bonds.repaint();
      detail.repaintTheme();
    },
  });

  // ---------- 路由 ----------
  const router = createRouter(route => {
    if (route.name === 'detail') {
      detail.open(route.id);
      return;
    }
    if (detail.active) detail.hide();
    switchTab(route.name);
  });

  const switchTab = name => {
    currentTab = name;
    setPref('lastTab', name);

    for (const [key, el] of Object.entries(pages)) {
      if (el) el.hidden = key !== name;
    }
    for (const btn of document.querySelectorAll('.tabbar__item')) {
      btn.classList.toggle('is-active', btn.dataset.tab === name);
    }

    if (name === 'board') board.start();
    else board.stop();

    if (name === 'indices') indices.start();
    else indices.stop();

    if (name === 'bonds') bonds.start();
    else bonds.stop();

    if (name === 'nteam') nteam.start();
    else nteam.stop();

    if (name === 'settings') settings.render();
    if (name === 'search') search.focus();
  };

  // ---------- tabbar ----------
  for (const btn of document.querySelectorAll('.tabbar__item')) {
    btn.addEventListener('click', () => router.go('/' + btn.dataset.tab));
  }

  // ---------- 空态按钮 ----------
  qs('#board-empty-btn')?.addEventListener('click', () => router.go('/search'));

  // ---------- 下拉刷新 ----------
  createPullRefresh({
    scroller: qs('#board-list'),
    indicator: qs('#pull-indicator'),
    onRefresh: () => board.refreshNow(),
  });
  createPullRefresh({
    scroller: qs('#indices-list'),
    indicator: qs('#indices-pull'),
    onRefresh: () => indices.refreshNow(),
  });
  createPullRefresh({
    scroller: qs('#bonds-body'),
    indicator: qs('#bonds-pull'),
    onRefresh: () => bonds.refreshNow(),
  });
  createPullRefresh({
    scroller: qs('#nteam-list'),
    indicator: qs('#nteam-pull'),
    onRefresh: () => nteam.refreshNow(),
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

  // ---------- 自检 ----------
  if (new URLSearchParams(location.search).get('debug') === '1') {
    setTimeout(async () => {
      toast('正在运行数据源自检…', 1200);
      const results = await runSelfTest();
      showSelfTestPanel(results);
    }, 600);
  }

  // ---------- PWA ----------
  registerSW();

  // 调试用
  window.__app = { board, indices, bonds, nteam, detail, router };
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
  }).catch(() => { /* 离线安装环境忽略 */ });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
