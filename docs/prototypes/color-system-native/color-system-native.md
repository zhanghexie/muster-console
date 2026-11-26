# 配色真实组件对照

状态：历史方向对照，用户已据此授权正式实现。下文记录当时尚未迁移的组件对照；目前生产源码迁移已完成，实际验收见 生产覆盖与视觉复核，不以此运行时样式对照作为正式验收。

## 对照原则

- 同一个构建应用、同一份会话夹具、同一窗口尺寸与布局，不替换字体、圆角或组件。
- 保留当前主题基础色和工作区玫瑰色；不再采用独立 clear 稿的灰蓝色阶。
- 仅运行时注入 [color-system-native.css](color-system-native.css)：标签选中填充、工具面与内容面的关系、编辑器同底、调度状态胶囊、助手默认头像中性化、输入焦点和分隔线颜色。
- 这份对照用于确认方向，不作为完整 UI 迁移。终端、Git 状态、分屏高亮、设置各子页等仍依照 全域审查 与 实施计划 待改造和验收。

## 运行与隔离

```powershell
node scripts/capture-color-system-native.mjs
node scripts/build-color-system-native-preview.mjs
node scripts/build-color-system-native-preview.mjs --check
```

截图脚本读取已有 `out/` 构建，使用 `.tmp/color-native-*` 独立 cwd、userData 和 Git 夹具。聊天内容为经实际 preload 事件展示的测试数据，不调用模型。测试配置关闭 Web/MCP；飞书发现仍绕过配置探测全局绑定，因此脚本在加载主进程前阻断该专属外部适配器。未改个人配置或实际工作区。

输出在 `output/color-system-native/`，包含 PNG 原件、展示 JPG 和 `verification.json`。展示构建默认写入仓库内的 `output/color-system-native/preview.html`，可用 `--out <path>` 指定其他输出路径。该目录中的截图和生成展示页仅是本机验证产物，不提交 Git；新检出需先运行截图脚本再构建展示。展示页嵌入四张工作台截图，可以切换原版/微调、深色/浅色；图片比较不是可操作的工作台。

浏览器验证用 visualize 的 `scripts/render.py` 将展示片段包装为 `output/color-system-native/preview-check.html`，再执行 `node scripts/check-color-system-native-preview.mjs`。展示构建超过 1,000,000 bytes 会报错，不自行压低画质。

## 当前证据与边界

- 2026-10-09 实际 Electron 截图脚本退出 0，8 张工作台/外观设置深浅主题截图已生成；工作台四张及设置基线两张已查看。实际会话列表与聊天完整可见。
- 深浅主题分别断言原版与微调几何、字体和圆角一致；renderer 无异常。设置页未应用新规则，两种命名仅记录基线，不宣称设置问题已解决。
- 展示片段 988,047 bytes；构建自检覆盖四张映射、默认选择、切换、放大与状态恢复。真实 Chromium 验证四图解码、主题/版本按钮、键盘激活、窄屏放大与适应、无页面异常，宽/窄两张展示截图已查看。
- 桌面捕获曾含系统搜索遮挡，已弃用并覆盖；隐藏窗口无法产生截图合成帧，已关闭该实例。最终使用不获取焦点的可见窗口做应用 renderer 截图。
- 根框采用现有 `--workspace-frame-color` 不透明备用材质，排除桌面叠层干扰。中间和右侧仍是实际混色内容面；原生 Mica 与真实终端、网页 guest 图层未在此轮验收。
- 当前微调系临时设计 CSS，尚未成为正式 token 契约。最终配方在用户确认后锁定，并逐 UI 迁移。
