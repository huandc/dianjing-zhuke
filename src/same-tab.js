/* 点睛网 · 自动刷课助手 —— 页面世界脚本：把「播放」弹出的新标签改成当前标签打开
 *
 * 点睛网的播放按钮是 Angular 的 toPlay(...)，内部多半是 window.open(url)，于是每跳一节
 * 就多一个标签页，队列连播几节之后浏览器里堆一堆标签。
 *
 * 这个脚本在页面世界（world: "MAIN"）里提前接管 window.open：
 *   - 只有在内容脚本通过 postMessage 打开开关时（也就是「按队列连播」正在跑、页面是课程列表页）
 *     才拦截，其它时候完全放行；
 *   - 只拦截与当前页面同源的地址，第三方（比如支付、客服）弹窗不受影响；
 *   - 拦截时用 location.href 在同一个标签里跳转，并返回一个「假的 window」，
 *     避免站点代码里 window.open(...).focus() 之类直接抛错。
 */
(() => {
  if (window.__DJZK_SAME_TAB__) return;
  window.__DJZK_SAME_TAB__ = true;

  let on = false;
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__djzk_same_tab === undefined) return;
    on = !!d.on;
  }, false);

  const origOpen = typeof window.open === 'function' ? window.open : null;
  const fake = (url) => ({
    closed: false,
    name: '',
    opener: window,
    focus() {},
    blur() {},
    close() {},
    print() {},
    postMessage() {},
    moveTo() {},
    resizeTo() {},
    document: { write() {}, writeln() {}, close() {} },
    location: { href: url, replace(u) { url = u; } }
  });

  window.open = function (url, name, features) {
    try {
      if (on && typeof url === 'string' && url && !/^about:blank$/i.test(url)) {
        const abs = new URL(url, location.href);
        if (abs.origin === location.origin && abs.href !== location.href) {
          /* 同一个标签里打开，不再堆新标签页 */
          try { window.location.href = abs.href; } catch (e) { /* ignore */ }
          return fake(abs.href);
        }
      }
    } catch (e) { /* 解析失败就按原样放行 */ }
    return origOpen ? origOpen.apply(window, arguments) : null;
  };
})();
