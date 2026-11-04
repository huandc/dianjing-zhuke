/* 点睛网自动刷课助手 —— 弹窗 */

const DEFAULTS = {
  enabled: true,
  autoPlay: true,
  autoNext: true,
  autoMute: true,
  rate: 1.5,
  forceRate: false,
  endThreshold: 1.5,
  nextDelayMinMs: 4000,
  nextDelayMaxMs: 6000,
  autoList: false,
  listRun: true,
  sameTab: true,
  pauseOnQuiz: true,
  beep: true,
  showPanel: true,
  panelPos: null,
  customSelectors: []
};
const RATES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let settings = Object.assign({}, DEFAULTS);
let tab = null;
let lastState = null;

function fmt(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
}

function fmtRate(r) {
  return String(Number(r).toFixed(2)).replace(/0+$/, '').replace(/\.$/, '') + '×';
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 1800);
}

function fmtSecText(ms) {
  return String(Math.round(ms / 100) / 10).replace(/\.0$/, '');
}

/* 与 content.js 同口径：旧版固定延迟迁移成区间 */
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

/* 兼容旧版固定值 nextDelayMs */
function delayRange() {
  let lo = Number(settings.nextDelayMinMs);
  let hi = Number(settings.nextDelayMaxMs);
  if (!isFinite(lo)) lo = Number(settings.nextDelayMs);
  if (!isFinite(lo)) lo = 4000;
  if (!isFinite(hi)) hi = lo + 2000;
  lo = Math.min(Math.max(lo, 0), 300000);
  hi = Math.min(Math.max(hi, 0), 300000);
  if (hi < lo) { const t = lo; lo = hi; hi = t; }
  return [lo, hi];
}

async function save(patch) {
  settings = Object.assign({}, settings, patch);
  if (patch && 'rate' in patch) settings.rate = clampRate(settings.rate);
  await chrome.storage.local.set({ djzk_settings: settings });
  renderControls();
}

function renderControls() {
  $('#enabled').checked = !!settings.enabled;
  ['autoPlay', 'autoNext', 'autoMute', 'pauseOnQuiz', 'autoList', 'listRun', 'sameTab', 'showPanel', 'forceRate']
    .forEach((k) => { $('#' + k).checked = !!settings[k]; });
  const [lo, hi] = delayRange();
  $('#nextDelayMin').value = String(Math.round(lo / 100) / 10);
  $('#nextDelayMax').value = String(Math.round(hi / 100) / 10);
  $('#waitHint').textContent = lo === hi
    ? '播完后等 ' + fmtSecText(lo) + ' 秒进入下一节'
    : '每次在 ' + fmtSecText(lo) + '–' + fmtSecText(hi) + ' 秒之间随机等待后进入下一节';

  const box = $('#rates');
  box.innerHTML = '';
  for (const r of RATES) {
    const b = document.createElement('button');
    b.textContent = fmtRate(r);
    b.className = Math.abs(r - settings.rate) < 0.01 ? 'on' : '';
    b.addEventListener('click', () => save({ rate: r }));
    box.appendChild(b);
  }
  const custom = $('#rateCustom');
  if (custom && document.activeElement !== custom) custom.value = String(Math.round(settings.rate * 100) / 100);

  const picked = $('#picked');
  const list = settings.customSelectors || [];
  picked.innerHTML = '';
  if (!list.length) {
    picked.innerHTML = '<span class="empty">还没有拾取</span>';
  } else {
    list.forEach((item, i) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      const label = (item && (item.text || item.sel)) || String(item);
      tag.textContent = item && item.host ? label : label;
      tag.title = (item && item.sel) || String(item);
      const x = document.createElement('i');
      x.textContent = '×';
      x.addEventListener('click', () => {
        const next = list.slice();
        next.splice(i, 1);
        save({ customSelectors: next });
      });
      tag.appendChild(x);
      picked.appendChild(tag);
    });
  }
}

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

function setPill(text, cls) {
  const p = $('#statePill');
  p.textContent = text;
  p.className = 'pill' + (cls ? ' ' + cls : '');
}

let lastUpSig = null;

function stripLabel(label, text) {
  if (!label) return text || '';
  const esc = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text || '').replace(new RegExp('^' + esc + '\\s*[|｜]?\\s*'), '');
}

/* 「1.2｜xxx」去掉重复的编号前缀 */


/* 「后续待听」列表：只在不变化时跳过重建，避免每秒重排 */
function renderUpcoming(st) {
  const ups = Array.isArray(st && st.upcoming) ? st.upcoming : [];
  const total = st && st.upcomingTotal != null ? st.upcomingTotal : ups.length;
  const ol = $('#upList');
  const empty = $('#upEmpty');
  ol.hidden = !ups.length;
  empty.hidden = !!ups.length;

  const sig = ups.map((u) => (u.label || '') + '|' + (u.text || '')).join('~');
  if (sig === lastUpSig) {
    $('#upCount').textContent = total ? total + ' 节' : '—';
    return;
  }
  lastUpSig = sig;
  ol.textContent = '';
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
  $('#upCount').textContent = total ? total + ' 节' : '—';
  $('#upCount').title = ups.length < total ? '只列出前 ' + ups.length + ' 节' : '';
}

