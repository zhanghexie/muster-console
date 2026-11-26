/**
 * 手机端表面 e2e（mobile-remote-interaction-plan）：构建产物 + dev 沙箱拉起真实
 * 应用，Chrome headless（CDP 移动仿真：iPhone UA + 390x844 + touch）走完整链路：
 *
 * 手机判定 → L1 工作区列表 → 下钻 L2（调度卡/会话行+状态胶囊）→ L3 调度对话
 * （复用 ChatSurfaceView + composer）→ 操作菜单/文件抽屉（列表→详情→收起）/
 * 清空确认 → 新建会话抽屉 → sessions.create 落地 GUI L3 → 边滑返回（CDP 触摸
 * 序列）→ 顶栏返回 → 刷新后栈恢复。
 *
 * 前置：npm run build + Electron + 系统 Chrome（--chrome 指定路径，默认探测常见位置）。
 * 不进 npm test（同 web-access.mjs，见 run.mjs EXCLUDE），手动运行：
 *   node test/web-mobile.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const PORT = 17951;
const CDP_PORT = 17952;
const BASE = `http://127.0.0.1:${PORT}`;
const tokenFile = path.join(repoRoot, '.dev-sandbox', 'userData', 'web-access.json');
const shotDir = path.join(repoRoot, '.dev-sandbox', 'web-mobile-shots');
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function findChrome() {
  if (process.env.WEB_MOBILE_CHROME) return process.env.WEB_MOBILE_CHROME;
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('未找到 Chrome/Edge，请用 WEB_MOBILE_CHROME 指定路径');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failed += 1;
  console.error(`  ✗ ${name}${detail ? `：${detail}` : ''}`);
};

/* ---------- 应用启动 ---------- */
const indexHtml = path.join(repoRoot, 'out', 'renderer', 'index.html');
if (!fs.existsSync(indexHtml)) {
  console.error('缺少 out/renderer/index.html，请先 npm run build');
  process.exit(1);
}

const app = spawn(path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), [repoRoot], {
  cwd: repoRoot,
  env: { ...process.env, MUSTER_WEB_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let appLog = '';
app.stdout.on('data', (b) => (appLog += b.toString()));
app.stderr.on('data', (b) => (appLog += b.toString()));

async function waitAppReady() {
  // 先等网关端口可达（listen 前 token 已落盘），再读 token——
  // 顺序反了会拿到上一次实例的旧 token（token 每次启动随机重生成）
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) throw new Error(`应用提前退出（code=${app.exitCode}）\n${appLog.slice(-4000)}`);
    try {
      await fetch(`${BASE}/`);
      break;
    } catch {
      await sleep(500);
    }
  }
  let token = null;
  for (let i = 0; i < 40; i++) {
    try {
      token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token;
      if (token) return token;
    } catch {
      /* 尚未生成 */
    }
    await sleep(500);
  }
  throw new Error('网关就绪后 20s 内未读到 token 文件');
}

/* ---------- CDP 客户端 ---------- */
let chrome = null;
let ws = null;
let msgId = 0;
const pendingCdp = new Map();

function cdpSend(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pendingCdp.set(id, { resolve, reject });
    setTimeout(() => {
      if (pendingCdp.has(id)) {
        pendingCdp.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }
    }, 15000);
  });
}

async function startChrome() {
  const exe = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-web-mobile-'));
  chrome = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ], { stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = targets.find((t) => t.type === 'page');
      if (page) break;
    } catch {
      /* 未就绪 */
    }
    await sleep(500);
  }
  if (!page) throw new Error('Chrome CDP 30s 未就绪');
  ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  ws.on('message', (buf) => {
    const m = JSON.parse(String(buf));
    if (m.id && pendingCdp.has(m.id)) {
      const p = pendingCdp.get(m.id);
      pendingCdp.delete(m.id);
      if (m.error) p.reject(new Error(`${m.error.message}`));
      else p.resolve(m.result);
    }
  });
  await cdpSend('Page.enable');
  await cdpSend('Runtime.enable');
  // 移动仿真：UA + 视口 + 触摸
  await cdpSend('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA });
  await cdpSend('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  });
  await cdpSend('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

/** Runtime.evaluate 包装：返回 { value, isOk } */
async function evalJs(expr) {
  const r = await cdpSend('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) {
    return { isOk: false, value: r.exceptionDetails.text };
  }
  return { isOk: true, value: r.result?.value };
}

/** 等选择器出现（轮询 evalJs） */
async function waitFor(selector, { timeout = 15000, visible = true } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        `if (!el) return 0; ` +
        `if (${visible ? 'true' : 'false'} && !(el.offsetWidth || el.offsetHeight)) return 0; ` +
        `return 1; })()`
    );
    if (r.isOk && r.value === 1) return true;
    await sleep(300);
  }
  return false;
}

/** 点击元素中心（触摸事件） */
async function tap(selector) {
  const r = await evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
      `if (!el) return null; const b = el.getBoundingClientRect(); ` +
      `return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`
  );
  if (!r.isOk || !r.value) return false;
  const { x, y } = r.value;
  await cdpSend('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 1 }]
  });
  await cdpSend('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return true;
}

