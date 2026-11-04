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

console.log('\n[11] 点睛网真实目录结构（.play_playerMLBox）');
const box = window.document.createElement('div');
box.className = 'play_playerMLBox';
box.innerHTML = [
  '<div class="courseItem playIngCourse">',
  '  <h3 class="courseName on"><span><em></em><a href="javascript:void(0)">1.1｜刑事涉案财产处置的困境及实务对策</a></span><i></i></h3>',
  '  <div class="animateH"><ul class="rightCatalogList">',
  '    <li class="hasBuy on" data-status="bofang"><p class="name cw" data-id="56899">1.1｜刑事涉案财产处置的困境及实务对策<em>105.1分钟/2.33课时</em></p></li>',
  '  </ul></div>',
  '</div>',
  '<div class="courseItem">',
  '  <h3 class="courseName"><span><em></em><a href="javascript:void(0)">1.2｜刑事涉案财产的证明标准</a></span><i></i></h3>',
  '  <div class="animateH"><ul class="rightCatalogList">',
  '    <li class="hasBuy"><p class="name cw" data-id="56900">1.2｜刑事涉案财产的证明标准<em>30分钟/0.67课时</em></p></li>',
  '  </ul></div>',
  '</div>'
].join('');
window.document.body.appendChild(box);
const zfClicks = [];
box.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => zfClicks.push(li.textContent.slice(0, 3))));
const cands5 = T.collectCandidates();
check('真实目录结构选中下一节 1.2', !!cands5[0] && cands5[0].tag === '目录 1.2', cands5[0] && cands5[0].tag);
cands5[0].el.click();
check('点击落在 1.2 的条目上', zfClicks.some((t) => t.startsWith('1.2')), zfClicks.join(','));

console.log('\n[12] 折叠章节：先点标题再点小节');
box.remove();
window.document.title = '2.1｜公司法修订概述 - 点睛网';
const box2 = window.document.createElement('div');
box2.className = 'play_playerMLBox';
box2.innerHTML = [
  '<div class="courseItem playIngCourse"><h3 class="courseName on"><a href="javascript:void(0)">2.1｜公司法修订概述</a></h3>',
  '<div class="animateH"><ul class="rightCatalogList"><li class="hasBuy on" data-status="bofang"><p class="name cw">2.1｜公司法修订概述<em>20分钟</em></p></li></ul></div></div>',
  '<div class="courseItem"><h3 class="courseName"><a href="javascript:void(0)">2.2｜资本充实责任</a></h3>',
  '<div class="animateH" style="height:0;overflow:hidden"><ul class="rightCatalogList"><li class="hasBuy"><p class="name cw">2.2｜资本充实责任<em>18分钟</em></p></li></ul></div></div>'
].join('');
window.document.body.appendChild(box2);
const rows2 = box2.querySelectorAll('.rightCatalogList li');
rows2[rows2.length - 1].getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
const cands6 = T.collectCandidates();
check('折叠章节时先点 2.2 标题', !!cands6[0] && cands6[0].tag === '目录 2.2', cands6[0] && cands6[0].tag);
check('候选带二级点击', !!(cands6[0] && typeof cands6[0].then === 'function'));
check('二级点击目标是小节行', !!(cands6[0] && cands6[0].then && cands6[0].then().textContent.includes('2.2')));
const st5 = T.snapshot();
check('快照带页面标题', st5.title === window.document.title, st5.title);
check('快照带目录当前/下一节', st5.catalogCur === '2.1' && st5.catalogNext === '2.2', st5.catalogCur + '→' + st5.catalogNext);
check('快照带待听内容', /2\.2/.test(String(st5.nextText)), st5.nextText);
check('快照带视频源', /a\.mp4/.test(String(st5.videoSrc)), st5.videoSrc);
check('快照带后续待听列表', !!st5.upcoming && st5.upcoming[0] && st5.upcoming[0].label === '2.2', JSON.stringify(st5.upcoming && st5.upcoming[0]));
check('后续待听总数正确', st5.upcomingTotal === 1, String(st5.upcomingTotal));

const hiddenRow = [...window.document.querySelectorAll('.animateH li')].find((el) => el.textContent.includes('2.2'));
const shownRow = [...window.document.querySelectorAll('.rightCatalogList li')].find((el) => el.textContent.includes('2.1'));
check('折叠章节里的行判定为收起', !!hiddenRow && T.rowCollapsed(hiddenRow) === true);
check('展开章节里的行不算收起', !!shownRow && T.rowCollapsed(shownRow) === false);

