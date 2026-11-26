# 页面折纸、入封与向上寄出

参考用户提供的 Smartisan 邮件发送录屏及折纸中间态截图。当前版本为**独立纸页 + 固定的开口信封**：上下各 1/3 同时向内折，纸面收起自然露出原本在后面的完整袋体；折好再入袋，上升时合盖并竖直飞出。现已接入 [会话邮箱](../../features/session-mailbox.md#前台收发信展示) 的前台通信展示，原待答卡片已移除，不要求用户回复。

## 对参考视频的拆解

源视频 `20261020224801_rec_-convert.mp4` 为 30fps、5 秒。重点逐帧查看约 0.83–1.70 秒：

- 上下各 1/3 的纸面同时向中心回折，起动、时长与角度同步；纸面抬起后自然露出在后面的独立信封。
- 下部袋体是完整固定的矩形，前片不折叠、不单独升起、没有 V 形裁片揭幕。只有上封盖会旋转；整个信封随后随组合上飞。
- 开口信封在纸后。纸页折短后仍露在袋口上方，随后缩进信封前片后面。
- 信封上升与装纸、扣盖重叠，连续向正上方加速离开；不存在「每个动作完成后停一下，再重起速」的节拍。

本地逐帧参考图在 `.tmp/envelope-study/reference-detailed.jpg`，未提交录屏、参考截图或自测截图。原型复现上述动作关系，不宣称反推出原作精确曲线参数。

## 预览与源码

- `envelope-send.html`：点击「寄出这页」播放。支持三倍慢放、暂停/继续、还原、重播、明暗切换及**逐帧进度拖动**。
- `envelope-send.tsx`：`EnvelopeSendStudy` 是预览控制器；纸封网格与时序已抽为 `src/renderer/src/components/envelope/EnvelopePaper.tsx`，原型继续重导出 `EnvelopePaper`、`envelopeTiming`、`envelopeDuration` 和 `envelopePlaybackRate`，与产品共用一份定义。逻辑时长1130ms，默认速度 `.9`，实际约1.26秒。前段折纸340逻辑毫秒，入袋、合盖与上飞的时长、曲线保持用户确认版本。
- `envelope-send.css`：三段铰链纸面、固定后袋/前袋、内外封盖与向上位移。仅纸、封盖和整体飞行有 transform 过渡，无关键帧。
- 构建：仓库根运行 `node scripts/build-envelope-send-study.mjs`。从现有 `base.css` 提取 motion token，内联 React bundle，无外部请求。

## 动作与曲线

全部 CSS transition 同一次样式提交启动，独立 delay/duration 表达重叠，**没有逐阶段 setTimeout 串行播姿势**。下表为内部逻辑时间；实际播放时间统一除以 `envelopePlaybackRate`，两折同步与动作重叠比例不变。

| 轨道 | 开始 / 完成 | 内容 |
|---|---|---|
| 上折 | 0 / 340ms | 纸页上段沿下缘向内折 |
| 下折 | 0 / 340ms | 下段沿上缘回折，与上折角度完全同步 |
| 袋体 | 全程固定 | 没有独立动画；由纸页折起后自然露出 |
| 信纸入袋 | 370 / 650ms | 纸相对信封下降，由不透明前片遮挡 |
| 信封上升 | 430 / 1130ms | 整个组合竖直向上，X 位移、旋转和飞行缩放均为零 |
| 合盖 | 570 / 730ms | 信纸已进入袋口后扣盖，上飞始终连续 |

时长全部取自 `MOTION` 组合，CSS 用控制器输出的变量。上下折、入袋与上升复用 `--ease-loop`，两折同曲线、同起点、同终点；封盖用 `--ease-move`。上升只有一个连续 transition，视口在它减速落定前将其裁出画面；从可见画面中呈现加速离开，不在画面内 ease-out 刹停。未新增曲线 token 或字面量 cubic-bezier。

袋体的缩放与坐标在整段折纸期间固定。只有纸页自己缩到适合信封的尺寸，收小过程与两折一起放慢；折好的纸下缘先完全高于袋口，再在统一时钟到 340ms 时切换 `data-paper-layer`，从前方纸层移到前片后方。此时没有重叠区域，切层不闪；370ms 起才沿纵向入袋，最终上下边缘都落在袋体内。袋体、袋面及袋口均不参与折叠、上移或缩放动画。

暂停、慢放及拖动通过 CSS transitions 对应的 `Animation` 对象控制 `pause/play/currentTime/playbackRate`，不会换成另一套关键帧；统一 RAF 时钟只用于进度与完成回调。根 `data-playing` 切 true 前先计算平页起始样式，重播不跳过折纸。

## 纸张外观

- 袋体四周为轻微的 3px 圆角，封盖通过每实例独立的 SVG `clipPath` 二次曲线裁切，三个角仅轻微软化；不是给三角形外框加 border-radius。
- 袋面、信纸与封盖外侧均为纯白 `#fff`，无暖黄色渐变和纤维贴图；封盖内侧及折纸背面仅用中性浅灰区分明暗。
- 袋体边沿约 0.6px、封盖纸边约 0.4px，只留很轻的中性灰接触阴影。保持薄纸感，不改变固定袋体、入袋遮挡和同步折纸关系。用户已确认默认速度 `.9`，本次外观调整保持该速度。

## 给接入方

1. 使用 `EnvelopePaper`、样式和 `envelopeTiming`；参照控制器，将同一网格宿主从 `data-playing=false` 切为 true，一次启动全部轨道。CSS `Animation.playbackRate` 和 RAF 累加时钟都乘 `envelopePlaybackRate`（慢放再除以 3）；逻辑时钟达到 `envelopeTiming.top.duration` 后将 `data-paper-layer` 从 `front` 改为 `inside`，还原或拖回折叠中时恢复 `front`。不要再恢复成串行的 top/bottom/turn/seal/fly 阶段，也不要给袋体另加揭幕或折叠。产品接入时将 `#envelope-send-study` 改为组件 class，避免多个实例重复 ID；保留网格随实例生成的封盖裁切定义。
2. `EnvelopePaper.children` 为同一份**静态展示快照**，三份切片分别显示纸张上中下段。不要传 live 表单、交互控件或重复 ID。默认纸面为 300×390，窄屏 264×384；任意尺寸卡片要先测量并同步宽度/每段高度，当前不是任意 DOM 自动截图封装。
3. 折叠中的纸页位于固定前袋上方，保证底部 1/3 的文字不被袋面提前截掉；折好并与袋口错开后才切到前袋后方入袋。前袋是一块静态完整矩形。内盖位于后层、外盖位于前层，两片共用同一铰链轨道。保持这一关系，否则会出现纸贴在前袋表面、提前被遮掉或盖子穿纸。
4. 产品从可见寄件视图的待寄事件开始预览，折纸后在上飞轨道起点请求存信。垂直轨道收到成功回执后继续。收件视图只从已存信事件起合并和反放，最后留出阅读时间。接入文件为 `MailEnvelopeViewport.tsx`、`envelope/useEnvelopeMotion.ts`、`envelope/mailEnvelopeQueue.ts` 和 `styles/mail-envelope.css`。反放先设置负速率并 play，再 seek 到共同终点，短轨道随共同逻辑时钟展开。已读和业务处理各有回执。原型预览仅播放动画。
5. 继续使用 `usePresence`、`MOTION` 和项目的减少动态效果偏好；中途开启 reduced motion 时立即完成并卸载。还原/卸载取消 RAF 与 CSS transition 实例。演示按钮、状态词、进度拖动和信纸文案不属于接入产品的必需 UI。

## 验证与边界

- `node scripts/test-unit.mjs test/unit/envelope-send-study.spec.tsx`：9 项组件回归，覆盖默认略慢播放及双时钟对齐、同步折纸/轨道重叠约束、纸张清空袋口后的层次切换、纸封分离、完整播放/卸载重播、暂停还原、慢放防重、拖动继续、减少动态效果和卸载回收。
- `node scripts/capture-envelope-send-study.mjs`：Windows Chrome 真浏览器播放与重播、原生插值暂停、前片遮挡、同时上飞/入纸/合盖、反向拖动、390px 深色无溢出、系统减少动态效果即时完成与页面异常检查。延长折纸后，对应姿势及上飞等间隔采样仍验证连续加速，后半段轨道保持原有节奏；不宣称与原作精确拟合。
- 覆盖用户截图二对应姿势的采样：整段折纸上下折角一致、袋体位置/尺寸完全不变、袋面自身无位移；折纸后纸的下缘高于袋口，入袋后整张纸位于袋体内。旧版负对照首先在「前袋不能升起」检查失败（原袋面自身位移 171.594px），修复后通过。
- 已实际查看浅色同步折叠、约 14% 中间态、完整袋体、入袋、封口和深色窄屏对应截图。采集输出为 `.tmp/envelope-study/revised-*`，均留本地。
- 产品回归另见 `test/unit/mail-envelope.spec.tsx` 和 `test/fixtures/mail-envelope*.{tsx,mjs}`；后者采样正向折叠、反向飞入/展开、静态阅读与减少动态效果，校验原生矩阵、同步双折、纯纵向飞行、13px 正文以及390px无溢出。产品纸面增加中性细边以便浅色白底辨认，不改变任何动作曲线。
- 使用共用 CSS/Chromium/React，无平台 API 分支；macOS/Linux 未真机验证。Windows Chrome 组件场景和隔离 Electron 链路可验证实现，用户真实工作布局观感仍由实际使用验收。