function renderState(rec) {
  lastState = rec && rec.state ? rec.state : null;
  const st = lastState;
  $('#injectBtn').hidden = !!st;

  if (!st) {
    setPill('未连接');
    $('#host').textContent = tab ? shortHost(tab.url) : '—';
    $('#bar').style.width = '0%';
    $('#pct').textContent = '0%';
    $('#time').textContent = '00:00';
    $('#rateNow').textContent = fmtRate(settings.rate);
    $('#lessons').textContent = '0';
    ['pgTitle', 'pgNext', 'pgCatalog', 'pgVideo', 'pgHref'].forEach((id) => { const el = $('#' + id); el.textContent = '—'; el.title = ''; });
    renderUpcoming(null);
    $('#hint').textContent = tab && /^chrome-extension:/.test(tab.url)
      ? '这是设置页，打开点睛网听课页面即可看到实时状态。'
      : '当前页面没有运行脚本（可能不在点睛网，或需要刷新页面）。';
    return;
  }

  $('#host').textContent = st.host || shortHost(st.href);
  $('#bar').style.width = (st.pct || 0) + '%';
  $('#pct').textContent = (st.pct || 0) + '%';
  $('#time').textContent = fmt(st.cur) + ' / ' + fmt(st.dur);
  $('#rateNow').textContent = fmtRate(st.rate || settings.rate);
  $('#lessons').textContent = String(st.lessons || 0);

  if (st.listMode) setPill(st.upcomingTotal ? '课程列表 · 待听 ' + st.upcomingTotal : '课程列表', st.upcomingTotal ? 'on' : 'warn');
  else if (st.quiz) setPill('等待答题', 'warn');
  else if (!st.hasVideo) setPill('未检测到视频', 'warn');
  else if (st.ended) setPill('已播完', 'warn');
  else if (st.playing) setPill('播放中', 'on');
  else setPill('已暂停', 'warn');

  $('#pgTitle').textContent = st.title || '—';
  $('#pgTitle').title = st.title || '';
  $('#pgNext').textContent = st.nextText || '—';
  $('#pgNext').title = st.nextText || '';
  $('#pgHref').textContent = st.href || '—';
  $('#pgHref').title = st.href || '';
  $('#pgVideo').textContent = st.videoSrc || '—';
  $('#pgVideo').title = st.videoSrc || '';
  let cat = [st.catalogCur && ('当前 ' + st.catalogCur), st.catalogNext && ('下一节 ' + st.catalogNext)]
    .filter(Boolean).join(' → ');
  if (st.listMode) {
    cat = '队列 ' + (st.upcomingTotal || 0) + ' 条待听 / 共 ' + (st.queueTotal || 0) + ' 条（已完成 ' + (st.queueDone || 0) + '）';
  }
  $('#pgCatalog').textContent = cat || '—';
  $('#pgCatalog').title = cat;

  renderUpcoming(st);

  const parts = [];
  if (!st.enabled) parts.push('总开关已关闭');
  else if (st.listMode && !st.queueTotal) parts.push('点「扫描列表排队」收集未听完的课程');
  else if (st.msg) parts.push(st.msg);
  if (st.nextIn > 0) parts.push(st.nextIn + ' 秒后进入下一节');
  $('#hint').textContent = parts.join(' · ') || '运行中';
}

function shortHost(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 1 ? u.pathname.slice(0, 22) : '');
  } catch (e) { return url || '—'; }
}

async function poll() {
  if (!tab || tab.id == null) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DJZK_TAB_STATE', tabId: tab.id });
    renderState(res && res.rec ? res.rec : null);
  } catch (e) {
    setPill('后台未响应', 'err');
  }
}

async function cmd(name) {
  try {
    await chrome.runtime.sendMessage({ type: 'DJZK_CMD_REQ', cmd: name, tabId: tab && tab.id });
    const tip = {
      next: '已发送「下一节」',
      pick: '请在页面上点『下一节』按钮',
      scan: '正在扫描课程列表，稍等…',
      go: '已开始按队列连播'
    };
    toast(tip[name] || '已发送');
  } catch (e) {
    toast('当前页没有运行脚本');
  }
}

async function inject() {
  if (!tab || tab.id == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => { window.__DJZK_FORCE__ = true; }
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['src/content.js']
    });
    toast('已注入，正在刷新状态…');
    setTimeout(poll, 600);
  } catch (e) {
    toast('注入失败：' + (e && e.message ? e.message : '没有该页面权限'));
  }
}