check('倍速上限夹到 16×', T.clampRate(20) === 16);
check('非法倍速回落到 1.5×', T.clampRate(0) === 1.5);
check('低速也能设 0.5×', T.clampRate(0.5) === 0.5);
check('2× 时结尾窗口按倍速放大', T.nearEnd({ duration: 100, currentTime: 97, playbackRate: 2 }) === true);
check('1× 且还剩 3 秒不算结尾', T.nearEnd({ duration: 100, currentTime: 97, playbackRate: 1 }) === false);

/* ---------- [13] 强制倍速：页面世界 rate-lock.js ----------
 * 单独开一个干净的 jsdom：主用例里 content.js 自己也包了一层
 * playbackRate，双层包装会让「底层速率」断言失真。
 */
const rlDom = new JSDOM('<!doctype html><body><video id="rv" src="https://res.zfwx.com/a.mp4"></video></body>', { runScripts: 'outside-only' });
const rlWin = rlDom.window;
const rlNative = Object.getOwnPropertyDescriptor(rlWin.HTMLMediaElement.prototype, 'playbackRate');
const rlVideo = rlWin.document.getElementById('rv');

rlWin.eval(fs.readFileSync(path.join(ROOT, 'src/rate-lock.js'), 'utf8'));
const rateMain = rlWin.__DJZK_RATE_MAIN__;
check('页面世界脚本接管 playbackRate', !!rateMain && typeof rateMain === 'object');

rlWin.postMessage({ __djzk_rate: 1, rate: 2.5, on: true }, '*');
await sleep(30);
check('强制倍速已生效', rateMain.on === true && rateMain.rate === 2.5, JSON.stringify({ on: rateMain.on, rate: rateMain.rate }));

rlVideo.playbackRate = 1;
check('页面改写 1× 被压回 2.5×', Math.abs(rlVideo.playbackRate - 2.5) < 0.01, String(rlVideo.playbackRate));
check('底层真实速率也被改写', Math.abs(rlNative.get.call(rlVideo) - 2.5) < 0.01, String(rlNative.get.call(rlVideo)));

rlWin.postMessage({ __djzk_rate: 1, rate: 2.5, on: false }, '*');
await sleep(30);
rlVideo.playbackRate = 1.25;
check('关闭强制后可自由改倍速', Math.abs(rlVideo.playbackRate - 1.25) < 0.01, String(rlVideo.playbackRate));

