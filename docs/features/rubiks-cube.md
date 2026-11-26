---
doc_type: feature
---

# 魔方练习室

源码与扩展级回归位于 [muster-extension-rubiks-cube](https://github.com/zhanghexie/muster-extension-rubiks-cube)。扩展目录为 `rubiks-cube/`。

## 职责与入口

扩展 `rubiks-cube` 是人和 AI 共享当前局面的三阶魔方教学扩展。入口为扩展导航「魔方」。面板包含直接拖转、观察、键盘转层、公式练习卡和六面展开图，不提供自动求解器。重置练习是重建初始状态，不能作为 AI 已解出魔方的证据。

## 关键文件与数据流

- `rubiks-cube/model.mjs`：面坐标、贴片旋转、UDLRFB/MES 记号、面网格、单步状态差异判断与拖动方向选择。领域和渲染共用数学合同。
- `domain.mjs`：`cube.state`、`cube.analyze`；move/sequence/scramble/reset/undo。整组记号先校验再执行，避免部分成功。人的撤销仅在 worker 私有闭包保存操作前快照。
- `client/scene.js`：Three.js 按需渲染；圆角块体、独立圆角贴片、物理材质、环境光/阴影；Raycaster 与 Pointer Capture 决定手势。拖色块选层并连续预览，短拖/取消回弹；拖空白或 Alt 拖动改变观察视角，滚轮缩放。松手后的对齐从当前拖动分数继续，领域事件回流不会把这次本地拖动重新当成从零开始的外部转动。
- `client/turn-animation.js`：本地拖动提交与外部 Domain 状态回流的门控，避免异步状态事件重复播放固定起点动画。
- `client/App.jsx`：转动键盘、六面图、练习卡；练习卡逐步提交命令并等待对应转动落定。弹层接入共享 presence，转动时长与曲线读取宿主 motion token，减少动态时立即完成。
- 独立仓库的 `npm run build` 将 React/Three 和共享 UI 打为自包含 ESM。

面板 → 当前 SDK → ExtensionHost → 实例 DomainRuntime worker → `state.changed` → 面板刷新。面板根据当前/目标面状态判断单步动画，不读取历史来驱动渲染。关闭释放 renderer、几何、材质、环境纹理、Observer、事件和 RAF；静止时没有常驻渲染循环。

工作区为底部操作按钮预留空间，WebGL 画布绝对定位并填满剩余的观察区。展开或收起 AI 侧栏时，画布随容器调整尺寸，其固有宽高比不参与工作区布局。

## AI 边界

快照、查询与命令结果只包含 faces、moves、solved 及宿主版本信息，不含 history、actors、lastMove、lastActor 或倒放解法。`cube.hint` 已删除；`cube.analyze` 仅统计各面与当前中心同色的块数。AI 调用 undo 会被领域拒绝，不能以撤销偷取原路答案。宿主通用的人类活动摘要仅聚合命令名与次数，不含记号参数。

魔方状态仅为当前实例的练习，关闭实例后重新开始；观察视角也不持久化。中层转动移动中心块，复原判断按每面的当前中心，不假设中心始终停在初始方向。

操作键和六面展开图的托盘使用 SDK 表面与描边，公式和操作键可在窄栏换行，贴片颜色继续表达面向与局面。

## 验证

- 独立仓库的 `test/domain.mjs`：色块守恒、正反转、四次复位、中层、批量失败原子性、AI 不读历史和 undo 权限。
- 独立仓库的 `test/panel.spec.tsx`：面板命令、键盘反转、练习卡、逐步演示和六面图。
- `test/fixtures/teaching-extensions-capture.mjs`：真实 WebGL bundle + 领域，真实鼠标拖转/观察，深浅主题与窄布局；SDK 传输为模拟。
- `test/e2e/extensions-rubiks-panel.spec.ts`：Windows Electron、真实 worker/SDK、鼠标及 mock LLM 的 Agent 读写。

WebGL 不可用或上下文丢失时显示错误，不伪装为成功渲染。macOS/Linux 尚无真机验收。截图和记录位于 `.tmp/ui-captures/teaching-extensions/`，用户外观接受与自动化分开。
