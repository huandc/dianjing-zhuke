/* 点睛网自动刷课助手 —— service worker
 * 职责：汇总各标签页/各 frame 的状态、给 popup 查询、把命令路由到真正有视频的 frame、
 *       维护角标与“今日自动跳过节数”统计。
 */

const DEFAULTS = {
  enabled: true,
  autoPlay: true,
  autoNext: true,
  autoMute: true,
  rate: 1.5,
  forceRate: true,
  endThreshold: 1.5,
  nextDelayMinMs: 4000,
  nextDelayMaxMs: 6000,
  autoList: false,
  listRun: true,
  sameTab: true,
  queueStrict: true,
  pauseOnQuiz: true,
  beep: true,
  showPanel: true,
  panelPos: null,
  customSelectors: []
};

/** tabId -> { state, videoFrameId, since, stale } */
const tabState = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get({ djzk_settings: null, djzk_stats: null });
  if (!cur.djzk_settings) await chrome.storage.local.set({ djzk_settings: DEFAULTS });
  if (!cur.djzk_stats) await chrome.storage.local.set({ djzk_stats: { date: today(), lessons: 0 } });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
});

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function safeSend(tabId, msg, opts, cb) {
  try {
    chrome.tabs.sendMessage(tabId, msg, opts || {}, () => {
      void chrome.runtime.lastError;
      if (cb) cb();
    });
  } catch (e) { /* ignore */ }
}

async function countLessons(prev, next) {
  if (typeof next !== 'number' || typeof prev !== 'number') return;
  const diff = next - prev;
  if (diff <= 0 || diff > 20) return;
  const { djzk_stats } = await chrome.storage.local.get({ djzk_stats: { date: today(), lessons: 0 } });
  const stats = (!djzk_stats || djzk_stats.date !== today())
    ? { date: today(), lessons: 0 }
    : djzk_stats;
  stats.lessons += diff;
  await chrome.storage.local.set({ djzk_stats: stats });
}

function setBadge(tabId, state) {
  const text = state && state.enabled ? 'ON' : '';
  try {
    chrome.action.setBadgeText({ tabId, text });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#2fbf71' });
  } catch (e) { /* ignore */ }
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || !m.type) return;

  if (m.type === 'DJZK_REPORT') {
    const tab = sender.tab;
    if (!tab || tab.id == null) return;
    const tabId = tab.id;
    const frameId = sender.frameId || 0;
    const rec = tabState.get(tabId) || { state: null, videoFrameId: null, since: Date.now() };
    const st = m.state || {};

    if (st.hasVideo) {
      /* 只在同一段视频的连续上报之间累计，避免切换视频时把计数冲高 */
      if (rec.state && rec.state.hasVideo) countLessons(rec.state.lessons, st.lessons);
      rec.state = st;
      rec.videoFrameId = frameId;
      rec.since = Date.now();
      rec.stale = 0;
    } else if (frameId === rec.videoFrameId && rec.state && rec.state.hasVideo) {
      /* 视频所在的 frame 报告“没有视频了” → 这一节结束或页面切换 */
      rec.state = st;
      rec.videoFrameId = null;
      rec.since = Date.now();
    } else if (!rec.state || !rec.state.hasVideo) {
      rec.state = st;
      rec.since = Date.now();
    }
    tabState.set(tabId, rec);
    setBadge(tabId, rec.state);
    /* 推给顶层 frame，让悬浮面板能显示子 frame 里的视频状态 */
    safeSend(tabId, { type: 'DJZK_PUSH', state: rec.state, videoFrameId: rec.videoFrameId, viaFrame: rec.videoFrameId != null && rec.videoFrameId !== 0 }, { frameId: 0 });
    return;
  }

  if (m.type === 'DJZK_QUERY' || m.type === 'DJZK_TAB_STATE') {
    const tabId = m.tabId != null ? m.tabId : (sender.tab && sender.tab.id);
    const rec = tabState.get(tabId);
    reply({ rec: rec ? { state: rec.state, videoFrameId: rec.videoFrameId, since: rec.since } : null });
    return true;
  }

  if (m.type === 'DJZK_CMD_REQ') {
    /* popup 发来的命令没有 sender.tab，用消息里带的 tabId */
    const tabId = m.tabId != null ? m.tabId : (sender.tab && sender.tab.id);
    if (tabId == null) return;
    const rec = tabState.get(tabId);
    const frameId = rec && rec.videoFrameId != null ? rec.videoFrameId : 0;
    safeSend(tabId, { type: 'DJZK_CMD', cmd: m.cmd }, { frameId });
    reply({ ok: true, frameId });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') tabState.delete(tabId);
});