/* ---------- [14] 课程列表页：采集未听完的项 + 队列连播 ---------- */
console.log('\n[14] 课程列表队列');
const listHtml = `<!doctype html><html><head><title>听课中心</title></head><body>
  <div class="courseList">
    <ul class="courseNav of"><li class="on">正听</li><li>未听</li></ul>
    <div class="courseCont">
      <div class="courseDetail courseTT of"><span class="index">序号</span><span class="className">课程名称</span></div>
      <div class="courseDetail of" id="d1">
        <span class="index">T1</span>
        <span class="className classTitle isCourse" title="1段｜刑事业务公益课程"><em>1段｜刑事业务公益课程</em></span>
        <div class="courseHid">
          <span class="className classTitle isCourse" title="1.1｜刑事涉案财产处置"><em>1.1｜刑事涉案财产处置</em></span>
          <div class="courseVideo vidHidden">
            <div class="videoList of"><span class="className">问题一：财产处置的困境</span><span class="progress"><p class="progress_num"><i>100</i>%</p></span><span class="player">播放</span></div>
            <div class="videoList of"><span class="className">问题二：涉案财物的范围</span><span class="progress"><p class="progress_num"><i>40</i>%</p></span><span class="player">播放</span></div>
            <div class="videoList of"><span class="className">问题三：案外人异议</span><span class="progress"><p class="progress_num"><i>0</i>%</p></span><span class="player">播放</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;
const listDom = new JSDOM(listHtml, { url: 'https://www.zfwx.com/wxqt/package/target/list.html', runScripts: 'outside-only', pretendToBeVisual: true });
const lw = listDom.window;
lw.Element.prototype.getBoundingClientRect = function () {
  return { width: 260, height: 40, left: 0, top: 0, right: 260, bottom: 40, x: 0, y: 0 };
};
const lstore = {
  djzk_settings: {
    enabled: true, autoPlay: true, autoNext: true, autoMute: true, rate: 1.5, rateLock: true,
    nextDelayMinMs: 200, nextDelayMaxMs: 300, autoList: false, listRun: false, pauseOnQuiz: true,
    beep: false, showPanel: false, panelPos: null, customSelectors: []
  }
};
lw.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: () => {} },
    sendMessage: () => {},
    getURL: (p) => 'chrome-extension://test/' + p
  },
  storage: {
    local: {
      get: (defaults, cb) => {
        const out = {};
        for (const k of Object.keys(defaults)) out[k] = k in lstore ? lstore[k] : defaults[k];
        cb(out);
      },
      set: (obj) => { Object.assign(lstore, obj); }
    },
    onChanged: { addListener: () => {} }
  }
};
lw.eval(SRC);
const LT = lw.__DJZK_TEST__;
await sleep(350);

check('识别为课程列表页', LT.isCourseListPage() === true);
const lrows = LT.listRows();
check('列表解析出 3 个视频行', lrows.length === 3, 'rows=' + lrows.length);
check('进度解析正确 100/40/0', lrows.map((r) => r.pct).join(',') === '100,40,0', lrows.map((r) => r.pct).join(','));
check('行带着所属课程标题', /1\.1｜刑事涉案财产处置/.test(lrows[1].course), lrows[1].course);

const clicked = [];
lw.document.querySelectorAll('.videoList').forEach((vl) => {
  vl.querySelector('.player').addEventListener('click', () => clicked.push(vl.querySelector('.className').textContent));
});

const harvested = await LT.harvestQueue();
check('采集只收进度<100 的条目', harvested.items.length === 2, 'items=' + harvested.items.length);
check('队列写入 storage', !!lstore.djzk_queue && lstore.djzk_queue.items.length === 2);
check('队列记录列表页地址', /target\/list\.html$/.test(lstore.djzk_queue.url), lstore.djzk_queue.url);
check('队列首条是 40% 的问题二', /问题二/.test(harvested.items[0].title), harvested.items[0].title);

const lst = LT.snapshot();
check('快照标记为列表模式', lst.listMode === true);
check('快照待听列表来自队列', lst.upcomingTotal === 2 && /问题二/.test(lst.upcoming[0].text), JSON.stringify(lst.upcoming && lst.upcoming[0]));

const go1 = await LT.queueNext();
check('连播点了队列第一条', go1 === true && clicked.length === 1 && /问题二/.test(clicked[0]), clicked.join(' | '));
check('当前队列项已记录', /问题二/.test(lstore.djzk_queue.curKey || ''), lstore.djzk_queue.curKey);

/* 把问题二标成 100%（模拟听完回列表），下一次应跳过它点问题三 */
const row2 = [...lw.document.querySelectorAll('.videoList')].find((el) => el.textContent.includes('问题二'));
row2.querySelector('.progress_num').textContent = '100%';
const go2 = await LT.queueNext();
check('已听完的条目被跳过', go2 === true && clicked.length === 2 && /问题三/.test(clicked[1]), clicked.join(' | '));

/* 严格按队列：播完当前这条就记录完成，不再按页面目录乱跳 */
await sleep(2600);
LT.doNext('播完');
await sleep(80);
const lqDone = LT.getQueue().items.find((it) => /问题三/.test(it.title));
check('播完即把当前条目标记完成', !!lqDone && lqDone.done === true, JSON.stringify(lqDone && lqDone.done));
check('严格队列不点页面目录', clicked.length === 2, 'clicked=' + clicked.length);

/* 防死循环：同一条刚点过不重复打开；反复失败 3 次跳过 */
const go3 = await LT.queueNext();
check('同一条刚打开过不重复点击', go3 === false && clicked.length === 2, 'clicked=' + clicked.length);
const lq = LT.getQueue();
lq.items.forEach((it) => { if (/问题三/.test(it.title)) it.tries = 2; });
lq.curKey = '';
lq.lastAt = 0;
LT.setQueue(lq);
await LT.queueNext();
const lq2 = LT.getQueue();
const q3 = lq2.items.find((it) => /问题三/.test(it.title));
check('反复打不开的条目已被跳过', !!q3 && q3.done === true && q3.tries >= 2, JSON.stringify(q3 && { done: q3.done, tries: q3.tries }));

/* 选择课程：点课程名 → 只收该课程的视频 → 从第一节开始播 */
lw.document.querySelectorAll('.videoList').forEach((vl) => {
  vl.querySelector('.progress_num').textContent = '0%';
});
LT.startCoursePicker();
const titleEl = lw.document.querySelector('.courseDetail .classTitle');
titleEl.dispatchEvent(new lw.MouseEvent('click', { bubbles: true, cancelable: true }));
await sleep(1400);
const picked = lstore.djzk_queue;
check('选择课程后队列换成该课程', !!picked && /刑事业务公益课程/.test(picked.course || ''), picked && picked.course);
check('该课程下的视频全收：3 节', !!picked && picked.items.length === 3, picked && 'items=' + picked.items.length);
check('选中后开始播放第一节', /问题一/.test(picked.curKey || ''), picked && picked.curKey);
check('总览里的待听换成该课程', LT.snapshot().upcomingTotal === 3, String(LT.snapshot().upcomingTotal));

/* ---------- [15] 页面世界脚本：把播放弹出的新标签改成当前标签 ---------- */
console.log('\n[15] 播放不新开标签');
const tabScript = fs.readFileSync(path.join(ROOT, 'src/same-tab.js'), 'utf8');
const tabDom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://www.zfwx.com/wxqt/package/target/list.html', runScripts: 'outside-only', pretendToBeVisual: true,
  virtualConsole: new (require('jsdom').VirtualConsole)()
});
const tw = tabDom.window;
let origOpenCalls = 0;
tw.open = function () { origOpenCalls += 1; return { focus() {} }; };
tw.eval(tabScript);
const say = (on) => tw.dispatchEvent(new tw.MessageEvent('message', { data: { __djzk_same_tab: 1, on } }));
say(true);
const w1 = tw.open('https://www.zfwx.com/wxqt/package/course.do?id=7');
check('开关打开后 window.open 被接管', origOpenCalls === 0, 'orig=' + origOpenCalls);
check('返回的假窗口可 focus/close', !!w1 && typeof w1.focus === 'function' && w1.closed === false);
tw.open('https://other.example.com/pay');
check('跨站弹窗仍然放行', origOpenCalls === 1, 'orig=' + origOpenCalls);
say(false);
tw.open('https://www.zfwx.com/wxqt/package/course.do?id=8');
check('关掉开关后恢复原样', origOpenCalls === 2, 'orig=' + origOpenCalls);

/* 已听完（100%）的条目不该进队列 */
const lv2 = lw.document.querySelectorAll('.videoList')[1];
lv2.querySelector('.progress_num').textContent = '100%';
LT.startCoursePicker();
lw.document.querySelector('.courseDetail .classTitle')
  .dispatchEvent(new lw.MouseEvent('click', { bubbles: true, cancelable: true }));
await sleep(600);
const picked2 = lstore.djzk_queue;
check('已听完的课程不进队列', picked2.items.length === 2 && !picked2.items.some((it) => /问题二/.test(it.title)),
  picked2.items.map((it) => it.title).join(' | '));
check('提示里说明有几节已听完', /未放进队列/.test(LT.snapshot().msg), LT.snapshot().msg);

/* ---------- [16] 把倍速写回站点自己的倍速菜单 ---------- */
console.log('\n[16] 站点倍速菜单同步');
const rateHtml = `<!doctype html><html><body>
  <div class="playbox"><video id="v" src="https://cdn.example.com/a.mp4"></video></div>
  <div class="rate-components">
    <div class="current-rate">1.0</div>
    <ul class="rate-list" style="display:none">
      <li data-rate="2.0">2.0x</li><li data-rate="1.5">1.5x</li><li data-rate="1.0" class="current">1.0x</li>
    </ul>
  </div>