/** 浏览器返回（Android/iOS 边滑手势与返回键走同一条 history 路径） */
async function browserBack() {
  await evalJs('window.history.back()');
}

async function shot(name) {
  try {
    await sleep(500); // 等转场动画（--dur-move 420ms）播完再截，避免拍到中间帧
    const r = await cdpSend('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(shotDir, { recursive: true });
    fs.writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(r.data, 'base64'));
  } catch {
    /* 截图失败不阻塞断言 */
  }
}

/* ---------- 主流程 ---------- */
let token = null;
try {
  token = await waitAppReady();
  await startChrome();

  // ── 手机判定 + L1 ──
  await cdpSend('Page.navigate', { url: `${BASE}/?token=${encodeURIComponent(token)}` });
  if (await waitFor('.ma-root')) ok('进入手机表面（.ma-root 挂载）');
  else bad('手机表面未挂载', 'is-mobile 判定或渲染失败');
  const isMobileHtml = await evalJs(`document.documentElement.classList.contains('is-mobile')`);
  if (isMobileHtml.value === true) ok('html.is-mobile 根类生效');
  else bad('html.is-mobile 未生效');

  if (await waitFor('.ma-ws-card', { timeout: 20000 })) ok(`L1 工作区卡（${(await evalJs('document.querySelectorAll(".ma-ws-card").length')).value} 张）`);
  else bad('L1 工作区卡未出现');
  await shot('01-L1-workspaces');

  // ── 下钻 L2 ──
  if (await tap('.ma-ws-card')) {
    if (await waitFor('.ma-dispatch-card')) ok('下钻 L2：调度 Agent 卡置顶');
    else bad('L2 调度卡未出现');
  } else bad('点击工作区卡失败');
  const sessionRows = await evalJs('document.querySelectorAll(".ma-session-row").length');
  ok(`L2 会话行 ${sessionRows.value} 条`);
  if (sessionRows.value > 0) {
    const withCapsule = await evalJs('document.querySelectorAll(".ma-session-row .session-capsule").length');
    if (withCapsule.value === sessionRows.value) ok('L2 会话行全部带状态胶囊（liveStatus 缺省按看板状态推导）');
    else bad('会话行缺状态胶囊', `${withCapsule.value}/${sessionRows.value}`);
  }
  await shot('02-L2-workspace');

  // ── 进入 L3 调度对话 ──
  if (await tap('.ma-dispatch-card')) {
    if (await waitFor('.chat-surface-view')) ok('L3 调度对话：ChatSurfaceView 挂载');
    else bad('L3 ChatSurfaceView 未挂载');
    if (await waitFor('.composer-editable', { timeout: 10000 })) ok('L3 composer 输入框就绪');
    else bad('L3 输入框未就绪');
  } else bad('点击调度卡失败');
  await shot('03-L3-dispatch');

  // ── 操作菜单 + 文件抽屉 + 清空确认（进入页后稳定 500ms 再点；首点未开重试一次） ──
  const openMenu = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await tap('.ma-chat-page .ma-topbar-btn[aria-label="更多操作"]')) {
        if (await waitFor('.msheet .ma-sheet-item', { timeout: 4000 })) return true;
      }
    }
    return false;
  };
  await sleep(500);
  let menuOpened = await openMenu();
  if (menuOpened) {
    ok('「⋯」菜单弹出（底部抽屉）');
    const items = await evalJs('[...document.querySelectorAll(".msheet .ma-sheet-item")].map(b=>b.textContent.trim())');
    ok(`菜单项：${JSON.stringify(items.value)}`);

    // ── 文件抽屉：菜单「文件列表」→ 根目录列表 → 进详情 → 返回列表 → 收起 ──
    if (items.value?.includes('文件列表')) {
      await tap('.msheet .ma-sheet-item:not(.danger)');
      if (await waitFor('.mfiles', { timeout: 5000 })) {
        ok('「文件列表」侧栏弹出');
        const widthPct = await evalJs(
          '(() => { const el = document.querySelector(".mfiles"); return el ? Math.round(el.getBoundingClientRect().width / window.innerWidth * 100) : 0; })()'
        );
        if (widthPct.value === 90) ok('抽屉宽度占屏 90%');
        else bad('抽屉宽度不符', `实际 ${widthPct.value}%`);
        await shot('06-L3-files-drawer');
        const fileRows = await evalJs('document.querySelectorAll(".ma-files-row").length');
        if (fileRows.value > 0) {
          ok(`文件列表 ${fileRows.value} 行`);
          // 点第一个非目录行（目录行带 .ma-files-chev）进详情
          await evalJs('document.querySelector(".ma-files-row:not(:has(.ma-files-chev))")?.click()');
          if (await waitFor('.ma-files-detail', { timeout: 6000 })) {
            ok('点文件进入详情预览');
            await shot('07-L3-file-detail');
            await tap('.ma-files-head .ma-topbar-btn');
            if (await waitFor('.ma-files-row', { timeout: 4000 })) ok('详情返回列表');
            else bad('详情未返回列表');
          } else bad('文件详情未出现');
        } else bad('文件列表为空（工作区应有文件）');
        await tap('.ma-files-close');
        await sleep(500); // 退场动画（--dur-exit 200ms + 兜底）
        const drawerGone = await evalJs('!document.querySelector(".mfiles")');
        if (drawerGone.value === true) ok('文件抽屉收起');
        else bad('文件抽屉未收起');
      } else bad('文件抽屉未弹出');
      menuOpened = await openMenu();
    } else {
      bad('菜单缺少「文件列表」');
    }

    if (menuOpened && items.value?.includes('清空会话')) {
      await tap('.msheet .ma-sheet-item.danger');
      await sleep(350);
      if (await waitFor('.msheet .ma-sheet-btn.danger')) ok('清空二次确认弹层');
      else bad('清空确认未弹出');
      await tap('.msheet .ma-sheet-btn.danger');
      await sleep(400);
      const sheetGone = await evalJs('!document.querySelector(".msheet")');
      if (sheetGone.value === true) ok('清空流程走完、抽屉收起');
      else bad('清空后抽屉未收起');
    } else if (menuOpened) {
      bad('菜单缺少「清空会话」');
    }
  } else bad('操作菜单未弹出');

  // ── 顶栏返回 L2 ──
  await tap('.ma-chat-page .ma-topbar-btn[aria-label="返回"]');
  if (await waitFor('.ma-dispatch-card')) ok('顶栏返回 L2');
  else bad('顶栏返回失败');

  // ── 新建会话抽屉 + sessions.create → GUI L3 ──
  if (await tap('.ma-fab')) {
    await sleep(350);
    if (await waitFor('.msheet .ma-sheet-item')) ok('新建会话抽屉弹出');
    else bad('新建抽屉未弹出');
    const rt = await evalJs('[...document.querySelectorAll(".msheet .ma-sheet-item")].map(b=>b.textContent.trim())');
    ok(`可选 runtime：${JSON.stringify(rt.value)}`);
    if (rt.value?.length) {
      await tap('.msheet .ma-sheet-item');
      // sessions.create → 深链 GUI L3（composer + 欢迎语）
      if (await waitFor('.chat-surface-view', { timeout: 20000 })) ok('新建会话落地 GUI L3 对话页');
      else bad('新建会话后未进入 L3');
      const welcome = await evalJs('!!document.querySelector(".chat-welcome")');
      if (welcome.value === true) ok('GUI 空会话欢迎语显示');
      else bad('GUI 欢迎语缺失');
      await shot('04-L3-gui-new-session');
    } else bad('没有可选 chat runtime');
  } else bad('点开新建抽屉失败');

  // ── 浏览器返回（= 边滑/返回键） ──
  await browserBack();
  await sleep(700);
  if (await waitFor('.ma-dispatch-card', { timeout: 5000 })) ok('浏览器返回手势弹回 L2（history.popstate）');
  else bad('浏览器返回未弹栈');

  // ── 栈恢复：留在 L2 刷新页面 ──
  await cdpSend('Page.reload');
  const restored =
    (await waitFor('.ma-root', { timeout: 20000 })) &&
    ((await waitFor('.ma-dispatch-card', { timeout: 8000 })) ||
      (await waitFor('.ma-chat-page', { timeout: 2000 })));
  if (restored) ok('刷新后栈恢复到原层级');
  else bad('刷新后未恢复栈');

  // ── 判定锁定：手机 UA 下把视口拉宽（跨 820px），不得闪换桌面布局 ──
  await cdpSend('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: true
  });
  await sleep(600);
  const stillMobile = await evalJs('!!document.querySelector(".ma-root") && !document.querySelector(".app-shell")');
  if (stillMobile.value === true) ok('视口拉宽仍锁定手机表面（不闪桌面页）');
  else bad('视口变化触发了表面切换（判定未锁定）');
  // 还原窄视口继续后续断言
  await cdpSend('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  });
  await sleep(400);

  // ── 桌面判定不受影响：换桌面 UA + 关触摸仿真 + 宽视口 → 应进桌面布局 ──
  // （只换 UA 不够：触摸仿真开着 pointer 仍为 coarse，coarse+窄视口也会进手机面）
  await cdpSend('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36'
  });
  await cdpSend('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdpSend('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdpSend('Page.reload');
  await sleep(1500);
  const desktopRoot = await evalJs('!document.querySelector(".ma-root") && !!document.querySelector(".app-shell, .boot-skel, #root")');
  if (desktopRoot.value === true) ok('桌面 UA 不进手机表面（.ma-root 不挂载）');
  else bad('桌面 UA 误入手机表面');
  await shot('05-desktop-ua');
} catch (e) {
  bad('e2e 异常', `${e.message}\n${appLog.slice(-2000)}`);
}

/* ---------- 收尾 ---------- */
try {
  if (ws) ws.close();
} catch {
  /* ignore */
}
if (chrome) chrome.kill();
app.kill();
await sleep(800);

if (failed > 0) {
  console.error(`web-mobile: ${failed} 项不符`);
  process.exit(1);
}
console.log('web-mobile: 手机表面 e2e 全部通过');
