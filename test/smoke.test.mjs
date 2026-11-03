/* jsdom 冒烟测试：不依赖浏览器，验证核心链路
 * 运行： JSDOM_PATH=/tmp/djtest/node_modules/jsdom node test/smoke.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (cond || !extra ? '' : '  → ' + extra));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const html = `<!doctype html><html><head><title>课程</title></head><body>
  <div class="player"><video id="v" src="https://res.zfwx.com/a.mp4"></video></div>
  <div class="toolbar"><a href="javascript:;" id="next">下一节</a></div>
</body></html>`;

const dom = new JSDOM(html, {
  url: 'https://www.zfwx.com/wxqt/package/course.do',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
window.PointerEvent = window.MouseEvent;

/* 布局 / 尺寸桩 */
window.Element.prototype.getBoundingClientRect = function () {
  if (this.id === 'v') return { width: 800, height: 450, left: 0, top: 0, right: 800, bottom: 450, x: 0, y: 0 };
  if (this.id === 'next') return { width: 84, height: 30, left: 20, top: 500, right: 104, bottom: 530, x: 20, y: 500 };
  return { width: 240, height: 120, left: 0, top: 0, right: 240, bottom: 120, x: 0, y: 0 };
};

/* 视频桩：jsdom 不实现播放 */
const v = window.document.getElementById('v');
const vs = { paused: true, ended: false, currentTime: 0, duration: 60 };
Object.defineProperties(v, {
  paused: { get: () => vs.paused, configurable: true },
  ended: { get: () => vs.ended, configurable: true },
  duration: { get: () => vs.duration, configurable: true },
  currentTime: { get: () => vs.currentTime, set: (x) => { vs.currentTime = x; }, configurable: true }
});
let playCalls = 0;
v.play = () => { playCalls++; vs.paused = false; return Promise.resolve(); };
v.pause = () => { vs.paused = true; };

/* chrome API 桩 */
const store = {
  djzk_settings: {
    enabled: true, autoPlay: true, autoNext: true, autoMute: true, rate: 1.5, forceRate: true,
    endThreshold: 1.5, nextDelayMinMs: 300, nextDelayMaxMs: 600, autoList: false, pauseOnQuiz: true, beep: false,
    showPanel: true, panelPos: null, customSelectors: []
  }
};
const msgListeners = [];
const changeListeners = [];
const sent = [];
window.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (f) => msgListeners.push(f) },
    sendMessage: (m, cb) => { sent.push(m); if (cb) cb(); },
    getURL: (p) => 'chrome-extension://test/' + p
  },
  storage: {
    local: {
      get: (defaults, cb) => {
        const out = {};
        for (const k of Object.keys(defaults)) out[k] = k in store ? store[k] : defaults[k];
        cb(out);
      },
      set: (obj) => {
        Object.assign(store, obj);
        const changes = {};
        for (const k of Object.keys(obj)) changes[k] = { newValue: obj[k] };
        changeListeners.forEach((f) => f(changes, 'local'));
      }
    },
    onChanged: { addListener: (f) => changeListeners.push(f) }
  }
};

/* 载入内容脚本 */
window.eval(SRC);

const T = window.__DJZK_TEST__;
const $ = (s) => window.document.querySelector(s);

await sleep(500); // 等脚本把 init 挂到 DOMContentLoaded/load 之后再断言

console.log('\n[1] 基础挂载');
check('面板已注入 #djzk-root', !!window.document.getElementById('djzk-root'));
check('面板带悬浮标题', !!window.document.getElementById('djzk-root').shadowRoot.textContent.includes('点睛助手'));
check('识别到视频', !!T.pickVideo());
check('默认参数已从 storage 读取', T.settings.rate === 1.5, 'rate=' + T.settings.rate);

console.log('\n[2] 播放与倍速');
await sleep(400);
check('自动播放被触发', playCalls > 0, 'play() 调用 ' + playCalls + ' 次');
check('自动静音生效', v.muted === true);
check('倍速 1.5× 生效', Math.abs(v.playbackRate - 1.5) < 0.01, 'rate=' + v.playbackRate);
v.playbackRate = 1; // 模拟播放器把倍速重置
await sleep(200);
check('锁定倍速把它拉回 1.5', Math.abs(v.playbackRate - 1.5) < 0.01, 'rate=' + v.playbackRate);

console.log('\n[3] 下一节按钮识别');
const cands = T.collectCandidates();
check('扫描到「下一节」', cands.length > 0, '候选 ' + cands.length + ' 个');
check('首个候选是 #next', cands[0] && cands[0].el.id === 'next', cands[0] && cands[0].el.id);
check('cssPath 生成 #next', T.cssPath($('#next')) === '#next', T.cssPath($('#next')));

console.log('\n[4] 播完自动下一节');
let nextClicks = 0;
$('#next').addEventListener('click', () => { nextClicks++; });
vs.currentTime = 60;
vs.ended = true;
v.dispatchEvent(new window.Event('ended', { bubbles: true }));
check('播完提示带随机区间', /随机/.test(T.msg), T.msg);
await sleep(4200);
check('自动点击了「下一节」', nextClicks >= 1, 'click 次数 ' + nextClicks);
check('跳过节数 +1', T.snapshot().lessons === 1, 'lessons=' + T.snapshot().lessons);
check('已上报状态给后台', sent.some((m) => m.type === 'DJZK_REPORT'));

