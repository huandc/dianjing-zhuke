#!/usr/bin/env python3
"""生成 docs/ 下的界面截图（弹窗 + 页面悬浮面板）。
用法： python3 tools/preview.py
依赖： macOS 上的 Google Chrome（无头模式）。
"""
import html
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DOCS = os.path.join(ROOT, "docs")

POPUP_STUB = """
window.chrome = {
  storage: {
    local: {
      get: async (d) => {
        const settings = { enabled: true, autoPlay: true, autoNext: true, autoMute: true, rate: 1.5,
          forceRate: true, endThreshold: 1.5, nextDelayMinMs: 4000, nextDelayMaxMs: 6000, autoList: false, pauseOnQuiz: true,
          beep: true, showPanel: true, panelPos: null,
          customSelectors: [{ sel: '#nextBtn', text: '下一节', host: 'www.zfwx.com' }] };
        return { djzk_settings: settings, djzk_stats: { date: '2026-11-03', lessons: 6 } };
      },
      set: async () => {}
    },
    onChanged: { addListener: () => {} }
  },
  tabs: { query: async () => [{ id: 3, url: 'https://www.zfwx.com/wxqt/package/course.do?id=8812' }] },
  scripting: { executeScript: async () => {} },
  runtime: {
    sendMessage: async () => ({ rec: { state: {
      hasVideo: true, playing: true, rate: 1.5, cur: 1873, dur: 2710, pct: 69,
      title: '1.1｜刑事涉案财产处置的困境及实务对策 - 点睛网',
      catalogCur: '1.1', catalogNext: '1.2',
      nextText: '1.2｜新公司法的资本充实责任圆桌谈',
      upcoming: [
        { label: '1.2', text: '1.2｜新公司法的资本充实责任圆桌谈' },
        { label: '2.1', text: '2.1｜股东出资加速到期的认定' },
        { label: '2.2', text: '2.2｜出资不实的举证责任分配' },
        { label: '2.3', text: '2.3｜抽逃出资的刑民交叉问题' },
        { label: '3.1', text: '3.1｜公司决议瑕疵的类型化' }
      ],
      upcomingTotal: 5,
      videoSrc: 'https://vod.dianjingyun.com/course/2024/1103/lesson-1.1-1080p.m3u8',
      nextIn: 0, quiz: false, lessons: 2, enabled: true, host: 'www.zfwx.com',
      msg: '锁定 1.5× · 播完自动下一节', href: 'https://www.zfwx.com/wxqt/package/course.do'
    }, videoFrameId: 0 } })
  }
};
"""

PANEL_STUB = """
window.__DJZK_FORCE__ = true;
window.chrome = {
  storage: {
    local: {
      get: (d, cb) => cb({ djzk_settings: { enabled: true, autoPlay: true, autoNext: true, autoMute: true,
        rate: 1.5, forceRate: true, endThreshold: 1.5, nextDelayMinMs: 4000, nextDelayMaxMs: 6000, autoList: false,
        pauseOnQuiz: true, beep: false, showPanel: true, panelPos: null, customSelectors: [] } }),
      set: () => {}
    },
    onChanged: { addListener: () => {} }
  },
  runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {}, getURL: (p) => p, lastError: null }
};
"""

