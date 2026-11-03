/* ============================================================
 * 点睛网 · 自动刷课助手  ——  内容脚本
 * 注入到 *.zfwx.com / *.dianjingyun.com 的所有页面与 iframe。
 * 流程：找视频 → 保活播放 → 强制倍速 → 静音 → 播完点「下一节」
 *       → 识别弹题/弹窗 → 右下角悬浮面板 → 状态上报给后台
 * ============================================================ */
(() => {
  'use strict';
  if (window.__DJZK_LOADED__) return;
  window.__DJZK_LOADED__ = true;

  const VERSION = '1.6.0';
  const HOST_OK = (/(^|\.)zfwx\.com$/i.test(location.hostname) ||
    /(^|\.)dianjingyun\.com$/i.test(location.hostname)) ||
    location.hostname === 'localhost' || window.__DJZK_FORCE__ === true;
  const IS_TOP = (() => { try { return window.top === window; } catch (e) { return false; } })();

  /* ------------------------- 默认配置 ------------------------- */
  const DEFAULTS = {
    enabled: true,
    autoPlay: true,       // 暂停后自动续播
    autoNext: true,       // 播完自动下一节
    autoMute: true,       // 自动静音
    rate: 1.5,            // 倍速
    forceRate: true,      // 强制倍速（页面改写也压住）
    endThreshold: 1.5,    // 距结尾多少秒算“播完”
    nextDelayMinMs: 4000, // 播完后最短等待（随机区间下限）
    nextDelayMaxMs: 6000, // 播完后最长等待（随机区间上限）
    autoList: false,
    listRun: true,      // 课程列表页自动点“继续学习”
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
  function clampRate(r) {
    const n = Number(r);
    if (!isFinite(n) || n <= 0) return 1.5;
    return Math.min(16, Math.max(0.5, Math.round(n * 100) / 100));
  }

  function mergeSettings(raw) {
    raw = raw || {};
    const out = Object.assign({}, DEFAULTS, raw);
    if (raw.nextDelayMinMs == null && raw.nextDelayMaxMs == null && typeof raw.nextDelayMs === 'number') {
      out.nextDelayMinMs = raw.nextDelayMs;
      out.nextDelayMaxMs = raw.nextDelayMs + 2000;
    }
    out.rate = clampRate(out.rate);
    return out;
  }

  let S = Object.assign({}, DEFAULTS);
  let video = null;
  let videoSig = '';
  let remote = null;        // 来自子 frame 的状态（顶层 frame 用）
  let nextAt = 0;
  let prevCur = 0;           // 计划点“下一节”的时间戳
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

  /* 把目标倍速告知页面世界的 rate-lock.js，并对当前所有媒体元素拉一次 */
  function syncRateLock(v) {
    const on = !!S.forceRate && S.enabled;
    if (window.__DJZK_RATE) {
      window.__DJZK_RATE.set(S.rate);
      window.__DJZK_RATE.enable(on);
    }
    try { window.postMessage({ __djzk_rate: 1, rate: S.rate, on }, '*'); } catch (e) { /* ignore */ }
    if (!on || !isFinite(S.rate)) return;
    const all = document.querySelectorAll('video,audio');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (Math.abs(el.playbackRate - S.rate) > 0.01) {
        try { el.playbackRate = S.rate; } catch (e) { /* ignore */ }
      }
    }
    if (v && Math.abs(v.playbackRate - S.rate) > 0.01) {
      try { v.playbackRate = S.rate; } catch (e) { /* ignore */ }
    }
  }

  /* 任意页面手动注入时，页面世界没有 rate-lock.js，这里补一次 */
  function ensurePageRateLock() {
    if (window.__DJZK_RATE_MAIN__) return;
    try {
      if (!chrome.runtime || !chrome.runtime.getURL) return;
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('src/rate-lock.js');
      s.async = false;
      s.onload = () => s.remove();
      s.onerror = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* ignore */ }
  }

  function applyPlayback(v) {
    if (!v) return;
    syncRateLock(v);
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

  /* 判定「快播完」：倍速越高，tick 间隔内走过的媒体时间越多，
     窗口要按倍速放大，否则 2× 时容易整段跳过结尾 */
  function nearEnd(v) {
    if (!v || !isFinite(v.duration) || v.duration <= 0) return false;
    const rate = isFinite(v.playbackRate) && v.playbackRate > 0 ? v.playbackRate : 1;
    const win = Math.max(1.5, S.endThreshold || 1.5) * rate + 0.4;
    return v.duration - v.currentTime <= win;
  }

  /* 行是否被折叠隐藏：高度为 0，或祖先 overflow:hidden 且高度极小 */
  function rowCollapsed(li) {
    if (!li || !li.isConnected) return true;
    const r = li.getBoundingClientRect();
    if (r.height < 8) return true;
    for (let el = li; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      if (el !== li && cs.overflow === 'hidden' && el.clientHeight < 10) return true;
    }
    return false;
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

  /* --------- 点睛网播放页右侧目录（真实页面结构） ---------
   * .play_playerMLBox
   *   .courseItem(.playIngCourse)
   *     h3.courseName(.on) > span > a            ← 章节标题，形如「1.1｜…」
   *     .animateH > ul.rightCatalogList
   *       li.hasBuy(.on, data-status="bofang")   ← 小节，点它切视频
   *         p.name.cw[data-id]                   ← 真正绑事件的行
   */
  function zfwxCatalogNext() {
    const box = document.querySelector('.play_playerMLBox');
    if (!box) return null;
    const onCls = (el) => /(^|\s)on(\s|$)/.test(String((el && el.className) || ''));
    const labelOfRow = lessonLabelText;
    const headOf = (item) => (item && (item.querySelector('h3.courseName a') || item.querySelector('h3.courseName'))) || null;
    const firstRowOf = (item) => item && (item.querySelector('.rightCatalogList li p.name') || item.querySelector('.rightCatalogList li'));
    const rows = [...box.querySelectorAll('.rightCatalogList li')];

    let cur = rows.findIndex((li) => onCls(li) || li.getAttribute('data-status') === 'bofang');
    if (cur < 0) {
      const label = pageLessonLabel();
      if (label) cur = rows.findIndex((li) => { const l = lessonLabelOf(li); return l && cmpLabel(l, label) === 0; });
    }
    if (cur < 0) return null;
    const curLabel = labelOfRow(rows[cur]);

    /* 同一章内还有下一条小节 */
    if (cur < rows.length - 1) {
      const next = rows[cur + 1];
      const label = labelOfRow(next);
      if (!rowCollapsed(next)) {
        const row = next.querySelector('p.name') || next.querySelector('a') || next;
        return { el: row, label: label || labelOfRow(row), cur: curLabel, text: textShort(row) };
      }
      const item = next.closest('.courseItem');
      const head = headOf(item);
      if (head) return { el: head, label: label, cur: curLabel, then: () => firstRowOf(item), text: textShort(head) };
    }

    /* 本章最后一条：点下一个 courseItem 的标题 */
    const items = [...box.querySelectorAll('.courseItem')];
    const ci = items.findIndex((el) => el.contains(rows[cur]));
    if (ci >= 0 && ci < items.length - 1) {
      const nx = items[ci + 1];
      const head = headOf(nx);
      const label = labelOfRow(nx.querySelector('h3.courseName') || nx);
      if (head) {
        const row = firstRowOf(nx);
        if (row && !rowCollapsed(row)) return { el: row, label: label, cur: curLabel, text: textShort(row) };
        return { el: head, label: label, cur: curLabel, then: () => firstRowOf(nx), text: textShort(head) };
      }
    }

    /* 目录可能懒加载：滚到底触发一次请求，下次 tick 再看 */
    nudgeCatalogLoad(box);
    return null;
  }

  /* -------------------- 右侧目录（选课）模式 --------------------
   * 点睛云新版播放页把「节」列在右侧目录里，条目标题形如 "1.2 | 公司法的…"。
   * 这里按节号（major.minor）找到当前条目，点它的下一条。 */
  const LESSON_LABEL = /^\s*(\d{1,2})\.(\d{1,2})\s*[|｜]/;

  function lessonLabelOf(el) {
    if (!el) return null;
    const raw = el.textContent || '';
    if (!raw || raw.length > 120) return null;
    const m = LESSON_LABEL.exec(raw);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }

  function cmpLabel(a, b) { return (a[0] - b[0]) || (a[1] - b[1]); }

  function textShort(el, n) {
    return norm((el && (el.innerText || el.textContent)) || '').slice(0, n || 120);
  }

  function lessonLabelText(el) {
    const m = LESSON_LABEL.exec(String((el && el.textContent) || ''));
    return m ? m[1] + '.' + m[2] : '';
  }

  function activeLessonLabel() {
    const sel = '[class*="active"],[class*="current"],[class*="playing"],[aria-current]';
    for (const el of document.querySelectorAll(sel)) {
      if (!isVisible(el)) continue;
      /* 高亮的常常是「问题一」这类小节，往上下找它所属的 1.x 章节 */
      let node = el;
      for (let i = 0; node && i < 5; i++, node = node.parentElement) {
        const l = lessonLabelOf(node);
        if (l) return l;
      }
      for (const c of el.querySelectorAll('*')) {
        const l = lessonLabelOf(c);
        if (l) return l;
      }
    }
    return null;
  }

  function pageLessonLabel() {
    const a = activeLessonLabel();
    if (a) return a;
    const m = /(\d{1,2})\.(\d{1,2})\s*[|｜]/.exec(String(document.title || ''));
    if (m) return [Number(m[1]), Number(m[2])];
    for (const el of document.querySelectorAll('[class*="crumb"],[class*="bread"],[class*="path"],[class*="position"],[class*="nav"]')) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 200) continue;
      const mm = /(\d{1,2})\.(\d{1,2})\s*[|｜]/.exec(t);
      if (mm) return [Number(mm[1]), Number(mm[2])];
    }
    /* 面包屑类名不固定时，再按「含 > 或 › 的短文本」兜底扫一遍 */
    let scanned = 0;
    for (const el of document.querySelectorAll('div,span,p,section,nav')) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 200 || !/[>›»]/.test(t)) continue;
      if (++scanned > 400) break;
      const mm = /(\d{1,2})\.(\d{1,2})\s*[|｜]/.exec(t);
      if (mm) return [Number(mm[1]), Number(mm[2])];
    }
    return null;
  }

  function catalogItems() {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('li,a,div,span,p')) {
      const l = lessonLabelOf(el);
      if (!l || !isVisible(el)) continue;
      let nested = false;
      for (const c of el.children) { if (lessonLabelOf(c)) { nested = true; break; } }
      if (nested) continue;
      const key = l.join('.');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ el, label: l });
    }
    out.sort((a, b) => cmpLabel(a.label, b.label));
    return out;
  }

  function catalogNext() {
    const items = catalogItems();
    if (items.length < 2) return null;
    const cur = pageLessonLabel();
    if (!cur) return null;
    const idx = items.findIndex((it) => cmpLabel(it.label, cur) === 0);
    if (idx < 0 || idx === items.length - 1) return null;
    const nxt = items[idx + 1];
    return { el: nxt.el, label: nxt.label.join('.'), cur: items[idx].label.join('.'), text: textShort(nxt.el) };
  }

  /* 目录是懒加载时，滚到底触发加载 */
  function nudgeCatalogLoad(box) {
    try {
      const list = ['.rightCatalogBox', '.play_playerCont', '.play_playerMLBox'];
      for (const sel of list) {
        const el = box.querySelector(sel) || (sel === '.play_playerMLBox' ? box : null);
        if (!el) continue;
        if (el.scrollHeight > el.clientHeight + 20) {
          el.scrollTop = el.scrollHeight;
          el.dispatchEvent(new Event('scroll', { bubbles: true }));
          return true;
        }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /* 只读：当前节 / 下一节，用于面板与弹窗展示「识别结果」 */
  /* 目录条目文本：去掉 <em>105.1分钟/2.33课时</em> 这类时长尾巴 */
  function cleanItemText(el) {
    const src = (el && el.querySelector && el.querySelector('p.name')) || el;
    if (!src) return '';
    let t = '';
    for (const n of src.childNodes) {
      if (n.nodeType === 3) t += n.nodeValue;
      else if (n.tagName === 'SPAN' || n.tagName === 'A') t += n.textContent || '';
    }
    return norm(t || src.textContent || '').slice(0, 90);
  }

  /* 整个目录（按播放顺序），并标出当前项——给「后续待听」列表用 */
  function stripLabel(label, text) {
    if (!label) return text || '';
    const esc = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return String(text || '').replace(new RegExp('^' + esc + '\\s*[|｜]?\\s*'), '');
  }

  function catalogSeries() {
    const on = (el) => /(^|\s)on(\s|$)/.test(String((el && el.className) || '')) ||
      (el && el.getAttribute('data-status') === 'bofang');
    const items = [];
    const box = document.querySelector('.play_playerMLBox');
    if (box) {
      for (const ci of box.querySelectorAll('.courseItem')) {
        const rows = [...ci.querySelectorAll('.rightCatalogList li')];
        if (rows.length) {
          for (const li of rows) items.push({ label: lessonLabelText(li), text: cleanItemText(li), active: on(li) });
        } else {
          const head = ci.querySelector('h3.courseName') || ci.querySelector('h3');
          if (head) items.push({ label: lessonLabelText(head), text: cleanItemText(head), active: on(head) });
        }
      }
      if (items.length) {
        const indexed = items.map((it, i) => ({ label: it.label, text: it.text, active: it.active, i }));
        const first = indexed.findIndex((x) => x.active);
        return { items: indexed.map(({ label, text }) => ({ label, text })), curIndex: first };
      }
    }
    /* 通用目录：所有「1.2」这类编号条目，按编号排序 */
    const seen = new Set();
    const list = [];
    for (const el of document.querySelectorAll('li,a,div,span,p')) {
      const l = lessonLabelOf(el);
      if (!l) continue;
      let nested = false;
      for (const c of el.children) { if (lessonLabelOf(c)) { nested = true; break; } }
      if (nested) continue;
      const key = l.join('.');
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ l, label: l.join('.'), text: cleanItemText(el) });
    }
    list.sort((a, b) => cmpLabel(a.l, b.l));
    let curIndex = -1;
    const cur = pageLessonLabel();
    if (cur) curIndex = list.findIndex((x) => cmpLabel(x.l, cur) === 0);
    return { items: list.map(({ label, text }) => ({ label, text })), curIndex };
  }

  function catalogPeek() {
    try {
      const series = catalogSeries();
      const items = series.items || [];
      const curIndex = series.curIndex;
      const curItem = items[curIndex];
      const rest = curIndex >= 0 ? items.slice(curIndex + 1) : items.slice();
      const zf = document.querySelector('.play_playerMLBox') ? zfwxCatalogNext() : null;
      const g = zf ? null : catalogNext();
      return {
        cur: (curItem && curItem.label) || (pageLessonLabel() || []).join('.'),
        next: (zf && zf.label) || (g && g.label) || (rest[0] && rest[0].label) || '',
        nextText: (zf && zf.text) || (g && g.text) || (rest[0] && rest[0].text) || '',
        upcoming: rest.slice(0, 80),
        upcomingTotal: rest.length,
        curIndex
      };
    } catch (e) {
      return { cur: '', next: '', nextText: '', upcoming: [], upcomingTotal: 0, curIndex: -1 };
    }
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

    /* 点睛网播放页的右侧目录（真实结构），优先级仅次于手动拾取 */
    try {
      const zf = zfwxCatalogNext();
      if (zf && zf.el) out.push({ el: zf.el, pri: -6, tag: '目录 ' + (zf.label || '下一节'), then: zf.then });
    } catch (e) { /* ignore */ }

    /* 其他站点的通用目录模式 */
    try {
      const cat = catalogNext();
      if (cat) out.push({ el: clickableOf(cat.el) || cat.el, pri: -5, tag: '目录 ' + cat.label });
    } catch (e) { /* ignore */ }

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
      if (queuePending().length && queueGotoList()) return true;
      msg = '没找到「下一节」按钮 → 用面板上的「拾取」点一下它';
      return false;
    }
    nextTries += 1;
    const cand = cands[0];
    const target = cand.el;
    msg = '点击下一节：' + (cand.tag || target.tagName.toLowerCase());
    clickEl(target);
    /* 章节是折叠的：先点标题展开，再点小节 */
    if (typeof cand.then === 'function') {
      setTimeout(() => {
        try {
          const el = cand.then();
          if (el && el.isConnected) {
            msg = '已展开章节，正在点小节';
            clickEl(el);
            report(true);
          }
        } catch (e) { /* ignore */ }
      }, 900);
    }
    if (countedSig !== videoSig && videoSig) {
      countedSig = videoSig;
      lessonsDone += 1;
    }
    if (nextTries >= 3) {
      if (queuePending().length && queueGotoList()) return true;
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

  /* ------------------------- 课程列表页：采集队列 + 连播 ------------------------- */
  const QUEUE_KEY = 'djzk_queue';
  let queue = { url: '', at: 0, items: [], curKey: '' };
  let queueLoaded = false;
  let listPageAt = 0;
  let lastQueueClickAt = 0;
  let harvesting = false;

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  function isCourseListPage() {
    if (!IS_TOP) return false;
    const box = document.querySelector('.courseList');
    if (!box) return false;
    return !!box.querySelector('.videoList, .courseDetail');
  }

  function loadQueue(cb) {
    if (queueLoaded) { if (cb) cb(); return; }
    queueLoaded = true;
    try {
      chrome.storage.local.get({ [QUEUE_KEY]: null }, (res) => {
        const q = res && res[QUEUE_KEY];
        if (q && Array.isArray(q.items)) {
          queue = { url: q.url || '', at: q.at || 0, items: q.items, curKey: q.curKey || '' };
        }
        if (cb) cb();
      });
    } catch (e) { if (cb) cb(); }
  }

  function saveQueue(cb) {
    try { chrome.storage.local.set({ [QUEUE_KEY]: queue }, cb || (() => {})); } catch (e) { if (cb) cb(); }
  }

  function courseTitleOf(vl) {
    const hid = vl.closest('.courseHid');
    const scope = hid || vl.closest('.courseDetail');
    const el = scope && scope.querySelector('.className.classTitle');
    return el ? norm(el.getAttribute('title') || el.textContent).slice(0, 80) : '';
  }

  /* 列表上的「问题/小节」行：.courseVideo>.videoList，含进度百分比 */
  function listRows() {
    const rows = [];
    const seen = new Set();
    for (const vl of document.querySelectorAll('.courseList .videoList')) {
      const nameEl = vl.querySelector('.className');
      const title = nameEl ? norm(nameEl.textContent).slice(0, 120) : '';
      if (!title) continue;
      const course = courseTitleOf(vl);
      const key = course + '||' + title;
      if (seen.has(key)) continue;
      seen.add(key);
      const pctEl = vl.querySelector('.progress_num');
      let pct = parseInt(String((pctEl && pctEl.textContent) || '').replace(/[^\d]/g, ''), 10);
      if (!isFinite(pct)) pct = 0;
      rows.push({ el: vl, key, course, title, pct: Math.max(0, Math.min(100, pct)) });
    }
    return rows;
  }

  function queuePending() {
    return (queue.items || []).filter((it) => !it.done);
  }

  /* 点击课件标题/打开套课，触发 Angular 把 video[courseId] 拉回来 */
  async function harvestQueue() {
    if (!isCourseListPage()) { msg = '当前不是课程列表页'; render(); return { items: [], total: 0, pending: 0 }; }
    if (harvesting) return { items: queuePending(), total: (queue.items || []).length, pending: queuePending().length };
    harvesting = true;
    try {
      loadQueue();
      msg = '扫描列表：正在展开套课与小节…';
      render(); report();
      for (let round = 0; round < 4; round++) {
        const blanks = [];
        for (const cd of document.querySelectorAll('.courseList .courseDetail')) {
          const own = cd.querySelector(':scope > .courseVideo');
          if (own && !own.querySelector('.videoList')) {
            const t = cd.querySelector(':scope > .className.classTitle');
            if (t) blanks.push(t);
          }
          for (const hid of cd.querySelectorAll('.courseHid')) {
            const cv = hid.querySelector(':scope > .courseVideo');
            if (cv && !cv.querySelector('.videoList')) {
              const t = hid.querySelector('.className.classTitle');
              if (t) blanks.push(t);
            }
          }
        }
        const live = blanks.filter((el) => el.isConnected);
        if (!live.length) break;
        for (const el of live.slice(0, 8)) { clickEl(el); await sleepMs(500); }
      }
      const rows = listRows();
      const items = rows.filter((r) => r.pct < 100)
        .map((r) => ({ key: r.key, course: r.course, title: r.title, pct: r.pct, done: false }));
      queue = { url: location.href, at: now(), items, curKey: queue.curKey || '' };
      saveQueue();
      msg = '扫描完成：本页 ' + rows.length + ' 个视频，' + items.length + ' 个未听完，已放入待听队列';
      render(); report(true);
      return { items, total: rows.length, pending: items.length };
    } finally {
      harvesting = false;
    }
  }

  /* 点队列里的下一条：重新从 DOM 读进度，已 100% 的直接标记完成 */
  function queueNext() {
    const pend = queuePending();
    if (!pend.length) return false;
    const rows = listRows();
    for (const it of pend) {
      const row = rows.find((r) => r.key === it.key) || null;
      if (row && row.pct >= 100) { it.done = true; saveQueue(); continue; }
      if (!row) { it.done = true; msg = '队列项在当前页找不到，已跳过：' + it.title.slice(0, 20); saveQueue(); continue; }
      const btn = row.el.querySelector('.player') || row.el.querySelector('.className');
      if (!btn) { it.done = true; saveQueue(); continue; }
      queue.curKey = it.key;
      saveQueue();
      lastQueueClickAt = now();
      msg = '列表连播：进入「' + it.title.slice(0, 30) + '」';
      render();
      clickEl(btn);
      return true;
    }
    return false;
  }

  /* 本课程已经在播放页听完 → 记完成，回列表播下一条 */
  function queueGotoList() {
    const cur = (queue.items || []).find((it) => it.key === queue.curKey);
    if (cur && !cur.done) { cur.done = true; saveQueue(); }
    const pend = queuePending();
    const url = queue.url || '';
    if (!pend.length) {
      msg = '待听队列已全部播完 🎉';
      render(); report(true);
      return false;
    }
    if (!url) { msg = '队列里还有 ' + pend.length + ' 条，但没有列表页地址'; render(); return false; }
    msg = '本课程已听完，回列表继续队列（剩 ' + pend.length + ' 条）…';
    render(); report(true);
    setTimeout(() => { location.href = url; }, 1500);
    return true;
  }

  /* ------------------------- 主循环 ------------------------- */
  function tick() {
    if (!S.enabled) { render(); report(); return; }

    /* 听课中心/课程列表页：没有视频，走队列连播 */
    if (isCourseListPage()) {
      if (!listPageAt) listPageAt = now();
      loadQueue();
      const pend = queuePending();
      if (S.listRun && pend.length && now() - listPageAt > 2500 && now() - lastQueueClickAt > 20000) {
        queueNext();
      }
      render();
      report();
      return;
    }

    const v = pickVideo();
    noteVideo(v);

    if (v) {
      applyPlayback(v);
      /* 播放器播完后常把 currentTime 归零而不是置 ended，这里用「进度回跳」兜住 */
      const dur = v.duration;
      const backJump = isFinite(dur) && dur > 10 && prevCur > dur * 0.85 && v.currentTime < 1.5 && !v.paused;
      if (v.ended || nearEnd(v) || backJump) scheduleNext();
      prevCur = isFinite(v.currentTime) ? v.currentTime : 0;
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
    const peek = catalogPeek();
    const cur = v ? (v.currentTime || 0) : 0;
    const dur = v ? (isFinite(v.duration) ? v.duration : 0) : 0;
    let upcoming = peek.upcoming || [];
    let upcomingTotal = peek.upcomingTotal || 0;
    let listMode = false;
    let queueTotal = 0;
    let queueDone = 0;
    if (isCourseListPage()) {
      loadQueue();
      listMode = true;
      const pend = queuePending();
      queueTotal = (queue.items || []).length;
      queueDone = queueTotal - pend.length;
      upcoming = pend.slice(0, 80).map((it) => ({ label: it.course || '目录', text: it.title }));
      upcomingTotal = pend.length;
    }
    return {
      v: VERSION,
      top: IS_TOP,
      href: location.href,
      host: location.hostname,
      title: String(document.title || '').slice(0, 140),
      videoSrc: v ? String(v.currentSrc || v.src || '').slice(0, 300) : '',
      catalogCur: peek.cur,
      catalogNext: peek.next,
      nextText: peek.nextText || (listMode ? (upcoming[0] && upcoming[0].text) || '' : ''),
      upcoming,
      upcomingTotal,
      listMode,
      queueTotal,
      queueDone,
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
    if (cmd === 'scan') harvestQueue();
    if (cmd === 'go') queueNext();
  }

  function saveSettings(patch) {
    S = Object.assign({}, S, patch);
    if (patch && 'rate' in patch) S.rate = clampRate(S.rate);
    S.forceRate = !!S.forceRate;
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
        .meta{font-size:10px;color:#6c7fa3;margin:0 0 8px}
        .mrow{display:flex;gap:5px;line-height:1.55}
        .mrow i{font-style:normal;flex:none;color:#7e8fb3}
        .mrow span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .up{margin:0 0 8px}
        .up-h{display:flex;justify-content:space-between;font-size:10px;color:#7e8fb3;margin-bottom:3px}
        .up-h b{font-weight:500;color:#6d80a2}
        .up-list{list-style:none;margin:0;padding:0;max-height:132px;overflow:auto;font-size:10.5px;line-height:1.5}
        .up-list li{display:flex;gap:4px;padding:1px 0;color:#a9b8d4}
        .up-list li b{flex:none;color:#6d80a2;font-weight:500;min-width:22px}
        .up-list li span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .up-list li:first-child{color:#8fe9cd}
        .up-list .none{color:#5f7091}
        .rowbtns{display:flex;gap:6px;margin-bottom:8px}
        .rowbtns[hidden]{display:none}
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
          <div class="meta">
            <div class="mrow"><i>标题</i><span data-f="title">—</span></div>
            <div class="mrow"><i>待听</i><span data-f="nextText">—</span></div>
            <div class="mrow"><i>目录</i><span data-f="catalog">—</span></div>
            <div class="mrow"><i>视频</i><span data-f="videoSrc">—</span></div>
            <div class="mrow"><i>地址</i><span data-f="href">—</span></div>
          </div>
          <div class="up">
            <div class="up-h"><i>后续待听</i><b data-f="upCount">—</b></div>
            <ol class="up-list" data-f="upList"></ol>
          </div>
          <div class="rowbtns">
            <button class="b" data-act="next">立即下一节</button>
            <button class="b" data-act="pick">拾取「下一节」</button>
          </div>
          <div class="rowbtns" data-f="scanRow" hidden>
            <button class="b" data-act="scan">扫描列表排队</button>
            <button class="b" data-act="go">开始连播</button>
          </div>
          <div class="sec">
            <button class="tag" data-t="autoPlay">自动播放</button>
            <button class="tag" data-t="autoNext">自动下一节</button>
            <button class="tag" data-t="autoMute">静音</button>
            <button class="tag" data-t="forceRate">强制倍速</button>
            <button class="tag" data-t="pauseOnQuiz">弹题暂停</button>
          </div>
          <div class="rate">
            <button class="b" data-act="rate-">−</button>
            <span class="val" data-f="rate">1.5×</span>
            <button class="b" data-act="rate+">＋</button>
          </div>
          <div class="ft">
            <span data-f="lessons">本次 0 节</span>
          </div>
        </div>
      </div>`;

    const wrap = root.querySelector('.wrap');
    const $ = (sel) => root.querySelector(sel);
    let lastUpSig = null;

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
        const tEl = $('[data-f="title"]');
        tEl.textContent = st.title || '—';
        tEl.title = st.title || '';
        const hEl = $('[data-f="href"]');
        hEl.textContent = st.href || '—';
        hEl.title = st.href || '';
        const nEl = $('[data-f="nextText"]');
        nEl.textContent = st.nextText || '—';
        nEl.title = st.nextText || '';
        const vEl = $('[data-f="videoSrc"]');
        vEl.textContent = st.videoSrc || '—';
        vEl.title = st.videoSrc || '';
        const cEl = $('[data-f="catalog"]');
        const catText = [st.catalogCur && ('当前 ' + st.catalogCur), st.catalogNext && ('下一节 ' + st.catalogNext)]
          .filter(Boolean).join(' → ');
        cEl.textContent = catText || '—';
        cEl.title = catText;
        const ups = Array.isArray(st.upcoming) ? st.upcoming : [];
        const upSig = ups.map((u) => (u.label || '') + '|' + (u.text || '')).join('~');
        if (upSig !== lastUpSig) {
          lastUpSig = upSig;
          const ol = $('[data-f="upList"]');
          ol.textContent = '';
          if (!ups.length) {
            const li = document.createElement('li');
            li.className = 'none';
            li.textContent = st.hasVideo ? '没有更多待听条目（或未识别到目录）' : '未检测到视频';
            ol.appendChild(li);
          }
          for (const u of ups) {
            const li = document.createElement('li');
            const b = document.createElement('b');
            b.textContent = u.label || '';
            const sp = document.createElement('span');
            sp.textContent = stripLabel(u.label, u.text);
            sp.title = u.text || '';
            li.appendChild(b);
            li.appendChild(sp);
            ol.appendChild(li);
          }
        }
        const upCount = st.upcomingTotal || ups.length;
        $('[data-f="upCount"]').textContent = st.listMode
          ? (upCount ? (upCount + ' 条') : (st.queueTotal ? '0 条（共 ' + st.queueTotal + '）' : '未排队'))
          : (upCount ? upCount + ' 节' : '—');
        const scanRow = $('[data-f="scanRow"]');
        if (scanRow) scanRow.hidden = !st.listMode;
        $('[data-f="upCount"]').title = ups.length < upCount ? '仅列出前 ' + ups.length + ' 节' : '';
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
        case 'scan': sendCmd('scan'); break;
        case 'go': sendCmd('go'); break;
        case 'rate-': saveSettings({ rate: stepRate(S.rate, -1) }); break;
        case 'rate+': saveSettings({ rate: stepRate(S.rate, 1) }); break;
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

  const RATES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];
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
      else if (m.cmd === 'scan') harvestQueue();
      else if (m.cmd === 'go') queueNext();
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
      ensurePageRateLock();
      loadQueue();
      applyToDom();
      timer = setInterval(tick, 600);
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

  /* 隔离世界的弱兜底：只影响本插件自己读写；真正的强制倍速在 src/rate-lock.js
     （manifest 以 world:"MAIN" 注入页面世界） */
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
    nearEnd, rowCollapsed, tick, clampRate,
    isCourseListPage, listRows, harvestQueue, queueNext, queueGotoList, get queue() { return queue; },
    get settings() { return S; },
    get msg() { return msg; }
  };
})();
