/**
 * 下拉刷新
 * 仅在滚动容器到顶时接管手势，避免与原生橡皮筋冲突。
 */

export function createPullRefresh({ scroller, indicator, onRefresh }) {
  const THRESHOLD = 64;
  const MAX_PULL = 96;

  let startY = 0;
  let pulling = false;
  let dist = 0;
  let busy = false;

  const show = text => {
    indicator.classList.add('is-visible');
    indicator.querySelector('.pull__text').textContent = text;
  };
  const hide = () => {
    indicator.classList.remove('is-visible', 'is-loading');
    indicator.style.transform = '';
  };

  const onStart = e => {
    if (busy) return;
    if (scroller.scrollTop > 0) return;
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    pulling = true;
    dist = 0;
  };

  const onMove = e => {
    if (!pulling || busy) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) {
      if (pulling) hide();
      dist = 0;
      return;
    }
    if (scroller.scrollTop > 0) { pulling = false; hide(); return; }

    dist = Math.min(MAX_PULL, dy * 0.45);
    if (dist > 8) {
      show(dist >= THRESHOLD ? '松手刷新' : '下拉刷新');
      indicator.style.transform = `translateY(${dist - 8}px)`;
    }
  };

  const onEnd = async () => {
    if (!pulling || busy) { pulling = false; return; }
    pulling = false;

    if (dist < THRESHOLD) {
      hide();
      dist = 0;
      return;
    }

    busy = true;
    indicator.classList.add('is-loading');
    indicator.querySelector('.pull__text').textContent = '刷新中';
    indicator.style.transform = 'translateY(24px)';

    try {
      await onRefresh?.();
    } finally {
      busy = false;
      dist = 0;
      hide();
    }
  };

  scroller.addEventListener('touchstart', onStart, { passive: true });
  scroller.addEventListener('touchmove', onMove, { passive: true });
  scroller.addEventListener('touchend', onEnd, { passive: true });
  scroller.addEventListener('touchcancel', onEnd, { passive: true });

  return {
    destroy() {
      scroller.removeEventListener('touchstart', onStart);
      scroller.removeEventListener('touchmove', onMove);
      scroller.removeEventListener('touchend', onEnd);
      scroller.removeEventListener('touchcancel', onEnd);
    },
  };
}
