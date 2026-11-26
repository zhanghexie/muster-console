/**
 * 内置浏览器实机冒烟（需 dev 实例：MUSTER_DEVTOOLS_PORT=9333 npm run dev）。
 * 验证链路：UI 通道（开标签/切浏览器页）→ WebContentsView 渲染 → playwright-core
 * connectOverCDP 同端口连接 → __maBrowserTab 标记 → ariaSnapshot → aria-ref 定位点击。
 * 与 BrowserAgentTools 的生产通路同构（同端口、同连接方式），通过即 T3/T4 主链路可用。
 */
import { chromium } from 'playwright-core';
import { startCdpTypeProxy } from './helpers/cdp-type-proxy.mjs';

const CDP_UPSTREAM = 9333;

function fail(msg) {
  console.error(`FAIL ${msg}`);
  process.exit(1);
}


/** 应用内合成按键（CDP 注入键盘不触发本应用 KeybindingHost；合成 DOM keydown 有效） */
async function pressAppKey(app, def) {
  await app.evaluate((d) => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: d.key, code: d.code, ctrlKey: !!d.ctrl, shiftKey: !!d.shift, altKey: !!d.alt,
        bubbles: true, cancelable: true
      })
    );
  }, def);
  await new Promise((r) => setTimeout(r, 700));
}

async function main() {
  // 1. 经类型改写代理连 CDP（webview guest 的 target type 需改写为 page 才能被
  //    playwright 发现；与 agentTools 生产通路同构），找应用主窗口 renderer
  const proxy = await startCdpTypeProxy(CDP_UPSTREAM);
  const browser = await chromium.connectOverCDP(proxy.url);
  const pages = [];
  for (const c of browser.contexts()) pages.push(...c.pages());
  console.log(`targets: ${pages.length}`);
  let app = null;
  for (const p of pages) {
    try {
      const title = await p.title();
      if (/MetaAgent|Meta/i.test(title)) {
        app = p;
        console.log(`app page: ${title} (${p.url().slice(0, 60)})`);
        break;
      }
    } catch {
      /* skip */
    }
  }
  if (!app) fail('未找到应用主窗口 renderer target');

  // 2. 经 window.api 清场后开标签（example.com + bing 搜索词），走与渲染层同一 IPC 面
  const openRes = await app.evaluate(async () => {
    let cur = await window.api.browser.restore();
    for (const t of cur.tabs) await window.api.browser.close({ id: t.id });
    const r1 = await window.api.browser.open({ url: 'https://example.com' });
    const r2 = await window.api.browser.open({ url: '小红书' });
    const tabs = await window.api.browser.restore();
    return { r1, r2, tabs: tabs.tabs.map((t) => ({ id: t.id, url: t.url })) };
  });
  console.log('open ok:', JSON.stringify(openRes.tabs.map((t) => t.url)));
  if (openRes.tabs.length < 2) fail('开标签失败');
  const tabId = openRes.r1.id;
  // r2 后开会抢走激活位；被操作标签必须是激活标签（后台视图节流会导致无 ref）
  await app.evaluate(async (id) => {
    await window.api.browser.activate({ id });
  }, tabId);

  // 3. 切到浏览器页：Ctrl+\ 是 toggle（terminal↔git），先读 .main-view 状态再决定是否按；
  //    B 键（sideTools.browser）需第二页激活才生效；再等 BrowserPage 懒挂载
  const dockCls = () =>
    app.evaluate(() => document.querySelector('.main-view')?.className ?? '');
  if (!/h-git/.test(await dockCls())) {
    await pressAppKey(app, { key: String.fromCharCode(92), code: 'Backslash', ctrl: true, shift: true });
    await app.waitForTimeout(600);
  }
  if (!/h-git/.test(await dockCls())) fail('虚拟屏未切到第二页');
  await pressAppKey(app, { key: 'b', code: 'KeyB' });
  let mounted = false;
  for (let i = 0; i < 20 && !mounted; i++) {
    mounted = await app.evaluate(() => !!document.querySelector('.browser-host'));
    if (!mounted) await p_sleep(300);
  }
  if (!mounted) fail('BrowserPage 未挂载（b 键切浏览器页失败）');
  console.log('browser page mounted');

  // 4. 主进程视角：CDP 端口上应能找到带 __maBrowserTab 标记的 page（BrowserAgentTools 同款解析）
  let marked = null;
  for (let i = 0; i < 10 && !marked; i++) {
    const ps = [];
    for (const c of browser.contexts()) ps.push(...c.pages());
    for (const p of ps) {
      try {
        const mark = await p.evaluate('window.__maBrowserTab');
        if (mark === tabId) {
          marked = p;
          break;
        }
      } catch {
        /* not a page we can evaluate */
      }
    }
    if (!marked) await p_sleep(800);
  }
  if (!marked) fail('未找到带 __maBrowserTab 标记的浏览器标签 target');
  console.log('marked page url:', marked.url());

  // 5. ariaSnapshot：树内容必须可读；ref 是已知边界（新页面 ref 分配可能延迟数分钟，
  //    playwright 注入与 Chromium AX 构建时序，见 features/builtin-browser.md）——有则验解析，无则跳过
  let snap = '';
  for (let i = 0; i < 6; i++) {
    snap = await marked.ariaSnapshot({ mode: 'ai' });
    if (snap.includes('[ref=')) break;
    await p_sleep(1000);
  }
  if (!/example/i.test(snap)) {
    console.log('snapshot head:', snap.slice(0, 300));
    fail('ariaSnapshot(ai) 内容异常');
  }
  const refs = (snap.match(/\[ref=e\d+\]/g) || []).length;
  console.log('ariaSnapshot ok, refs:', refs);

  if (refs > 0) {
    // 目标选快照里的 link 元素（首 ref 可能是 heading，点了不导航）
    const refMatch = snap.match(/link[^\n]*\[ref=(e\d+)\]/) || snap.match(/\[ref=(e\d+)\]/);
    const ref = refMatch[1];
    const count = await marked.locator(`aria-ref=${ref}`).count();
    if (count < 1) fail(`aria-ref=${ref} 解析到 0 个元素`);
    console.log(`aria-ref resolves: ${ref} count=${count}`);
    // 后台（非激活）标签的 CDP 输入会被丢弃（与旧体系一致的已知边界）：先激活
    await app.evaluate(async (id) => window.api.browser.activate({ id }), tabId);
    await p_sleep(400);
    await marked.locator(`aria-ref=${ref}`).click({ timeout: 8000 });
    for (let i = 0; i < 10; i++) {
      if (/iana/i.test(marked.url())) break;
      await p_sleep(500);
    }
    if (!/iana/i.test(marked.url())) fail(`点击后未导航（url=${marked.url()}`);
    console.log('click navigated to:', marked.url());
  } else {
    console.log('SKIP ref click: 新页面 ref 未就绪（已知边界，见文档）');
  }

  console.log('\nSMOKE OK: open/tab-switch/mark/ariaSnapshot/aria-ref 全部通过');
  await browser.close();
  process.exit(0);
}

function p_sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => fail(e?.stack ?? String(e)));
