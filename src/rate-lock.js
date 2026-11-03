/* 点睛网 · 强制倍速（页面世界 / MAIN world）
 *
 * 内容脚本运行在隔离世界，改 HTMLMediaElement.prototype 影响不到页面自己的代码，
 * 播放器一旦把倍速写回 1x 就拉不住。这个脚本由 manifest 以 world:"MAIN" 在
 * document_start 注入到页面世界，在播放器代码之前接管 playbackRate：
 *   - 读：开启强制时永远返回目标倍速；
 *   - 写：开启强制时忽略页面传入的值，直接写目标倍速；
 *   - 事件：ratechange / play / loadedmetadata / seeked 后再拉一次；
 *   - 实例级兜底：给 <video> 自己再定义一次属性，页面在实例上改也绕不过去。
 * 倍速由内容脚本通过 window.postMessage({__djzk_rate:1,...}) 告知。
 */
(function () {
  'use strict';
  if (window.__DJZK_RATE_MAIN__) return;
  var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  if (!proto) return;
  var desc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
  if (!desc || !desc.get || !desc.set) return;

  var state = { rate: 1, on: false, el: null };
  window.__DJZK_RATE_MAIN__ = state;

  function direct(el, r) {
    try { desc.set.call(el, r); } catch (e) { /* ignore */ }
  }

  function lockInstance(el) {
    if (!el || el === state.el) return;
    var native = desc.get.call(el);
    try {
      Object.defineProperty(el, 'playbackRate', {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () { return state.on ? state.rate : native; },
        set: function (val) {
          if (state.on) direct(el, state.rate);
          else { native = val; direct(el, val); }
        }
      });
    } catch (e) { /* ignore */ }
  }

  function force(el) {
    if (!state.on || !el || el.tagName === undefined) return;
    if (Math.abs(nativeRate(el) - state.rate) > 0.01) direct(el, state.rate);
    lockInstance(el);
    state.el = el;
  }

  function nativeRate(el) {
    try { return desc.get.call(el); } catch (e) { return state.rate; }
  }

  function forceAll() {
    if (!state.on) return;
    var els = document.querySelectorAll('video,audio');
    for (var i = 0; i < els.length; i++) force(els[i]);
  }

  Object.defineProperty(proto, 'playbackRate', {
    configurable: true,
    enumerable: desc.enumerable,
    get: function () {
      try { return state.on ? state.rate : desc.get.call(this); } catch (e) { return 1; }
    },
    set: function (val) {
      if (state.on) { direct(this, state.rate); force(this); }
      else direct(this, val);
    }
  });

  /* 播放器可能在内部把倍速写回，这里每次相关事件后再拉一次 */
  ['ratechange', 'play', 'playing', 'loadedmetadata', 'canplay', 'seeked'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var t = e.target;
      if (state.on && t && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO')) force(t);
    }, true);
  });

  /* 播放器动态插进来的新视频 */
  try {
    new MutationObserver(function (muts) {
      if (!state.on) return;
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (!n || n.nodeType !== 1) continue;
          if (n.tagName === 'VIDEO' || n.tagName === 'AUDIO') force(n);
          else if (n.querySelectorAll) {
            var inner = n.querySelectorAll('video,audio');
            for (var k = 0; k < inner.length; k++) force(inner[k]);
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* ignore */ }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__djzk_rate !== 1) return;
    var r = Number(d.rate);
    state.rate = isFinite(r) && r > 0 ? r : 1;
    state.on = !!d.on;
    if (state.on) forceAll();
  });

  /* 兜底：每秒对一次，防止播放器绕过属性直接改内部速率 */
  setInterval(forceAll, 1000);
})();
