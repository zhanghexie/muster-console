# 真实组件截图与真 app 验证

## 组件夹具：最常用的局部 UI 验证

脚本 `scripts/capture-component.mjs` 在仓库内定位依赖，esbuild 打包 TSX，动态本地端口启动独立 Chromium；使用生产 CSS，逐组独立页面，输出 PNG、`manifest.json` 和 `index.html`。浏览器与临时构建目录在结束时清理，不改 app 的真实配置。

```powershell
# 默认示例：AgentComposer / ChatMessageView，空、编辑、列表续写、发送后四个状态
node .agents/skills/ui-verification/scripts/capture-component.mjs

# 确定输出位置；只选择当前风险需要的主题/宽度
node .agents/skills/ui-verification/scripts/capture-component.mjs --out .tmp/ui-captures/my-task --themes light,dark --widths 780,390

# 指向自定义生产组件夹具和动作模块
node .agents/skills/ui-verification/scripts/capture-component.mjs --fixture .tmp/my-task/fixture.tsx --scenario .tmp/my-task/scenario.mjs --target .my-panel --styles base,chat,float --out .tmp/ui-captures/my-task
```

`--chrome` 可指定浏览器可执行文件；否则用 Windows 常见 Chrome 路径或 Playwright 默认 Chromium。缺浏览器时说明依赖缺失，不自动安装/切换成纯 DOM 并假称视觉已验证。

### TSX 夹具契约

- 模块自行挂载到 `#root`，导入**本次生产组件**；`@workbench/` 由脚本映射到仓库根。复制随附 `assets/composer-fixture.tsx` 到 `.tmp/` 时一起复制 `fixture-api.ts`（本地相对 import），再替换目标组件和场景。
- 在首个生产模块求值前装好必需 `window.api` mock。随附 `assets/fixture-api.ts` 记录调用，读取返回符合 store 形状；未知调用记录到 `window.__uiFixture.unmocked`，不能据此断言真实 IPC 正常。
- 从 query 取 `theme`，通过生产 `applyTheme(builtinTheme(theme))` 应用主题，不只改 `data-theme`；需要本次真实工作区色时在夹具中走对应生产逻辑。
- 生产字体由 base.css 加载；有用户自定义字体时走实际初始化或指定 `--font`。以真实已加载的 FontFace 与目标 computed family 共同确认，不能凭字体名出现在 CSS 中宣称加载成功。
- 模拟发送回调只收集草稿；若要证明 app 管线，升级为 Electron。
- CSS 顺序与当前 `src/renderer/src/styles.css` 对照。只加载用到的 CSS；弹层、队列、批注往往还需 `float`、`agent-chat` 等文件。

### 动作模块契约

导出默认 async 函数，参数 `{ page, theme, width, capture, assert }`。用真实 locator/按键进入状态，在关键点调用 `await capture('editing')`。可以读取夹具收集的回调值并断言最终内容。

```js
export default async function ({ page, capture, assert }) {
  const editor = page.getByRole('textbox');
  await editor.waitFor();
  await capture('empty');
  await editor.click();
  await editor.pressSequentially('1. xxxx');
  await editor.press('Shift+Enter');
  assert.equal(await editor.locator('[data-md="ordered"]').last().getAttribute('data-marker'), '2.');
  await capture('continued');
}
```

默认 `capture` 等待两个绘制帧，隐藏闪烁光标并禁动画。中间态/动画验证使用 `capture('mid-motion', { animations: 'allow', caret: 'initial' })`，场景自己控制截取时机；脚本不自动冻结整个 app。

`--target` 决定测量元素，PNG 仍保留整个 viewport 的上下文；需要对照边距时保留共同父框。每张记录 viewport、目标边界/scroll 尺寸、computed 字体/颜色/背景和页面溢出情况。脚本不替你判断审美或所有可访问性问题。

### 字体与错误口径

- 默认要求声明字体（OPPO Sans）的 400/500 FontFace 已加载，且 `--target` computed family 使用它。字体超时也会输出现有截图/清单并返回失败。
- 仅验证行为、且明确允许字体回退时传 `--allow-fallback-font`；manifest 标记回退风险。不能用这次图片证明 OPPO 字体可读性通过。
- pageerror、console.error、失败请求和未知 mock 调用进入 manifest；前两者与场景断言失败使命令失败。失败请求/未知 mock 要按本次功能判断，不自动忽略。
- `visualReview` 始终初始为 `pending`。打开实际 PNG 后在产物目录写简短 `review.md`，注明看过哪些图、对应预期、问题及未覆盖状态。不要预先写「已通过」。

## 完整应用 / Electron

先读 `docs/features/ui-capture.md`。本仓 `npm run capture:ui` 会启动**真实 userData 的非沙盒实例**并遍历主要页面，导航可持久化布局/页签；它不是隔离组件测试，也不是每个 UI 修改的必跑项。用户要求整 app 审查或局部夹具不足时才选择它，先了解现有运行实例/数据范围。

需要主进程链路时，复用 `test/e2e/fixtures/electron.ts` 的 dev-sandbox 隔离，并执行本次 spec：

```powershell
npm run build
npx playwright test test/e2e/composer-send-actions.spec.ts
```

只用新构建验证新的源码；不能拿安装版旧产物的图验收当前补丁。沙盒夹具共享 `.dev-sandbox` 且会重置数据，因此不要和其他 Electron E2E 并行跑；先确认该沙盒没有被别人占用。

已经有合适的真 app/CDP 实例时可以聚焦目标状态截图，避免为了一个控件重跑全页面。附加后不关闭自己没有启动的应用，不改真实会话/任务来造数据，除非任务已有授权。只有性能/掉帧任务才另读项目 `perf-trace` 技能。

## 视觉检查：数字与图结合

- **字体**：中文、英文、数字、placeholder、辅助文本；OPPO Sans 只用 400/500，600 会匹配到 700。实际字体以当前设置为准，不擅自换成 MiSans。
- **对比**：将透明色与祖先底色合成后再计算对比，检查选中与闲置项并排的效果；CSS token 自身的值不等于最终像素。
- **边距**：比较实际框边与可见内容边；margin/padding/滚动条/缩放可能共同作用。统一 token 后仍需看展开、折叠、悬浮等本次相关状态。
- **拖动重影**：固定背景快照与活内容重排容易形成两套字；需要像素/真实截图对照，静态 DOM 或 z-index 断言不够。
- **长文与窄屏**：长名称、列表换行、消息/文件正文、按钮可达性；弹层不能被输入条或祖先 overflow 遮掉。
- **指针与焦点**：稳定态对照截图将鼠标移到不触发 UI 的空白处；hover/速览状态保留指针。记录焦点，因为它会改变描边/选区/工具提示。
- 仅有故障后的图无法评估回归幅度时，补同尺寸/主题/内容的前后对照；不同窗口与字体造成的差异不要归因到本次代码。

如果截图工具因权限/访问策略拒绝某页面，说明限制；不能换工具重开被拒页面或把同一页面另行托管来绕过。只可在允许的范围内用独立生产组件夹具，并说明覆盖边界。
