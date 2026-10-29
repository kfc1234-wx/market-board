/**
 * 版本号唯一数据源
 *
 * 为什么单独抽一个文件：这个号原来被抄在三个地方（index.html 顶栏胶囊、
 * 设置页「关于」、sw.js 的缓存名），发版时总是漏改前两个，于是从 v1.21
 * 之后界面上一直显示 v1.21 —— 手机上明明跑着新代码，用户看到的却是旧版本号。
 * 现在三处都读这里，改一处就够了。
 *
 * 必须是 **classic script**（不是 ES module）：sw.js 用 importScripts 同步加载它，
 * importScripts 不认 export。所以挂在 self 上，ES module 里用 self.__APP_VERSION__ 读。
 *
 * 发版检查清单：
 *  1. 改 __APP_VERSION__（界面显示）和 __APP_CACHE__（SW 缓存名）两个值
 *  2. sw.js 的 ASSETS 里已经包含 ./version.js，不用再动
 */

/** 界面显示用（顶栏胶囊、设置页「关于」） */
self.__APP_VERSION__ = 'v1.40.0';

/** Service Worker 缓存名用；变化即触发预缓存重建。与上面保持同值，避免两处对不上 */
self.__APP_CACHE__ = 'v1.40.0';

// Service Worker 里没有 document（importScripts 环境），跳过
if (typeof document !== 'undefined') {
  // 顶栏的版本胶囊由这里填，index.html 里不用写死
  const paint = () => {
    for (const el of document.querySelectorAll('.verpill')) {
      el.textContent = self.__APP_VERSION__;
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paint, { once: true });
  } else {
    paint();
  }
}