console.log('\n[5] 弹题暂停');
vs.ended = false;
vs.paused = false;
const layer = window.document.createElement('div');
layer.className = 'layui-layer';
layer.innerHTML = '<div class="layui-layer-title">随堂练习</div><div>请选择正确答案</div><button>提交答案</button>';
window.document.body.appendChild(layer);
await sleep(2200);
check('检测到弹题并暂停', vs.paused === true, 'paused=' + vs.paused);
check('状态快照标记 quiz', T.snapshot().quiz === true);

console.log('\n[6] 设置联动');
window.chrome.storage.local.set({ djzk_settings: Object.assign({}, store.djzk_settings, { autoMute: false }) });
await sleep(1200);
check('关闭自动静音后恢复声音', v.muted === false && v.volume > 0, 'muted=' + v.muted + ' volume=' + v.volume);
window.chrome.storage.local.set({ djzk_settings: Object.assign({}, store.djzk_settings, { enabled: false }) });
await sleep(200);
check('关闭总开关后状态同步', T.settings.enabled === false, 'enabled=' + T.settings.enabled);

console.log('\n[7] 手动拾取选择器');
store.djzk_settings = Object.assign({}, store.djzk_settings, {
  enabled: true, customSelectors: [{ sel: '#next', text: '下一节', host: 'www.zfwx.com' }]
});
changeListeners.forEach((f) => f({ djzk_settings: { newValue: store.djzk_settings } }, 'local'));
const c2 = T.collectCandidates();
check('拾取的选择器被优先采用', c2.length > 0 && c2[0].pri === -10, c2[0] && ('tag=' + c2[0].tag));

console.log('\n[8] 随机等待区间');
check('区间取自设置 300–600ms', JSON.stringify(T.delayRange()) === '[300,600]', JSON.stringify(T.delayRange()));
store.djzk_settings = Object.assign({}, store.djzk_settings, { nextDelayMinMs: 9000, nextDelayMaxMs: 2000 });
changeListeners.forEach((f) => f({ djzk_settings: { newValue: store.djzk_settings } }, 'local'));
let rg = T.delayRange();
check('上下限反了自动交换', rg[0] === 2000 && rg[1] === 9000, JSON.stringify(rg));
store.djzk_settings = Object.assign({}, store.djzk_settings, { nextDelayMinMs: -5, nextDelayMaxMs: 999999 });
changeListeners.forEach((f) => f({ djzk_settings: { newValue: store.djzk_settings } }, 'local'));
rg = T.delayRange();
check('越界值夹到 0–180 秒', rg[0] === 0 && rg[1] === 180000, JSON.stringify(rg));
delete store.djzk_settings.nextDelayMinMs;
delete store.djzk_settings.nextDelayMaxMs;
store.djzk_settings.nextDelayMs = 3000;
changeListeners.forEach((f) => f({ djzk_settings: { newValue: store.djzk_settings } }, 'local'));
rg = T.delayRange();
check('旧版固定等待自动迁移成区间', rg[0] === 3000 && rg[1] === 5000, JSON.stringify(rg));

console.log('\n[9] 右侧目录模式（点睛云新版播放页）');
window.document.title = '1.1 | 新公司法的国有公司治理圆桌谈';
const cat = window.document.createElement('ul');
cat.id = 'catalog';
cat.innerHTML = [
  '1.1 | 新公司法的国有公司治理圆桌谈',
  '1.2 | 新公司法的资本充实责任圆桌谈',
  '2.1 | 公司法修订概述'
].map((t) => '<li class="item"><span>' + t + '</span></li>').join('');
window.document.body.appendChild(cat);
store.djzk_settings = Object.assign({}, store.djzk_settings, { customSelectors: [] });
changeListeners.forEach((f) => f({ djzk_settings: { newValue: store.djzk_settings } }, 'local'));
const catClicks = [];
cat.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => catClicks.push(li.textContent.slice(0, 3))));
const cands3 = T.collectCandidates();
check('目录模式优先选中下一节 1.2', !!cands3[0] && cands3[0].tag === '目录 1.2', cands3[0] && cands3[0].tag);
cands3[0].el.click();
check('点击落在 1.2 条目上', catClicks.some((t) => t.startsWith('1.2')), catClicks.join(','));

console.log('\n[10] 目录：高亮小节反推所属章节');
window.document.title = '点睛云';
const cat2 = window.document.createElement('ul');
cat2.innerHTML = '<li class="chap"><span>2.1 | 公司法修订概述</span><div class="active">问题一：修订亮点</div></li>' +
  '<li class="chap"><span>2.2 | 资本充实责任</span></li>';
window.document.body.appendChild(cat2);
const cands4 = T.collectCandidates();
check('高亮小节时选中下一章 2.2', !!cands4[0] && cands4[0].tag === '目录 2.2', cands4[0] && cands4[0].tag);

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`));
process.exit(failed.length ? 1 : 0);