</body></html>`;
const rateDom = new JSDOM(rateHtml, { url: 'https://www.zfwx.com/wxqt/package/course.do', runScripts: 'outside-only', pretendToBeVisual: true });
const rw = rateDom.window;
rw.Element.prototype.getBoundingClientRect = () => ({ width: 400, height: 200, left: 0, top: 0, right: 400, bottom: 200, x: 0, y: 0 });
const rv = rw.document.querySelector('video');
rv.play = () => Promise.resolve();
rv.pause = () => {};
Object.defineProperty(rv, 'duration', { value: 600, configurable: true });
let rtime = 0;
Object.defineProperty(rv, 'currentTime', { get: () => rtime, set: (x) => { rtime = x; }, configurable: true });
rw.chrome = {
  runtime: { lastError: null, onMessage: { addListener: () => {} }, sendMessage: () => {}, getURL: (p) => 'chrome-extension://t/' + p },
  storage: {
    local: { get: (d, cb) => { const o = {}; for (const k of Object.keys(d)) o[k] = d[k]; cb(o); }, set: () => {} },
    onChanged: { addListener: () => {} }
  }
};
rw.eval(SRC);
const RT = rw.__DJZK_TEST__;
RT.syncRateUi(2);
check('current-rate 写成 2.0', rw.document.querySelector('.current-rate').textContent === '2.0',
  rw.document.querySelector('.current-rate').textContent);
check('对应档位标为 current', rw.document.querySelector('li[data-rate="2.0"]').classList.contains('current'));
RT.syncRateUi(1.5);
check('切到 1.5 时 current 跟着换', rw.document.querySelector('li[data-rate="1.5"]').classList.contains('current') &&
  !rw.document.querySelector('li[data-rate="2.0"]').classList.contains('current'));
check('列表里没有的倍速仍显示真值', (RT.syncRateUi(3.25), rw.document.querySelector('.current-rate').textContent === '3.3'),
  rw.document.querySelector('.current-rate').textContent);

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`));
process.exit(failed.length ? 1 : 0);