async function showStats() {
  const { djzk_stats } = await chrome.storage.local.get({ djzk_stats: null });
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const today = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  const n = djzk_stats && djzk_stats.date === today ? djzk_stats.lessons : 0;
  toast('今日已自动跳过 ' + n + ' 节');
}

/* 在页面 MAIN world 里跑，采集右侧目录与高亮项（函数体必须自包含） */
function collectPageDiag() {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => {
    const t = norm(el.textContent || '');
    const m = /^(\d{1,2}\.\d{1,2})\s*[|｜]/.exec(t);
    return m ? m[1] : '';
  };
  const desc = (el) => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className || '').slice(0, 120),
    text: norm(el.textContent || '').slice(0, 80)
  });
  const html = (el) => String(el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 280);

  const catalog = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('li,a,div,span,p,dt,dd,h3,h4')) {
    const l = labelOf(el);
    if (!l || seen.has(l)) continue;
    let nested = false;
    for (const c of el.children) { if (labelOf(c)) { nested = true; break; } }
    if (nested) continue;
    seen.add(l);
    const r = el.getBoundingClientRect();
    catalog.push(Object.assign({ label: l, html: html(el), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }, desc(el)));
    if (catalog.length >= 12) break;
  }

  const active = [];
  for (const el of document.querySelectorAll('[class*="active"],[class*="current"],[class*="playing"],[aria-current]')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    active.push(Object.assign({ html: html(el) }, desc(el)));
    if (active.length >= 8) break;
  }

  const v = document.querySelector('video');
  return {
    url: location.href,
    title: document.title,
    video: v ? { src: String(v.currentSrc || v.src || '').slice(0, 160), dur: v.duration } : null,
    catalog,
    active
  };
}

async function copyPageDiag() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) { toast('没有活动标签页'); return; }
  let data = null;
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: collectPageDiag });
    data = res && res[0] && res[0].result;
  } catch (e) {
    toast('读取失败：' + (e && e.message ? e.message : e));
    return;
  }
  if (!data) { toast('没读到页面信息（可能是 chrome:// 页面）'); return; }
  const text = JSON.stringify(data, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast('页面结构已复制，直接粘贴给对方即可');
  } catch (e) {
    const box = $('#diagText');
    box.hidden = false;
    box.value = text;
    box.focus();
    box.select();
    toast('已填入下方文本框，Cmd/Ctrl+C 复制');
  }
}

async function init() {
  tab = await activeTab();
  const res = await chrome.storage.local.get({ djzk_settings: DEFAULTS });
  settings = mergeSettings(res.djzk_settings);
  renderControls();

  $('#enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  ['autoPlay', 'autoNext', 'autoMute', 'pauseOnQuiz', 'autoList', 'listRun', 'sameTab', 'showPanel', 'forceRate']
    .forEach((k) => $('#' + k).addEventListener('change', (e) => save({ [k]: e.target.checked })));
  const onDelay = (which) => {
    const [curLo, curHi] = delayRange();
    const read = (id, fallback) => {
      const raw = $('#' + id).value.trim();
      const v = Number(raw);
      return raw === '' || !isFinite(v) ? fallback : Math.min(Math.max(v, 0), 300) * 1000;
    };
    let lo = read('nextDelayMin', curLo);
    let hi = read('nextDelayMax', curHi);
    if (lo > hi) {
      if (which === 'min') hi = lo;
      else lo = hi;
    }
    save({ nextDelayMinMs: lo, nextDelayMaxMs: hi });
  };
  const applyCustomRate = () => {
    const el = $('#rateCustom');
    const n = Number(el.value);
    if (!isFinite(n) || n <= 0) { el.value = String(settings.rate); return; }
    save({ rate: clampRate(n) }).then(() => { el.value = String(settings.rate); });
  };
  $('#rateCustom').addEventListener('change', applyCustomRate);
  $('#rateCustom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyCustomRate(); }
  });

  $('#nextDelayMin').addEventListener('change', () => onDelay('min'));
  $('#nextDelayMax').addEventListener('change', () => onDelay('max'));
  $('#nextBtn').addEventListener('click', () => cmd('next'));
  $('#pickBtn').addEventListener('click', () => cmd('pick'));
  $('#scanBtn').addEventListener('click', () => cmd('scan'));
  $('#courseBtn').addEventListener('click', () => cmd('course'));
  $('#goBtn').addEventListener('click', () => cmd('go'));
  $('#injectBtn').addEventListener('click', inject);
  $('#statsBtn').addEventListener('click', showStats);
  $('#diagBtn').addEventListener('click', () => { copyPageDiag().catch((e) => toast('出错：' + (e && e.message ? e.message : e))); });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.djzk_settings) {
      settings = mergeSettings(changes.djzk_settings.newValue);
      renderControls();
    }
  });

  poll();
  setInterval(poll, 1000);
}

init();
