/**
 * Service Worker
 *
 * 策略：
 *  - 静态资源：precache + stale-while-revalidate（先给缓存，后台静默更新）
 *  - 行情 / 资金流接口：一律 network-only，绝不进缓存（时效性 > 离线可用）
 *  - 导航请求：network-first，失败回退 shell（离线也能打开壳）
 *
 * 注意：部署时必须给 sw.js 和 manifest.webmanifest 设置 Cache-Control: no-cache，
 * 否则 CDN 长缓存会导致用户永远拿不到新版本。
 */

const VERSION = 'v1.20.0';
const SHELL = 'shell-' + VERSION;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/base.css',
  './css/pages.css',
  './js/main.js',
  './js/core/router.js',
  './js/core/store.js',
  './js/core/poller.js',
  './js/core/bus.js',
  './js/data/symbols.js',
  './js/data/http.js',
  './js/data/quotes.js',
  './js/data/series.js',
  './js/data/flows.js',
  './js/data/bonds.js',
  './js/data/dividend.js',
  './js/data/sources/tencent.js',
  './js/data/sources/sinaFlow.js',
  './js/data/sources/sinaFx.js',
  './js/data/sources/emGlobal.js',
  './js/data/sources/cnbcGlobal.js',
  './js/data/sources/fgGlobal.js',
  './js/data/sources/sinaGold.js',
  './js/data/sources/search.js',
  './js/market/session.js',
  './js/chart/base.js',
  './js/chart/trend.js',
  './js/chart/kline.js',
  './js/chart/flowbar.js',
  './js/chart/spark.js',
  './js/ui/board.js',
  './js/ui/indices.js',
  './js/ui/bonds.js',
  './js/ui/nteam.js',
  './js/ui/detail.js',
  './js/ui/flow.js',
  './js/ui/search.js',
  './js/ui/settings.js',
  './js/ui/pullRefresh.js',
  './js/ui/ticker.js',
  './js/ui/toast.js',
  './js/util/dom.js',
  './js/util/format.js',
  './js/dev/selftest.js',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-192.png',
  './assets/icons/maskable-512.png',
  './assets/icons/apple-touch-180.png',
  './assets/fonts/cute.woff2',
  './assets/fonts/qs-500.woff2',
  './assets/fonts/qs-600.woff2',
  './assets/fonts/qs-700.woff2',
];

/** 行情与资金流域名：一律放行到网络，不缓存 */
const API_HOSTS = [
  'qt.gtimg.cn',
  'web.ifzq.gtimg.cn',
  'smartbox.gtimg.cn',
  'vip.stock.finance.sina.com.cn',
  'stock2.finance.sina.com.cn',
  'suggest3.sinajs.cn',
  'push2.eastmoney.com',
  'push2his.eastmoney.com',
  'searchapi.eastmoney.com',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('shell-') && k !== SHELL)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // 行情接口：完全交给网络
  if (API_HOSTS.includes(url.hostname)) return;
  if (url.origin !== self.location.origin) return;

  // 导航：network-first，离线回退 shell
  // no-store 是必须的：GitHub Pages 给 HTML 打 max-age=600，普通 fetch 会命中
  // 浏览器 HTTP 缓存，刷新后拿到的可能还是十分钟前的旧 shell。
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req, { cache: 'no-store' });
      } catch {
        const cached = await caches.match('./index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  // 代码与样式：network-first，离线才回退缓存
  //
  // 这里原本是 stale-while-revalidate，看起来最快，但有个致命副作用：
  // 页面永远比服务器慢一个版本——刷新第一次拿到新 HTML，却仍在跑缓存里的旧 JS，
  // 「传了新包界面还是旧的」就是这么来的。改成网络优先后，联网时一定是最新版；
  // 带 ETag 复验（no-cache），没改动时只回 304，开销很小。
  const path = url.pathname;
  const isCode = /\.(?:js|css|html|webmanifest)$/.test(path);
  if (isCode) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res && res.ok && res.type === 'basic') {
          caches.open(SHELL).then(c => c.put(req, res.clone())).catch(() => {});
        }
        return res;
      } catch {
        const cached = await caches.match(req);
        return cached || new Response('', { status: 504 });
      }
    })());
    return;
  }

  // 图片 / 字体等长缓存资源：cache-first + 后台静默更新
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') {
        caches.open(SHELL).then(c => c.put(req, res.clone())).catch(() => {});
      }
      return res;
    }).catch(() => null);

    return cached || (await network) || new Response('', { status: 504 });
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
