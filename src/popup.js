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
  pauseOnQuiz: true,
  beep: true,
  showPanel: true,
  panelPos: null,
  customSelectors: []
};
const RATES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];

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
function mergeSettings(raw) {
  raw = raw || {};
  const out = Object.assign({}, DEFAULTS, raw);
  if (raw.nextDelayMinMs == null && raw.nextDelayMaxMs == null && typeof raw.nextDelayMs === 'number') {
    out.nextDelayMinMs = raw.nextDelayMs;
    out.nextDelayMaxMs = raw.nextDelayMs + 2000;
  }
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
  await chrome.storage.local.set({ djzk_settings: settings });
  renderControls();
}

function renderControls() {
  $('#enabled').checked = !!settings.enabled;
  ['autoPlay', 'autoNext', 'autoMute', 'pauseOnQuiz', 'autoList', 'showPanel', 'forceRate']
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

  if (st.quiz) setPill('等待答题', 'warn');
  else if (!st.hasVideo) setPill('未检测到视频', 'warn');
  else if (st.ended) setPill('已播完', 'warn');
  else if (st.playing) setPill('播放中', 'on');
  else setPill('已暂停', 'warn');

  const parts = [];
  if (!st.enabled) parts.push('总开关已关闭');
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
    toast(name === 'next' ? '已发送「下一节」' : '请在页面上点『下一节』按钮');
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

async function init() {
  tab = await activeTab();
  const res = await chrome.storage.local.get({ djzk_settings: DEFAULTS });
  settings = mergeSettings(res.djzk_settings);
  renderControls();

  $('#enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  ['autoPlay', 'autoNext', 'autoMute', 'pauseOnQuiz', 'autoList', 'showPanel', 'forceRate']
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
  $('#nextDelayMin').addEventListener('change', () => onDelay('min'));
  $('#nextDelayMax').addEventListener('change', () => onDelay('max'));
  $('#nextBtn').addEventListener('click', () => cmd('next'));
  $('#pickBtn').addEventListener('click', () => cmd('pick'));
  $('#injectBtn').addEventListener('click', inject);
  $('#statsBtn').addEventListener('click', showStats);

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
