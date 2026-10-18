/**
 * HTTP 基础层
 * - fetch + 超时 + 重试（带抖动）
 * - GBK 解码（腾讯行情是 GBK）
 * - JSONP（新浪无 CORS，只能脚本注入）
 */

/** 探测当前环境是否支持 GBK 解码 */
export const GBK_SUPPORTED = (() => {
  try {
    // 某些极老的 iOS 会抛 RangeError
    const d = new TextDecoder('gbk');
    return typeof d.decode === 'function';
  } catch {
    return false;
  }
})();

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 抓取文本
 * @param {string} url
 * @param {{timeout?:number, retries?:number, encoding?:'gbk'}} [opt]
 */
export async function getText(url, opt = {}) {
  const { timeout = 8000, retries = 1, encoding } = opt;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (encoding === 'gbk' && GBK_SUPPORTED) {
        return new TextDecoder('gbk').decode(await res.arrayBuffer());
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(300 + Math.random() * 400);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('request failed');
}

/** 抓取 JSON */
export async function getJSON(url, opt = {}) {
  const text = await getText(url, opt);
  try {
    return JSON.parse(text);
  } catch {
    // 有些接口会包裹成 cb({...})
    const m = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(text);
    if (m) return JSON.parse(m[0]);
    throw new Error('invalid json');
  }
}

/**
 * JSONP：注入 <script>，读取 `var <name>=...` 定义的全局变量。
 * 关键点：
 *  - 变量名必须唯一（并发请求不能串台）
 *  - 读取后立刻 delete + 移除 script，防止全局泄漏与内存增长
 *  - 超时与 onerror 也要清理，避免悬挂的 script 标签
 * @param {string} url
 * @param {string} name 全局变量名
 * @param {number} [timeout]
 */
export function jsonpVar(url, name, timeout = 8000) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('no document'));
      return;
    }
    const script = document.createElement('script');
    let settled = false;
    let timer = 0;

    const cleanup = () => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    const finish = ok => {
      if (settled) return;
      settled = true;
      let value;
      try {
        value = window[name];
      } catch {
        value = undefined;
      }
      try {
        delete window[name];
      } catch {
        window[name] = undefined;
      }
      cleanup();
      if (ok && value !== undefined && value !== null) resolve(value);
      else reject(new Error('jsonp fail: ' + name));
    };

    timer = setTimeout(() => finish(false), timeout);
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    script.async = true;
    script.src = url;
    document.head.appendChild(script);
  });
}

/** 注入 <script> 并读取任意全局变量（腾讯行情 GBK 兜底通道用） */
export function loadScript(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    let timer = 0;
    const cleanup = () => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (script.parentNode) script.parentNode.removeChild(script);
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('script timeout'));
    }, timeout);
    script.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('script error'));
    };
    script.async = true;
    script.src = url;
    document.head.appendChild(script);
  });
}

/** 简单的并发闸门：同一域名的请求串行排队，控制最小间隔 */
export function createGate(minGap = 0) {
  let chain = Promise.resolve();
  let lastAt = 0;
  return function run(fn) {
    const task = chain.then(async () => {
      const wait = Math.max(0, minGap - (Date.now() - lastAt));
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      return fn();
    });
    // 让链条不因单次失败而断裂
    chain = task.catch(() => {});
    return task;
  };
}

export { sleep };
