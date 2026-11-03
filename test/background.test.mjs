/* background service worker 单元测试（Node + vm，不依赖浏览器）
 * 运行： node test/background.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(__dirname, '../src/background.js'), 'utf8');

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (cond || extra === undefined ? '' : '  → ' + extra));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- chrome 桩 ---- */
const store = {};
const on = { installed: [], startup: [], message: [], removed: [], updated: [] };
const sends = [];
const badges = [];
const chrome = {
  runtime: {
    lastError: null,
    onInstalled: { addListener: (f) => on.installed.push(f) },
    onStartup: { addListener: (f) => on.startup.push(f) },
    onMessage: { addListener: (f) => on.message.push(f) }
  },
  storage: {
    local: {
      get: async (defaults) => {
        const out = {};
        for (const k of Object.keys(defaults)) out[k] = k in store ? store[k] : defaults[k];
        return out;
      },
      set: async (obj) => { Object.assign(store, obj); }
    }
  },
  action: {
    setBadgeText: (o) => badges.push({ text: o.text, tabId: o.tabId }),
    setBadgeBackgroundColor: () => {}
  },
  tabs: {
    sendMessage: (tabId, msg, opts, cb) => { sends.push({ tabId, msg, opts }); if (cb) cb(); },
    onRemoved: { addListener: (f) => on.removed.push(f) },
    onUpdated: { addListener: (f) => on.updated.push(f) }
  }
};

vm.runInNewContext(SRC, { chrome, console, Date, setTimeout });

/* 简化：直接调用唯一的 message 监听器 */
const dispatch = (m, sender) => {
  let replied;
  let isAsync = false;
  for (const f of on.message) {
    const r = f(m, sender || {}, (v) => { replied = v; });
    if (r === true) isAsync = true;
  }
  return { replied, isAsync };
};

console.log('\n[1] 安装初始化');
await on.installed[0]();
check('写入默认设置', !!store.djzk_settings && store.djzk_settings.rate === 1.5);
check('写入今日统计', !!store.djzk_stats && store.djzk_stats.lessons === 0, JSON.stringify(store.djzk_stats));

console.log('\n[2] 状态上报与角标');
const st = (over) => Object.assign({
  v: '1.0.0', top: false, hasVideo: true, playing: true, ended: false, rate: 1.5,
  muted: true, cur: 10, dur: 100, pct: 10, nextIn: 0, quiz: false, lessons: 0,
  msg: '播放中', enabled: true, host: 'www.zfwx.com', at: Date.now()
}, over || {});
dispatch({ type: 'DJZK_REPORT', state: st({ lessons: 0 }) }, { tab: { id: 7 }, frameId: 0 });
await sleep(30);
check('角标显示 ON', badges.some((b) => b.tabId === 7 && b.text === 'ON'));
check('推送状态给顶层 frame', sends.some((s) => s.msg.type === 'DJZK_PUSH' && s.opts.frameId === 0));

console.log('\n[3] 今日跳过节数');
dispatch({ type: 'DJZK_REPORT', state: st({ lessons: 1 }) }, { tab: { id: 7 }, frameId: 0 });
dispatch({ type: 'DJZK_REPORT', state: st({ lessons: 3 }) }, { tab: { id: 7 }, frameId: 0 });
await sleep(80);
check('累计 +3 节', store.djzk_stats.lessons === 3, JSON.stringify(store.djzk_stats));

console.log('\n[4] 子 frame 路由');
dispatch({ type: 'DJZK_REPORT', state: st({ lessons: 3 }) }, { tab: { id: 7 }, frameId: 5 });
await sleep(30);
let r = dispatch({ type: 'DJZK_TAB_STATE', tabId: 7 });
check('查询返回状态', r.replied && r.replied.rec && r.replied.rec.state.hasVideo);
check('记住视频所在 frame', r.replied.rec.videoFrameId === 5, 'frameId=' + r.replied.rec.videoFrameId);

sends.length = 0;
r = dispatch({ type: 'DJZK_CMD_REQ', cmd: 'next', tabId: 7 });
await sleep(20);
check('命令转发到视频 frame', sends.some((s) => s.msg.type === 'DJZK_CMD' && s.opts.frameId === 5), JSON.stringify(sends));
check('命令 reply ok', r.replied && r.replied.ok === true);

sends.length = 0;
dispatch({ type: 'DJZK_CMD_REQ', cmd: 'next' }, { tab: { id: 7 } });
await sleep(20);
check('无 tabId 时用 sender.tab 兜底', sends.some((s) => s.tabId === 7));

console.log('\n[5] 清理');
on.removed.forEach((f) => f(7));
r = dispatch({ type: 'DJZK_TAB_STATE', tabId: 7 });
check('关标签页后状态清空', r.replied.rec === null);

const failed = results.filter((x) => !x.ok);
console.log('\n' + (failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`));
process.exit(failed.length ? 1 : 0);
