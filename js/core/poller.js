/**
 * 轮询调度器
 *
 * 要点：
 *  - 链式 setTimeout，绝不用 setInterval（避免请求堆积后形成雪崩）
 *  - 延迟 = 目标间隔 - 本轮耗时，再叠 ±15% 抖动，避免多端同时打一个时间点
 *  - 页面隐藏 / 离线 → 立即停；回到前台 → 立刻补一次再恢复节律
 *  - 失败指数退避，最长 60s
 */

import { getQuotes } from '../data/quotes.js';
import { anyMarketOpen } from '../market/session.js';

const FAST = 5000;
const SLOW = 20000;
const MAX_BACKOFF = 60000;

export class Poller {
  /**
   * @param {object} opt
   * @param {() => string[]} opt.getIds 当前需要刷新的标的
   * @param {(quotes:Map<string,any>) => void} opt.onData
   * @param {(err:any) => void} [opt.onError]
   * @param {(state:'live'|'slow'|'offline') => void} [opt.onState]
   */
  constructor(opt) {
    this.getIds = opt.getIds;
    this.onData = opt.onData;
    this.onError = opt.onError || (() => {});
    this.onState = opt.onState || (() => {});

    this.timer = 0;
    this.running = false;
    this.busy = false;
    this.fails = 0;
    this.lastOkAt = 0;

    this._onVisibility = () => {
      if (document.hidden) this._pause();
      else if (this.running) this._resume();
    };
    this._onOnline = () => { if (this.running) this._tick(true); };
    this._onOffline = () => this.onState('offline');
  }

  start() {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('online', this._onOnline);
    window.addEventListener('offline', this._onOffline);
    this._tick(true);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = 0;
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('online', this._onOnline);
    window.removeEventListener('offline', this._onOffline);
  }

  /** 立即刷新一次（下拉刷新 / 进页面） */
  refreshNow() {
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.running) this._tick(true);
  }

  _pause() {
    clearTimeout(this.timer);
    this.timer = 0;
  }

  _resume() {
    // 后台回来可能已经过了很久，数据必然过期
    this.refreshNow();
  }

  _interval() {
    const ids = this.getIds();
    const markets = [...new Set(ids.map(id => (id.startsWith('hf_') ? 'CME'
      : id.startsWith('us') ? 'US' : id.startsWith('hk') ? 'HK' : 'CN')))];
    return anyMarketOpen(markets) ? FAST : SLOW;
  }

  async _tick(force = false) {
    if (!this.running || this.busy) return;
    if (document.hidden || !navigator.onLine) {
      this.onState('offline');
      this._schedule(this._interval());
      return;
    }

    const ids = this.getIds();
    if (!ids.length) {
      this._schedule(SLOW);
      return;
    }

    this.busy = true;
    const t0 = performance.now();
    try {
      const quotes = await getQuotes(ids, force ? { maxAge: 0 } : undefined);
      this.fails = 0;
      this.lastOkAt = Date.now();
      this.onData(quotes);
      this.onState('live');
    } catch (e) {
      this.fails += 1;
      this.onError(e);
      this.onState('stale');
    } finally {
      this.busy = false;
    }

    const cost = performance.now() - t0;
    let base = this._interval();
    if (!this.fails) {
      const anyStale = this.lastOkAt && Date.now() - this.lastOkAt > base * 2.5;
      if (anyStale) this.onState('stale');
    } else {
      base = Math.min(MAX_BACKOFF, Math.max(base, 2000) * Math.pow(2, this.fails - 1));
    }

    const delay = Math.max(1500, base - cost) * (1 + Math.random() * 0.15);
    this._schedule(delay);
  }

  _schedule(delay) {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(() => this._tick(false), delay);
  }
}