PANEL_PAGE = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>第 3 讲 · 民事诉讼证据规则</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #eef1f6; color: #1f2937; }
  .top { height: 52px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center;
         padding: 0 24px; gap: 12px; }
  .logo { width: 26px; height: 26px; border-radius: 7px; background: linear-gradient(135deg, #2563eb, #22b8cf); }
  .wrap { max-width: 1080px; margin: 22px auto; }
  .crumb { color: #6b7280; font-size: 12px; margin-bottom: 10px; }
  h1 { font-size: 19px; margin: 0 0 14px; }
  .stage { background: #0d1220; border-radius: 12px; overflow: hidden; box-shadow: 0 12px 30px rgba(15,23,42,.18); }
  .screen { position: relative; aspect-ratio: 16/9; background: radial-gradient(circle at 35% 30%, #1e293b, #0b1020 70%);
            display: grid; place-items: center; }
  .screen .t { color: #cbd5e1; font-size: 15px; letter-spacing: .5px; }
  .screen .badge { position: absolute; left: 16px; top: 14px; color: #94a3b8; font-size: 12px; }
  .screen video { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; }
  .ctrl { height: 44px; display: flex; align-items: center; gap: 14px; padding: 0 16px; color: #94a3b8;
          font-size: 12px; border-top: 1px solid rgba(148,163,184,.15); }
  .track { flex: 1; height: 4px; border-radius: 2px; background: rgba(148,163,184,.25); position: relative; }
  .track i { position: absolute; inset: 0 31% 0 0; border-radius: 2px; background: #22b8cf; }
  .bar { display: flex; gap: 10px; margin-top: 16px; }
  .btn { border: 1px solid #d1d5db; background: #fff; border-radius: 8px; padding: 8px 16px; font-size: 13px;
         color: #374151; }
  .btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  .list { margin-top: 22px; background: #fff; border-radius: 12px; padding: 6px 0; }
  .row { display: flex; gap: 12px; padding: 12px 20px; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
  .row:last-child { border-bottom: 0; }
  .row .n { color: #9ca3af; width: 22px; }
  .row.on { background: #eff6ff; font-weight: 600; color: #1d4ed8; }
</style></head>
<body>
<div class="top"><div class="logo"></div><b>点睛网</b><span style="color:#94a3b8">律师培训 · 网络课程</span></div>
<div class="wrap">
  <div class="crumb">首页 / 我的课程 / 民商事诉讼实务</div>
  <h1>第 3 讲 &nbsp;民事诉讼证据规则与举证责任分配</h1>
  <div class="stage">
    <div class="screen">
      <span class="badge">正在学习 · 第 3 讲</span>
      <div class="t">（课程视频占位）民事诉讼证据规则 03</div>
      <video src="" muted></video>
    </div>
    <div class="ctrl">
      <span>▶</span>
      <div class="track"><i></i></div>
      <span>18:42 / 27:10</span><span>1.5×</span><span>音量</span><span>⛶</span>
    </div>
  </div>
  <div class="bar"><button class="btn">上一节</button><button class="btn primary" id="nextBtn">下一节</button>
    <button class="btn">随堂练习</button><button class="btn">课程笔记</button></div>
  <div class="list">
    <div class="row"><span class="n">1</span>概述：证据的种类与证明对象</div>
    <div class="row"><span class="n">2</span>举证责任的分配规则</div>
    <div class="row on"><span class="n">3</span>民事诉讼证据规则与举证责任分配</div>
    <div class="row"><span class="n">4</span>质证与证据审核认定</div>
    <div class="row"><span class="n">5</span>典型判例解析</div>
  </div>
</div>
</body></html>"""


def run_chrome(url, out, size):
    tmp = tempfile.mkdtemp(prefix="djzk-preview-")
    cmd = [
        CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + tmp,
        "--force-device-scale-factor=2",
        "--window-size=" + size, "--screenshot=" + out, url,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(tmp, ignore_errors=True)


def build_popup(work):
    src_html = open(os.path.join(ROOT, "src/popup.html"), encoding="utf-8").read()
    css = open(os.path.join(ROOT, "src/popup.css"), encoding="utf-8").read()
    js = open(os.path.join(ROOT, "src/popup.js"), encoding="utf-8").read()
    page = src_html.replace('<link rel="stylesheet" href="popup.css" />', "<style>\n" + css + "\n</style>")
    page = page.replace('<img src="../icons/icon48.png"', '<img src="icon48.png"')
    page = page.replace("<body>", "<body>\n<script>\n" + POPUP_STUB + "\n</script>")
    page = page.replace('<script src="popup.js"></script>', "<script>\n" + js + "\n</script>")
    assert "popup.js" not in page, "脚本未内联"
    open(os.path.join(work, "popup.html"), "w", encoding="utf-8").write(page)
    shutil.copy(os.path.join(ROOT, "icons/icon48.png"), os.path.join(work, "icon48.png"))


def build_panel(work):
    content = open(os.path.join(ROOT, "src/content.js"), encoding="utf-8").read()
    page = PANEL_PAGE.replace("<body>", "<body>\n<script>\n" + PANEL_STUB + "\n</script>")
    page = page.replace("</body>", "<script>\n" + content + "\n</script>\n</body>")
    open(os.path.join(work, "panel.html"), "w", encoding="utf-8").write(page)


def main():
    if not os.path.exists(CHROME):
        sys.exit("找不到 Chrome：" + CHROME)
    os.makedirs(DOCS, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="djzk-") as work:
        build_popup(work)
        build_panel(work)
        run_chrome("file://" + os.path.join(work, "popup.html"),
                   os.path.join(DOCS, "popup.png"), "342,1000")
        run_chrome("file://" + os.path.join(work, "panel.html"),
                   os.path.join(DOCS, "panel.png"), "1160,780")
    for f in ("popup.png", "panel.png"):
        p = os.path.join(DOCS, f)
        print(f, os.path.getsize(p), "bytes")


if __name__ == "__main__":
    main()
