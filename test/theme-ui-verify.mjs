/**
 * 主题系统 CDP 实测：针对运行中的 dev 应用（--remote-debugging-port=9222）。
 * 验证：默认深色 → 切浅色界面变量/终端即时变化 → 新建主题（复制深色、文件格式化）
 *       → JSON 保存后界面自动刷新 → 设置面板「主题外观」页可见。
 */
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CDP_BASE = 'http://127.0.0.1:9222';
let msgId = 0;
let ws;
const pending = new Map();

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression) {
  const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(`evaluate 异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  }
  return r.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(name) {
  const res = await rpc('Page.captureScreenshot', { format: 'png' });
  const out = path.join(os.tmpdir(), `theme-ui-${name}.png`);
  fs.writeFileSync(out, Buffer.from(res.data, 'base64'));
  console.log('SHOT:', out);
  return out;
}

async function main() {
  const targets = await (await fetch(`${CDP_BASE}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  await rpc('Runtime.enable');
  await rpc('Page.enable');

  // 就绪等待 + 状态对齐：activate('dark') 触发 themes:changed，渲染层重应用到当前主题
  for (let i = 0; i < 50; i++) {
    try {
      await evalJs("window.api.themes.activate('dark')");
      const cv = await evalJs("getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim()");
      if (cv === '#1a1a1a') break;
    } catch { /* 页面重载中 */ }
    await sleep(300);
  }
  // 1. 默认状态：深色生效
  const list0 = await evalJs('window.api.themes.list()');
  assert.equal(list0.activeId, 'dark', '默认当前主题是深色');
  assert.deepEqual(list0.themes.map((t) => t.id), ['dark', 'light'], '初始只有两个内置主题');
  const darkCanvas = await evalJs("getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim()");
  assert.equal(darkCanvas, '#1a1a1a', '深色 --bg-canvas 生效');
  const termDark = await evalJs("document.querySelector('.xterm') ? 'term' : 'no-term'");
  console.log('PASS: 深色默认生效, xterm:', termDark);
  await shot('1-dark');

  // 2. 切浅色：CSS 变量 + color-scheme 即时变化
  await evalJs("window.api.themes.activate('light')");
  await sleep(400);
  const lightCanvas = await evalJs("getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim()");
  assert.equal(lightCanvas, '#ffffff', '浅色 --bg-canvas 即时生效');
  const dt = await evalJs('document.documentElement.dataset.theme');
  assert.equal(dt, 'light', 'data-theme=light');
  const cs = await evalJs("getComputedStyle(document.documentElement).colorScheme");
  assert.equal(cs, 'light', 'color-scheme=light（原生控件浅色）');
  const bodyBg = await evalJs('getComputedStyle(document.body).backgroundColor');
  assert.ok(bodyBg.includes('255, 255, 255'), 'body 背景跟随浅色（旧名兼容层 --bg 同步）');
  console.log('PASS: 浅色主题切换即时生效');
  await shot('2-light');

  // 3. 新建主题：复制默认深色
  const created = await evalJs('window.api.themes.create("夜蓝")');
  assert.ok(created.ok, '创建成功');
  assert.equal(created.theme.id, 'theme', '中文名 id 回退 theme');
  assert.equal(created.theme.colors['bg-canvas'], '#1a1a1a', '新主题复制深色');
  const dir = (await evalJs('window.api.themes.list()')).dir;
  const fileText = fs.readFileSync(path.join(dir, 'theme.json'), 'utf8');
  assert.ok(fileText.includes('\n  "colors"'), '文件是 2 空格格式化 JSON（非单行）');
  assert.ok(fileText.split('\n').length > 50, '文件多行');
  console.log('PASS: 新建主题=复制深色，JSON 文件已格式化落盘:', path.join(dir, 'theme.json'));

  // 4. 激活新主题并改 JSON 保存 → 界面自动刷新
  await evalJs('window.api.themes.activate("theme")');
  await sleep(300);
  const edited = JSON.parse(JSON.stringify(created.theme));
  edited.colors['bg-canvas'] = '#0b1220';
  edited.colors['bg-panel'] = '#0f172a';
  const saved = await evalJs(`window.api.themes.save(${JSON.stringify(edited)})`);
  assert.ok(saved.ok, '保存成功');
  await sleep(500);
  const afterCanvas = await evalJs("getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim()");
  assert.equal(afterCanvas, '#0b1220', '保存当前主题后界面变量自动刷新');
  const savedText = fs.readFileSync(path.join(dir, 'theme.json'), 'utf8');
  assert.ok(savedText.includes('"bg-canvas": "#0b1220"'), '文件内容已更新');
  assert.ok(savedText.includes('\n    "bg-canvas"'), '更新后仍保持格式化缩进');
  console.log('PASS: JSON 保存 → 界面自动刷新，文件保持格式化');
  await shot('3-custom');

  // 5. 非法 JSON 被闸门拦住
  const bad = JSON.parse(JSON.stringify(created.theme));
  bad.colors.green = 'not-a-color';
  const badRes = await evalJs(`window.api.themes.save(${JSON.stringify(bad)})`);
  assert.equal(badRes.ok, false, '非法色值被拒绝');
  assert.ok(badRes.errors[0].includes('green'), '错误信息指出字段');
  console.log('PASS: 非法色值被校验闸门拦截:', badRes.errors[0]);

  // 6. 设置面板「主题外观」页：打开设置并截图
  await evalJs(`(() => {
    const btn = document.querySelector('.chrome-settings');
    if (btn) btn.click();
    return 'clicked';
  })()`);
  await sleep(600);
  // 切到「主题外观」页（第二个 nav 项）
  await evalJs(`(() => {
    const items = Array.from(document.querySelectorAll('.settings-nav-item'));
    const t = items.find((el) => el.textContent.includes('主题外观'));
    if (t) t.click();
    return 'tab';
  })()`);
  await sleep(600);
  const paneVisible = await evalJs("!!document.querySelector('.theme-json')");
  assert.ok(paneVisible, '主题 JSON 编辑器出现在设置面板');
  const paneText = await evalJs("document.querySelector('.theme-json').value");
  assert.ok(paneText.includes('\n  "colors"'), '编辑器内容是格式化 JSON');
  const rows = await evalJs("document.querySelectorAll('.theme-row').length");
  assert.equal(rows, 3, '列表含 2 内置 + 1 自定义');
  console.log('PASS: 设置「主题外观」页渲染正常（列表/JSON 编辑器）');
  await shot('4-settings-pane');

  // 7. 在面板里走完整流程：新建（复制深色）→ 编辑保存 → 自动刷新
  await evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('.theme-pane button')).find((b) => b.textContent.includes('新建主题'));
    btn.click(); return 'new-clicked';
  })()`);
  await sleep(300);
  await evalJs(`(() => {
    const input = document.querySelector('.theme-create-box input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '暖橙');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  await sleep(200);
  await evalJs(`(() => {
    const ok = Array.from(document.querySelectorAll('.theme-create-actions button')).find((b) => b.textContent.trim() === '创建');
    ok.click(); return 'create-clicked';
  })()`);
  await sleep(700);
  const listNow = await evalJs('window.api.themes.list()');
  assert.equal(listNow.themes.length, 4, '面板新建成功（含新主题）');
  const warmOrange = listNow.themes.find((t) => t.name === '暖橙');
  assert.ok(warmOrange, '新主题名正确');
  // 编辑 JSON：改 panel 色并保存
  await evalJs(`(() => {
    const row = Array.from(document.querySelectorAll('.theme-row')).find((r) => r.textContent.includes('暖橙'));
    row.click(); return 'selected';
  })()`);
  await sleep(500);
  await evalJs(`(() => {
    const ta = document.querySelector('.theme-json');
    const next = ta.value.replace('"bg-panel": "#1e1e1e"', '"bg-panel": "#2b1d12"');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, next);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'edited';
  })()`);
  await sleep(200);
  const saveDisabled = await evalJs("(() => { const b = Array.from(document.querySelectorAll('.theme-editor-actions button')).find((b) => b.textContent.includes('保存')); return b.disabled; })()");
  assert.equal(saveDisabled, false, '有改动后保存按钮可用');
  await evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('.theme-editor-actions button')).find((b) => b.textContent.includes('保存'));
    btn.click(); return 'save-clicked';
  })()`);
  await sleep(700);
  const warmFile = fs.readFileSync(path.join(dir, `${warmOrange.id}.json`), 'utf8');
  assert.ok(warmFile.includes('#2b1d12'), '面板保存写入文件');
  assert.ok(warmFile.includes('\n    "bg-panel"'), '面板保存的文件仍格式化');
  const okMsg = await evalJs("document.querySelector('.settings-ok')?.textContent");
  console.log('PASS: 面板新建→编辑→保存 全链路；提示:', okMsg);
  await shot('5-settings-saved');

  // 8. 切回深色收尾（不打扰用户默认观感）
  await evalJs("window.api.themes.activate('dark')");
  await sleep(300);
  console.log('theme-ui: ALL PASS');
  ws.close();
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
  try { ws?.close(); } catch {}
});
