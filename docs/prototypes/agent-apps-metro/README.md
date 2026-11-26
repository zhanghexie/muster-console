# 调度的随身应用 · Windows Phone 风格原型

用户明确希望应用采用手机 App 形态和 Windows Phone 极简设计语言，并已完整接受当前视觉。此目录是独立可点击视觉原型，尚未接入正式调度面板或外部账户。

本轮按五个应用中的三个交付：待办、短信、RSS 阅读器。附磁贴开始屏；闹钟和真实邮箱在开始屏明确标为“下一版”，禁用入口，不伪装成已实现。

## 预览

- 直接打开 `index.html`。React、样式、图标和机身图片全部内联，单独复制该文件也可以离线预览。
- 可服务预览：仓库根运行 `node docs/prototypes/agent-apps-metro/serve.mjs`，地址 `http://127.0.0.1:4247/`；端口可用 `METRO_PREVIEW_PORT` 设置。
- 源码变更后构建：`node docs/prototypes/agent-apps-metro/build.mjs`。
- 三屏对照与单屏体验、深浅主题、蓝/绿/洋红强调色；初次窄窗口默认单屏。

## 可操作范围

- 待办：今天/稍后/已完成，查看详情，新增、完成、恢复。
- 短信：全部/未读、搜索、读信清除本地未读数、线程、回复、新建对话。所有发送只更新演示数据，不调用飞书。
- RSS：未读/收藏/全部、搜索、阅读正文、收藏、调整演示订阅、文章加入待办。重复加入同一文章不产生重复任务，三屏即时共用数据。
- 开始屏：三种应用的可点击磁贴及实时计数。点击磁贴以 WP8 风格翻转飞入应用；机身 Home 键和 Escape 返回开始屏；单屏顶部选择器使用同一动效。
- 机身底部从左至右固定三个可操作按键：返回优先关闭详情/搜索，再回开始屏；开始屏再按返回恢复上一应用。Home 回开始屏并关闭当前详情/搜索。搜索查找当前应用内容（待办标题/说明、短信联系人/正文、RSS 标题/摘要/来源），在开始屏查找应用名称；它是本地原型搜索，不调用网络服务。
- 任务/消息/文章演示数据保存在浏览器 localStorage，可重置。主题、页面路由、筛选和演示订阅选择属于本轮页面状态；未实现真实同步、账号、后台调度或持久跨设备状态。

## 视觉与实现边界

参考微软的 [Windows Phone 导航与排版说明](https://learn.microsoft.com/en-us/archive/msdn-magazine/2011/december/windows-phone-how-to-translate-common-design-principles-to-the-windows-phone) 与 [Metro 设计原则](https://blogs.windows.com/windowsdeveloper/2011/02/17/from-transportation-to-pixels/)。采用大字号轻标题、Pivot 横向分类、纯色磁贴、方角内容、底部圆形命令按钮。正文和操作均为中文；英文字标只做应用小标题。

手机原型和工作台共用生成的黄色 Lumia 930 风格机身。机身按图片原始坐标对齐真实 HTML 屏幕和三个按键命中区域，顶部时间、信号和电量用于视觉演示。正式入口位于调度面板记忆按钮旁。[产品侧机身图片](../../../src/renderer/src/agentApps/assets/lumia-930-yellow.png) · [素材、生成提示词与截图](assets/README.md)

下一步的工具自动展示属于应用平台设计：默认自动弹出并跟随真实应用操作、可设置关闭、执行不等 UI；必须由 SDK/命令视图绑定和宿主展示调度器统一保证，覆盖未来 Agent 创作的应用。本原型没有假装接通真实工具事件。

`MetroApps.tsx` 提供共享 `Phone`、`ScreenHeader`、`Pivot`、`Command`、`Icon` 及三个应用视图。该组件层用于确认交互和视觉，不代表上一份设计草案中的 App SDK/权限/外部连接器已经实现。

详情使用生产 `usePresenceValue` 与 `mp-panel`；构建从生产 base.css 提取 motion token 和骨架样式，不另写进出场 keyframes 或字面量时长。新页面聚焦、返回恢复焦点、基础页面 inert、Escape 返回、减少动态效果均覆盖。

应用开合参考微软归档的 [TurnstileFeatherEffect](https://github.com/microsoftarchive/WindowsPhoneToolkit/blob/master/Microsoft.Phone.Controls.Toolkit/Effects/TurnstileFeatherEffect.cs)：沿内容左侧外的轴进行透视旋转，标题、分类、列表与命令栏错峰进出。它是按现有 motion token 重建的 WP8 风格动效，并非原版毫秒级复刻。`AppScene` 使用生产 `usePresence` 保留退场页，外层只管理在场，内部元素用 transform/opacity transition 完成飞入；`Phone` 管理方向与导航序号。初次展示不自动飞入，只有切换时播放。

最多 7 档延迟，避免长列表拖长总时长；返回可以打断入场，快速重开从当前 CSS 插值位置衔接。退场页立即 inert/aria-hidden，返回恢复对应磁贴焦点，旧计时器不会卸载新页。系统或宿主减少动态效果时立即切换；动效结束后解除 3D transform 和临时滚动限制，静止文字不常驻强制合成。

## 验证

- 历史 16 项原型组件交互用例覆盖飞入/退场、Escape、焦点、减少动态效果和机身按键；原型测试已移除。正式手机回归见 `test/unit/agent-phone.spec.tsx` 和 `test/unit/phone-feishu-setup.spec.tsx`，不声称原型场景逐项等价。
- `node docs/prototypes/agent-apps-metro/capture.mjs`：真实 Chromium 点击/输入，检查演示回复、文章加入待办、开始屏、390px 无横向溢出、减少动画与无运行时异常。
- `node docs/prototypes/agent-apps-metro/capture-motion.mjs`：采样真实播放中的 3D 矩阵与透明度、验证标题先于列表进入，截图 80/240/380/650ms 的浏览器真实 transition；覆盖快速反向后继续阅读、OS 减少动态效果、静止 transform 恢复为 none、390px 浅色。
- `node docs/prototypes/agent-apps-metro/capture-device.mjs`：核验素材真实透明像素、三个按键均位于屏幕下方/机身内部且能命中；实际点击 Home/返回/搜索，检查详情返回、开始屏回原应用、搜索焦点与应用筛选，并截图三机总览、开始屏及390px浅色。
- 截图生成在 `output/playwright/agent-apps-metro/`（本机生成产物，不提交）：深浅总览、短信线程、阅读详情、开始屏、窄屏深浅共7张。
- 动画追加4张中间帧、1张窄屏浅色图和 `motion-samples.json`。截图脚本先等待目标页面，避免把切换前的旧页面误认作动画结束；按钮使用精确名称避免匹配正文。
- 以上截图、动效与设备脚本有历史 Windows Chromium 记录。正式应用另有对应功能验收。[调度手机应用](../../features/agent-apps.md)
- 2026-11-22 重建后，在 macOS Chromium 断网环境下用 `file://` 打开仅含 `index.html` 的目录。1366 px 三屏和 390 px 单屏都成功解码内联机身图，其字节与产品侧 PNG 一致。窄布局切换到浅色后可用 Home 打开开始屏，再点磁贴打开待办。全过程产生 0 个网络请求，三张前后对照截图逐张一致。
