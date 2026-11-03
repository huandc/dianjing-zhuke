/* ============================================================
 * 点睛网 · 自动刷课助手  ——  内容脚本
 * 注入到 *.zfwx.com 的所有页面与 iframe。
 * 流程：找视频 → 保活播放 → 锁定倍速 → 静音 → 播完点「下一节」
 *       → 识别弹题/弹窗 → 右下角悬浮面板 → 状态上报给后台
 * ============================================================ */
(() => {
  'use strict';
  if (window.__DJZK_LOADED__) return;
  window.__DJZK_LOADED__ = true;

  const VERSION = '1.1.0';
  const HOST_OK = /(^|\.)zfwx\.com$/i.test(location.hostname) ||
    location.hostname === 'localhost' || window.__DJZK_FORCE__ === true;
  const IS_TOP = (() => { try { return window.top === window; } catch (e) { return false; } })();

  /* ------------------------- 默认配置 ------------------------- */
  const DEFAULTS = {
    enabled: true,
    autoPlay: true,       // 暂停后自动续播
    autoNext: true,       // 播完自动下一节
    autoMute: true,       // 自动静音
    rate: 1.5,            // 倍速
    forceRate: false,     // 锁定倍速（播放器重置也拉不回来）
    endThreshold: 1.5,    // 距结尾多少秒算“播完”
    nextDelayMinMs: 4000, // 播完后最短等待（随机区间下限）
    nextDelayMaxMs: 6000, // 播完后最长等待（随机区间上限）
    autoList: false,      // 课程列表页自动点“继续学习”
    pauseOnQuiz: true,    // 检测到弹题时暂停并提醒
    beep: true,           // 弹题时响一声
    showPanel: true,      // 显示右下角悬浮面板
    panelPos: null,       // {right, bottom}
    customSelectors: []   // [{sel, text, host}] 手动拾取的“下一节”按钮
  };

  const NEXT_TEXTS = [
    '下一节', '下一讲', '下一课', '下一章', '下一课时', '下一節',
    '下一个视频', '下一节课程', '继续学习', '继续听课'
  ];
  const CONTINUE_TEXTS = ['继续播放', '继续学习', '继续观看', '继续', '知道了', '我知道了', '确定', '好的', '确认'];
  const QUIZ_WORDS = ['答题', '答题卡', '测验', '考试', '判断题', '单选题', '多选题', '提交答案', '随堂练习', '请选择', '本课测试'];
  const DIALOG_SEL = [
    '.layui-layer', '.djwlayer', '[role="dialog"]',
    '[class*="dialog"]', '[class*="Dialog"]', '[class*="modal"]', '[class*="Modal"]',
    '[class*="popup"]', '[class*="Popup"]', '[class*="alert"]'
  ].join(',');

  /* ------------------------- 运行时状态 ------------------------- */
  /* 旧版只有固定延迟 nextDelayMs，迁移成默认 2 秒浮动区间 */
  function mergeSettings(raw) {
    raw = raw || {};
    const out = Object.assign({}, DEFAULTS, raw);
    if (raw.nextDelayMinMs == null && raw.nextDelayMaxMs == null && typeof raw.nextDelayMs === 'number') {
      out.nextDelayMinMs = raw.nextDelayMs;
      out.nextDelayMaxMs = raw.nextDelayMs + 2000;
    }
    return out;
  }

  let S = Object.assign({}, DEFAULTS);
  let video = null;
  let videoSig = '';
  let remote = null;        // 来自子 frame 的状态（顶层 frame 用）
  let nextAt = 0;           // 计划点“下一节”的时间戳
  let nextTries = 0;        // 本节已尝试次数
  let lastClickAt = 0;
  let lastNextSig = '';
  let userPausedUntil = 0;  // 用户手动暂停后的保护期
  let mutedByUs = false;    // 静音是插件做的（关掉开关时要还回去）
  let prevVolume = 1;
  let quizPending = false;
  let quizBeeped = false;
  let lessonsDone = 0;      // 本次会话自动跳过的节数
  let countedSig = '';
  let msg = '正在初始化…';
  let timer = null;
  let ui = null;            // 面板实例
  let pickerOn = false;
  let lastReport = 0;
  let lastAutoListAt = 0;
  const seenDialogs = new WeakSet();

  /* ------------------------- 工具函数 ------------------------- */
  const now = () => Date.now();
  const norm = (s) => String(s || '').replace(/[\s\u3000]+/g, '');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const chromep = () => typeof chrome !== 'undefined' && !!chrome && !!chrome.runtime && !!chrome.storage;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return !(r.width === 0 && r.height === 0);
  }

  function clickEl(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* ignore */ }
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + Math.min(r.width / 2, 20) + 1,
      clientY: r.top + Math.min(r.height / 2, 10) + 1,
      button: 0
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, isPrimary: true }, base)));
      el.dispatchEvent(new MouseEvent('mousedown', base));
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, isPrimary: true }, base)));
      el.dispatchEvent(new MouseEvent('mouseup', base));
      el.dispatchEvent(new MouseEvent('click', base));
    } catch (e) {
      try { el.click(); return true; } catch (_) { return false; }
    }
    return true;
  }

  function clickableOf(el) {
    return (el && el.closest('button, a, [role="button"], .btn, .button, input[type="button"], input[type="submit"]')) || el;
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return true;
    const cls = String(el.className || '') + ' ' + String((el.parentElement && el.parentElement.className) || '');
    if (/\b(disabled|is-disabled|forbid|no-?click|gray)\b/i.test(cls)) return true;
    return getComputedStyle(el).pointerEvents === 'none';
  }

  function textOf(el) {
    if (!el) return '';
    return norm(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.title);
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^\w-]/g, (c) => '\\' + c);
  }

  /** 给元素生成尽量稳定的 CSS 选择器 */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) {
      return '#' + cssEscape(el.id);
    }
    for (const attr of ['data-id', 'data-action', 'data-type', 'data-name', 'title', 'aria-label']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) {
        const sel = el.tagName.toLowerCase() + '[' + attr + '="' + v.replace(/"/g, '\\"') + '"]';
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) { /* ignore */ }
      }
    }
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 5; depth++) {
      let part = cur.tagName.toLowerCase();
      const cls = String(cur.className || '').trim().split(/\s+/)
        .filter((c) => c && !/^[\d_-]/.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.map(cssEscape).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      const sel = parts.join(' > ');
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) { /* ignore */ }
      cur = parent;
    }
    return parts.join(' > ');
  }

  function beep() {
    if (!S.beep) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ac = new Ctx();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.value = 0.08;
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.18);
      setTimeout(() => ac.close().catch(() => {}), 600);
    } catch (e) { /* ignore */ }
  }

  /* ------------------------- 播放器 ------------------------- */
  function pickVideo() {
    const list = [...document.querySelectorAll('video')];
    if (!list.length) return null;
    let best = null;
    let bestScore = -1;
    for (const v of list) {
      const r = v.getBoundingClientRect();
      let score = r.width * r.height;
      if (v.paused === false && !v.ended) score += 5e7;
      if (!v.currentSrc && !v.src) score -= 1e7;
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }

  function videoSigOf(v) {
    if (!v) return '';
    return [v.currentSrc || v.src || '', Math.round(v.duration || 0)].join('|');
  }

  function applyPlayback(v) {
    if (!v) return;
    if (window.__DJZK_RATE) {
      window.__DJZK_RATE.set(S.rate);
      window.__DJZK_RATE.enable(!!S.forceRate && S.enabled);
    }
    if (isFinite(S.rate) && Math.abs(v.playbackRate - S.rate) > 0.01) {
      try { v.playbackRate = S.rate; } catch (e) { /* ignore */ }
    }
    if (S.autoMute) {
      if (!v.muted) {
        prevVolume = v.volume || 1;
        try { v.muted = true; mutedByUs = true; } catch (e) { /* ignore */ }
      }
      if (v.volume !== 0) { try { v.volume = 0; } catch (e) { /* ignore */ } }
    } else if (mutedByUs) {
      /* 用户关掉了「自动静音」→ 把声音还回去 */
      mutedByUs = false;
      try { v.muted = false; v.volume = prevVolume || 1; } catch (e) { /* ignore */ }
    }
    if (S.autoPlay && v.paused && !v.ended && !quizPending && now() > userPausedUntil) {
      const p = v.play();
      if (p && p.catch) p.catch(() => { msg = '浏览器拦了自动播放，请手动点一下播放'; });
    }
  }

  function nearEnd(v) {
    if (!v || !isFinite(v.duration) || v.duration <= 0) return false;
    return v.duration - v.currentTime <= Math.max(0.8, S.endThreshold);
  }

  function noteVideo(v) {
    const sig = videoSigOf(v);
    if (sig && sig !== videoSig) {
      videoSig = sig;
      nextAt = 0;
      nextTries = 0;
      lastNextSig = '';
      quizPending = false;
      quizBeeped = false;
      msg = '新的视频已开始';
    }
    video = v;
  }

  /* ------------------------- 下一节 ------------------------- */
  function collectCandidates() {
    const out = [];
    for (const item of S.customSelectors || []) {
      const sel = typeof item === 'string' ? item : item && item.sel;
      if (!sel) continue;
      let nodes = [];
      try { nodes = [...document.querySelectorAll(sel)]; } catch (e) { nodes = []; }
      if (!nodes.length && item && item.text) {
        nodes = [...document.querySelectorAll('a,button,[role="button"],li,span')]
          .filter((el) => textOf(el) === norm(item.text));
      }
      for (const el of nodes) if (isVisible(el)) out.push({ el, pri: -10, tag: '已拾取' });
    }

    const nodes = document.querySelectorAll('a,button,[role="button"],li,span,div,td');
    let scanned = 0;
    for (const el of nodes) {
      if (++scanned > 6000) break;
      const t = textOf(el);
      if (!t || t.length > 16) continue;
      const pri = NEXT_TEXTS.findIndex((k) => t === k || t === k + '>' || t === k + '>>');
      if (pri < 0) continue;
      if (!isVisible(el) || isDisabled(el)) continue;
      if (el.querySelector('a,button')) continue;
      out.push({ el: clickableOf(el), pri, tag: t });
    }
    out.sort((a, b) => a.pri - b.pri);
    return out;
  }

  function doNext(reason) {
    if (!S.enabled || !S.autoNext) { msg = '自动下一节未开启'; return false; }
    if (now() - lastClickAt < 2500) return false;
    lastClickAt = now();
    lastNextSig = videoSig;
    const cands = collectCandidates();
    if (!cands.length) {
      msg = '没找到「下一节」按钮 → 用面板上的「拾取」点一下它';
      return false;
    }
    nextTries += 1;
    const target = cands[0].el;
    msg = '点击下一节：' + (cands[0].tag || target.tagName.toLowerCase());
    clickEl(target);
    if (countedSig !== videoSig && videoSig) {
      countedSig = videoSig;
      lessonsDone += 1;
    }
    if (nextTries >= 3) {
      msg = '点了 ' + nextTries + ' 次仍没换视频，请手动操作或用「拾取」重新指定';
    }
    report(true);
    return true;
  }

  function fmtSec(ms) {
    const s = Math.round(ms / 100) / 10;
    return String(s).replace(/\.0$/, '');
  }

  /* 播完后等待区间（毫秒），兼容旧版固定值 nextDelayMs */
  function nextDelayRange() {
    let lo = Number(S.nextDelayMinMs);
    let hi = Number(S.nextDelayMaxMs);
    if (!isFinite(lo)) lo = Number(S.nextDelayMs);
    if (!isFinite(lo)) lo = 4000;
    if (!isFinite(hi)) hi = lo + 2000;
    lo = Math.min(Math.max(lo, 0), 180000);
    hi = Math.min(Math.max(hi, 0), 180000);
    if (hi < lo) { const t = lo; lo = hi; hi = t; }
    return [lo, hi];
  }

  function scheduleNext() {
    if (nextAt) return;
    const [lo, hi] = nextDelayRange();
    const wait = lo + (hi > lo ? Math.random() * (hi - lo) : 0);
    nextAt = now() + wait;
    const span = lo === hi ? fmtSec(lo) + ' 秒' : fmtSec(lo) + '–' + fmtSec(hi) + ' 秒随机';
    msg = '本节已播完，' + Math.max(0, Math.round(wait / 1000)) + ' 秒后进入下一节（' + span + '）';
  }

  /* ------------------------- 弹窗 / 弹题 ------------------------- */
  function topDialog() {
    let found = null;
    for (const el of document.querySelectorAll(DIALOG_SEL)) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 60) continue;
      found = el; // 取最后一个 = 层级最高
    }
    return found;
  }

  function handleDialog(dlg) {
    if (!dlg) return false;
    const txt = norm(dlg.innerText || dlg.textContent || '').slice(0, 400);
    if (!txt) return false;

    if (QUIZ_WORDS.some((w) => txt.includes(w))) {
      if (!S.pauseOnQuiz) return false;
      if (!quizPending) {
        quizPending = true;
        if (!quizBeeped) { quizBeeped = true; beep(); msg = '检测到弹题/测验，已暂停 —— 请手动作答'; }
        if (video && !video.paused) { try { video.pause(); } catch (e) { /* ignore */ } }
      }
      return true;
    }

    if (!S.autoPlay) return false;
    if (seenDialogs.has(dlg)) return false;

    const btns = [...dlg.querySelectorAll('button, a, span, div, input[type="button"]')]
      .filter((b) => b.children.length === 0 && isVisible(b))
      .map((b) => ({ b, t: textOf(b) }))
      .filter(({ t }) => t && t.length <= 8 && !/取消|关闭|退出/.test(t))
      .filter(({ t }) => CONTINUE_TEXTS.includes(t) || /继续播放|继续学习/.test(t));
    if (btns.length) {
      seenDialogs.add(dlg);
      clickEl(btns[0].b);
      msg = '已点掉提示框「' + btns[0].t + '」';
      return true;
    }
    return false;
  }

  /* ------------------------- 课程列表自动进课 ------------------------- */
  function autoListAdvance() {
    if (!S.autoList || !S.enabled) return false;
    if (now() - lastAutoListAt < 15000) return false;
    const words = ['继续学习', '开始学习', '继续听课', '未学完'];
    let scanned = 0;
    for (const el of document.querySelectorAll('a,button,[role="button"],li,span,div')) {
      if (++scanned > 6000) break;
      const t = textOf(el);
      if (!t || t.length > 12) continue;
      if (!words.some((w) => t === w)) continue;
      if (!isVisible(el) || isDisabled(el)) continue;
      if (el.querySelector('a,button')) continue;
      lastAutoListAt = now();
      msg = '课程列表页：自动进入「' + t + '」';
      clickEl(clickableOf(el));
      return true;
    }
    return false;
  }

  /* ------------------------- 主循环 ------------------------- */
  function tick() {
    if (!S.enabled) { render(); report(); return; }

    const v = pickVideo();
    noteVideo(v);

    if (v) {
      applyPlayback(v);
      if (v.ended || nearEnd(v)) scheduleNext();
      /* 点了下一节但视频没变 → 12 秒后重试（最多 3 次） */
      if (lastNextSig && lastNextSig === videoSig && nextTries > 0 && nextTries < 3 &&
          now() - lastClickAt > 12000 && !nextAt) {
        nextAt = now() + 2000;
        msg = '点了下一节但没切换，' + nextTries + ' 秒后重试…';
      }
    } else if (IS_TOP) {
      autoListAdvance();
    }

    const dlg = topDialog();
    handleDialog(dlg);
    if (quizPending && !dlg) {
      quizPending = false;
      quizBeeped = false;
      msg = '弹题已消失，继续播放';
    }

    if (nextAt && now() >= nextAt) {
      nextAt = 0;
      if (!doNext('播完') && nextTries < 3) nextAt = now() + 6000;
    }

    render();
    report();
  }

  /* ------------------------- 状态 / 上报 ------------------------- */
  function remoteActive() {
    const local = snapshotLocal();
    if (local.hasVideo) return false;
    return !!(remote && (remote.hasVideo));
  }

  function snapshotLocal() {
    const v = video && video.isConnected ? video : pickVideo();
    const cur = v ? (v.currentTime || 0) : 0;
    const dur = v ? (isFinite(v.duration) ? v.duration : 0) : 0;
    return {
      v: VERSION,
      top: IS_TOP,
      href: location.href,
      host: location.hostname,
      hasVideo: !!v,
      playing: !!(v && !v.paused && !v.ended),
      ended: !!(v && v.ended),
      rate: v ? v.playbackRate : S.rate,
      muted: !!(v && v.muted),
      cur: Math.round(cur),
      dur: Math.round(dur),
      pct: dur ? Math.round((cur / dur) * 100) : 0,
      nextIn: nextAt ? Math.max(0, Math.round((nextAt - now()) / 1000)) : 0,
      quiz: quizPending,
      lessons: lessonsDone,
      msg,
      enabled: S.enabled,
      at: now()
    };
  }

  function snapshot() {
    const local = snapshotLocal();
    if (local.hasVideo || !remote || !remote.hasVideo) return local;
    return Object.assign({}, remote, { viaFrame: true, lessons: lessonsDone, href: local.href });
  }

  function report(force) {
    const t = now();
    if (!force && t - lastReport < 1500) return;
    lastReport = t;
    if (!chromep()) return;
    try {
      chrome.runtime.sendMessage({ type: 'DJZK_REPORT', state: snapshotLocal() }, () => void chrome.runtime.lastError);
    } catch (e) { /* ignore */ }
  }

  function sendCmd(cmd) {
    if (!chromep()) return;
    if (remoteActive()) {
      chrome.runtime.sendMessage({ type: 'DJZK_CMD_REQ', cmd }, () => void chrome.runtime.lastError);
      msg = cmd === 'pick' ? '已通知视频所在的子页面开始拾取' : '已通知视频所在的子页面切换';
      return;
    }
    if (cmd === 'next') doNext('面板');
    if (cmd === 'pick') startPicker();
  }

  function saveSettings(patch) {
    S = Object.assign({}, S, patch);
    applyToDom();
    if (chromep()) chrome.storage.local.set({ djzk_settings: S });
    tick();
  }

  function applyToDom() {
    if (S.showPanel && !ui) mountUi();
    if (!S.showPanel && ui) { ui.host.remove(); ui = null; }
    if (ui) ui.update();
  }

  /* ------------------------- 浮动面板 ------------------------- */
  function mountUi() {
    if (!IS_TOP || ui) return;
    const host = document.createElement('div');
    host.id = 'djzk-root';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;right:14px;bottom:14px;';
    if (S.panelPos) {
      host.style.right = S.panelPos.right + 'px';
      host.style.bottom = S.panelPos.bottom + 'px';
    }
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{all:initial}
        .wrap{font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#e8eefc;
              width:252px;background:linear-gradient(160deg,rgba(24,30,48,.97),rgba(15,19,32,.97));
              border:1px solid rgba(120,160,255,.28);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.45);
              overflow:hidden;backdrop-filter:blur(8px);user-select:none}
        .hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:rgba(255,255,255,.05);cursor:move}
        .dot{width:8px;height:8px;border-radius:50%;background:#f45b5b;box-shadow:0 0 8px #f45b5b;flex:none}
        .dot.on{background:#3ddc84;box-shadow:0 0 8px #3ddc84}
        .ttl{font-weight:600;letter-spacing:.3px;flex:1;font-size:12px}
        .ic{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;cursor:pointer;color:#9fb2d8}
        .ic:hover{background:rgba(255,255,255,.12);color:#fff}
        .bd{padding:9px 10px 10px}
        .row{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;color:#a9b8d6}
        .row b{color:#fff;font-weight:600;font-variant-numeric:tabular-nums}
        .bar{height:5px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden;margin:2px 0 8px}
        .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#4f8cff,#7ee0c0);transition:width .4s}
        .msg{font-size:11px;color:#8fa4c9;min-height:30px;margin-bottom:6px;word-break:break-all}
        .rowbtns{display:flex;gap:6px;margin-bottom:8px}
        button.b{flex:1;border:1px solid rgba(120,160,255,.3);background:rgba(80,120,255,.16);color:#dce7ff;
                 border-radius:8px;padding:5px 4px;cursor:pointer;font-size:11px;font-family:inherit}
        button.b:hover{background:rgba(80,120,255,.32)}
        .sec{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
        .tag{border:1px solid rgba(255,255,255,.14);border-radius:99px;padding:3px 8px;cursor:pointer;
             color:#8fa4c9;background:transparent;font-size:11px;font-family:inherit}
        .tag.on{color:#0d1526;background:#7ee0c0;border-color:transparent;font-weight:600}
        .rate{display:flex;align-items:center;gap:6px;margin-bottom:8px}
        .rate .val{flex:1;text-align:center;color:#fff;font-weight:600;font-variant-numeric:tabular-nums}
        .ft{display:flex;justify-content:space-between;font-size:10px;color:#5f7091;border-top:1px solid rgba(255,255,255,.07);padding-top:6px}
        .ft a{color:#7ea6ff;text-decoration:none;cursor:pointer}
        .fold .bd{display:none}
        .toast{position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:rgba(20,26,40,.95);
               color:#fff;padding:6px 12px;border-radius:8px;font-size:12px;z-index:2147483647;white-space:nowrap}
      </style>
      <div class="wrap">
        <div class="hd">
          <span class="dot"></span><span class="ttl">点睛助手</span>
          <span class="ic" data-act="fold" title="折叠">−</span>
          <span class="ic" data-act="hide" title="隐藏面板">×</span>
        </div>
        <div class="bd">
          <div class="row"><span>视频</span><b data-f="status">—</b></div>
          <div class="row"><span>进度</span><b data-f="pct">—</b></div>
          <div class="bar"><i data-f="bar"></i></div>
          <div class="msg" data-f="msg">初始化…</div>
          <div class="rowbtns">
            <button class="b" data-act="next">立即下一节</button>
            <button class="b" data-act="pick">拾取「下一节」</button>
          </div>
          <div class="sec">
            <button class="tag" data-t="autoPlay">自动播放</button>
            <button class="tag" data-t="autoNext">自动下一节</button>
            <button class="tag" data-t="autoMute">静音</button>
            <button class="tag" data-t="forceRate">锁定倍速</button>
            <button class="tag" data-t="pauseOnQuiz">弹题暂停</button>
          </div>
          <div class="rate">
            <button class="b" data-act="rate-">−</button>
            <span class="val" data-f="rate">1.5×</span>
            <button class="b" data-act="rate+">＋</button>
          </div>
          <div class="ft">
            <span data-f="lessons">本次 0 节</span>
            <a data-act="settings">全部设置</a>
          </div>
        </div>
      </div>`;

    const wrap = root.querySelector('.wrap');
    const $ = (sel) => root.querySelector(sel);

    ui = {
      host,
      root,
      contains: (el) => host.contains(el),
      toast: (text) => {
        const t = document.createElement('div');
        t.className = 'toast';
        t.textContent = text;
        root.appendChild(t);
        setTimeout(() => t.remove(), 1800);
      },
      update: () => {
        const st = snapshot();
        const via = st.viaFrame ? '（子框架）' : '';
        $('[data-f="status"]').textContent = st.hasVideo
          ? (st.ended ? '已播完' + via : st.playing ? '播放中' + via : '已暂停' + via)
          : '未检测到';
        $('[data-f="pct"]').textContent = st.hasVideo
          ? st.pct + '%  ' + fmt(st.cur) + '/' + fmt(st.dur)
          : '—';
        $('[data-f="bar"]').style.width = (st.hasVideo ? st.pct : 0) + '%';
        const m = st.msg || msg;
        $('[data-f="msg"]').textContent = st.nextIn > 0 ? m + '（' + st.nextIn + 's）' : m;
        $('[data-f="rate"]').textContent = fmtRate(st.rate || S.rate);
        $('[data-f="lessons"]').textContent = '本次 ' + lessonsDone + ' 节';
        $('.dot').classList.toggle('on', !!S.enabled);
        root.querySelectorAll('.tag').forEach((b) => b.classList.toggle('on', !!S[b.dataset.t]));
      },
      fold: () => wrap.classList.toggle('fold')
    };

    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act],[data-t]');
      if (!btn) return;
      e.stopPropagation();
      if (btn.dataset.t) { saveSettings({ [btn.dataset.t]: !S[btn.dataset.t] }); return; }
      switch (btn.dataset.act) {
        case 'fold': wrap.classList.toggle('fold'); break;
        case 'hide': saveSettings({ showPanel: false }); break;
        case 'next': sendCmd('next'); ui.update(); break;
        case 'pick': sendCmd('pick'); break;
        case 'rate-': saveSettings({ rate: stepRate(S.rate, -1) }); break;
        case 'rate+': saveSettings({ rate: stepRate(S.rate, 1) }); break;
        case 'settings':
          if (chromep() && chrome.runtime.getURL) window.open(chrome.runtime.getURL('src/popup.html'), '_blank');
          else ui.toast('请在扩展图标里打开设置');
          break;
      }
    });

    let drag = null;
    $('.hd').addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-act]')) return;
      const r = host.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, right: innerWidth - r.right, bottom: innerHeight - r.bottom };
      $('.hd').setPointerCapture(e.pointerId);
    });
    $('.hd').addEventListener('pointermove', (e) => {
      if (!drag) return;
      const right = clamp(drag.right - (e.clientX - drag.x), 4, innerWidth - 120);
      const bottom = clamp(drag.bottom - (e.clientY - drag.y), 4, innerHeight - 80);
      host.style.right = right + 'px';
      host.style.bottom = bottom + 'px';
      host.style.left = 'auto';
      host.style.top = 'auto';
    });
    $('.hd').addEventListener('pointerup', () => {
      if (!drag) return;
      drag = null;
      const r = host.getBoundingClientRect();
      S.panelPos = { right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom) };
      if (chromep()) chrome.storage.local.set({ djzk_settings: S });
    });

    ui.update();
  }

  const RATES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  function stepRate(cur, dir) {
    let i = RATES.findIndex((r) => Math.abs(r - cur) < 0.01);
    if (i < 0) i = 2;
    return RATES[clamp(i + dir, 0, RATES.length - 1)];
  }

  function fmtRate(r) {
    return String(Number(r).toFixed(2)).replace(/0+$/, '').replace(/\.$/, '') + '×';
  }

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  }

  function render() { if (ui) ui.update(); }

  /* ------------------------- 元素拾取 ------------------------- */
  function startPicker() {
    if (pickerOn) return;
    pickerOn = true;
    const doc = document;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #7ee0c0;' +
      'background:rgba(126,224,192,.18);border-radius:4px;left:0;top:0;width:0;height:0;transition:left .05s,top .05s,width .05s,height .05s';
    const tip = document.createElement('div');
    tip.textContent = '点击页面上的「下一节」按钮（Esc 取消）';
    tip.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:16px;transform:translateX(-50%);' +
      'background:rgba(16,22,36,.95);color:#dce7ff;padding:8px 14px;border-radius:9px;' +
      'font:13px/1.4 -apple-system,"PingFang SC",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.4);white-space:nowrap';
    document.documentElement.append(box, tip);

    const move = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el === tip) return;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    };

    const cleanup = () => {
      pickerOn = false;
      doc.removeEventListener('pointermove', move, true);
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('keydown', onKey, true);
      box.remove();
      tip.remove();
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY) || e.target;
      const target = clickableOf(el) || el;
      const sel = cssPath(target);
      const text = textOf(target).slice(0, 16);
      const list = [].concat(S.customSelectors || []);
      list.unshift({ sel, text, host: location.hostname });
      saveSettings({ customSelectors: list.slice(0, 5) });
      cleanup();
      msg = '已拾取下一节按钮：' + (text || sel);
      if (ui) ui.toast('已记住：' + (text || sel));
    };

    const onKey = (e) => { if (e.key === 'Escape') { cleanup(); if (ui) ui.toast('已取消拾取'); } };
    doc.addEventListener('pointermove', move, true);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('keydown', onKey, true);
  }

  /* ------------------------- 消息 ------------------------- */
  function onMessage(m, sender, reply) {
    if (!m || !m.type) return;
    if (m.type === 'DJZK_PUSH') {
      if (m.state) {
        remote = m.state;
        if (m.state.hasVideo) render();
      }
      return;
    }
    if (m.type === 'DJZK_CMD') {
      if (m.cmd === 'next') doNext('面板');
      else if (m.cmd === 'pick') startPicker();
      else if (m.cmd === 'play') applyPlayback(video || pickVideo());
      if (reply) reply({ ok: true, state: snapshot() });
      return true;
    }
    if (m.type === 'DJZK_GET_STATE') { reply(snapshot()); return true; }
  }

  /* ------------------------- 启动 ------------------------- */
  function init() {
    if (!HOST_OK) return;
    if (chromep()) {
      chrome.storage.local.get({ djzk_settings: DEFAULTS }, (res) => {
        S = mergeSettings(res.djzk_settings);
        boot();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.djzk_settings) {
          S = mergeSettings(changes.djzk_settings.newValue);
          applyToDom();
          render();
        }
      });
    } else {
      boot();
    }

    function boot() {
      installRateLock();
      applyToDom();
      timer = setInterval(tick, 1000);
      document.addEventListener('visibilitychange', () => setTimeout(tick, 300));
      document.addEventListener('ended', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
          noteVideo(e.target);
          if (S.enabled && S.autoNext) scheduleNext();
        }
      }, true);
      document.addEventListener('pointerdown', (e) => {
        if (e.target && e.target.tagName === 'VIDEO' && e.isTrusted) userPausedUntil = now() + 90000;
      }, true);
      document.addEventListener('pause', (e) => {
        if (e.target && e.target.tagName === 'VIDEO' && !quizPending && now() > userPausedUntil) {
          setTimeout(() => applyPlayback(e.target), 500);
        }
      }, true);
      tick();
      setTimeout(() => report(true), 800);
    }
  }

  /* 锁定倍速：覆盖 HTMLMediaElement.prototype.playbackRate
     —— 有的播放器在 seek / 切清晰度 / 插入广告后把倍速重置回 1x */
  function installRateLock() {
    if (window.__DJZK_RATE) return;
    try {
      const proto = HTMLMediaElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
      if (!d || !d.get || !d.set || d.configurable === false) return;
      let desired = S.rate;
      let on = false;
      window.__DJZK_RATE = { set(r) { desired = r; }, enable(b) { on = !!b; } };
      Object.defineProperty(proto, 'playbackRate', {
        configurable: true,
        enumerable: d.enumerable,
        get() {
          try { return on ? desired : d.get.call(this); } catch (e) { return 1; }
        },
        set(val) {
          const v = on ? desired : val;
          try { d.set.call(this, v); } catch (e) { /* ignore */ }
        }
      });
    } catch (e) { /* ignore */ }
  }

  if (chromep()) chrome.runtime.onMessage.addListener(onMessage);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  /* 调试 / 自动化测试入口 */
  window.__DJZK_TEST__ = {
    pickVideo, collectCandidates, doNext, cssPath, snapshot, delayRange: nextDelayRange,
    get settings() { return S; },
    get msg() { return msg; }
  };
})();
