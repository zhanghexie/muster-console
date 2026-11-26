# Computer Use / GUI Agent：2026-11 现状与 host.desktop 设计校验

查询日期：**2026-11-03（北京时间）**。对照对象：控制面方案第 4、6、7、9 节。仅外部调研；未修改该方案、产品代码，未安装或运行外部 Agent。

## 1. 结论与证据口径

**保留五个顶层动词和统一执行底座；改坐标、能力协商、授权与验证合同。** `list / look / act / focus / launch` 是合理的宿主 API 组织方式，但不是厂商通用协议；模型原生工具需要版本化适配。语义树与截图双路已有直接先例；“只支持逻辑坐标”“网页不给 ref”“Wayland 无注入”“仅 desktopCapturer 就能完成窗口枚举”均不能照原文字面实施。

最值得借鉴的三点：

1. **Cua Driver 的精确目标、双路观测、语义后台优先和 effect 回执**。这是最贴近本方案的执行底座；其平台支持是作者测试声明，本次没有复跑。[架构](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works)
2. **Playwright MCP / Jev 的快照引用与执行前检查**。文本模型操作有语义的界面已可行；目标必须属于新鲜观察，不能让模型随意编造 selector、ref 或坐标。[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[Jev](https://github.com/browser-use/jev-ultrafast)
3. **执行结果和任务结果分开**。OpenAdapt 区分完成未验证与 VERIFIED；Cua 区分发送、确认、部分完成和拒绝。`act` 返回成功不能直接代表“已保存”。[OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt)

最该避的三坑：单一 dpiScale 变换；后台输入失败后静默抢前台；以通用任务授权覆盖付款/发送/越权应用等尚未授权的副作用。后文给具体合同及修改位置。

### 本次核实的方法

- GitHub 数字来自 `GET https://api.github.com/repos/<owner>/<repo>`；默认分支最近提交来自 `/commits?per_page=1`，匿名限流后用该仓库 `/commits/<default_branch>.atom`。**pushed_at 不当作最近提交时间**。
- [数据快照 CSV](computer-use-landscape-2026-11-03-repos.csv)保存查询时间、精确 star、license 检测值、默认分支、commit SHA/时间/来源、pushed_at、created_at、archive 状态。代码许可证与模型权重、子目录、商业发行版分别判断。
- 平台/行为依据官方 README、文档、API 契约。下表的“支持”均指这些来源声明，**Windows/macOS/X11/Wayland 本次全部未真机验收**。未复跑基准、未支付模型调用费。
- 活跃度仅用最近默认分支提交：距查询日 ≤30 天“近月”，31–180 天“近半年”，>180 天“较旧”，归档单独标。它不能证明维护质量，也不能用一个文档提交证明驱动仍有效。
- 同名项目先按官方链接确认：OpenAI 为 `openai-cua-sample-app`，Gemini 为 `computer-use-preview`，OS-Atlas 属 `OS-Copilot`，ScreenSpot-Pro 属 `likaixin2000/ScreenSpot-Pro-GUI-Grounding`。最初候选 URL 的 404 不等于项目消失。
- 旧报告 2026-09 调研只作检索线索，不沿用其中排行榜数字或“停更”结论；例如当前 self-operating-computer 默认分支已有 2026-10 提交。Star 单点不能证明增长速度。

## 2. 商业方案：统一维度比较

商业服务的 star/license 不适用；参考代码另列 §3。下表平台指**被控环境**，不是 SDK 能在哪个 OS 发 HTTP 请求。G=模型完成坐标 grounding；“恢复”不保证业务正确。

| 方案 / 当前状态 | 平台 Win / Mac / X11 / Wayland | 感知与动作 / G | 恢复、自检、授权 | Electron/桌面与硬边界 |
|---|---|---|---|---|
| [Anthropic Computer Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)：客户端工具集 `computer_toolset_20260801`，17 成员；旧版本另有兼容路径 | 执行环境自备；参考实现 Linux 虚拟桌面，不能推导四平台驱动支持 | 像素；点击/多击、移动、拖曳、按住、输入、键、滚动、截图、zoom、wait；G 是 | 顺序执行工具并回送结果；注入检测、建议隔离环境与重大后果确认；没有替宿主实现事务回滚 | 可操作桌面；宿主负责捕获/输入；坐标为**完整截图像素**，zoom 后仍用原空间 |
| [OpenAI Computer Use](https://developers.openai.com/api/docs/guides/tools-computer-use)：当前 SDK ComputerToolset / Responses 路线；Operator 是历史产品入口 | 自备浏览器或桌面；具体平台看 driver，不按模型名承诺 | 像素及可组合代码/工具；键鼠、滚动、截图；G 是 | 短动作组后重新观察；隔离、站点/动作范围、取消、预算与重大动作确认 | 支持接桌面执行器；不是提供跨平台 window API；缩图需逆变换 |
| [Gemini Computer Use](https://aistudio.google.com/docs/computer-use)：当前文档含 browser/mobile/desktop，不再只限早期浏览器 preview | 新模型声明多环境；参考仓仍主要 Playwright/Browserbase；各 OS 原生驱动未核实 | 像素；click/type/scroll/key/drag 等，动作带 intent；G 是，坐标 **0–1000 归一化** | safety_decision 为 allowed / require_confirmation / blocked；执行后 screenshot + result；client 必须实际处理闸门 | 模型桌面能力不等于样例已有 Windows/macOS 执行器 |
| [Claude 桌面 / Cowork / Code](https://claude.com/resources/articles/dispatch-and-computer-use)：2026 产品实践 | 官方该篇明确 Win/Mac；X11/Wayland 未核实 | connector 优先，再浏览器和屏幕输入；G 有；内部完整 schema 未公开 | 新应用请求授权、可中断；研究预览，不能视为无人值守保证 | 直接桌面产品；拿它证明“按应用授权”可行，不能照搬未公开驱动 |
| [ChatGPT agent / Operator 后续](https://openai.com/index/introducing-chatgpt-agent/) | 历史发布是云端虚拟电脑；本机四平台支持不能由此推出 | 视觉浏览器、文本浏览器、终端、connector 混合；G 有 | 接管、暂停、重要后果确认；历史文档有 watch mode | 发布页明确标已过时；只作架构先例，**不作 2026 当前 SKU/平台依据** |
| [Perplexity Computer](https://hub-prod.perplexity.ai/) | 官方索引可见 Mac/Windows 产品条目；X11/Wayland 未核实 | 本机文件+服务+网页工作流；底层动作/grounding 协议未核实 | 安全文章正文抓取失败；不替它补造授权模型 | 2026 产品候选，当前证据不足以选其闭源底座 |

这里存在一种共同中间形态：先批准任务范围，在范围内自动执行，遇到**新应用、敏感副作用或模型安全闸门**再停下；并非逐点击弹窗，也并非一次批准后永不再问。不要把厂商模型的 safety_decision 当成宿主权限系统。

## 3. 开源框架与 Agent

### 3.1 数字与许可证（完整原始字段见 CSV）

| 仓库（官方来源） | Star | 最近默认分支提交 UTC | 活跃度 | 根 license / 特别边界 |
|---|---:|---|---|---|
| [trycua/cua](https://github.com/trycua/cua) | 31,608 | [2026-11-03T02:33:33Z](https://github.com/trycua/cua/commit/41404b6e797d9c44894ae910859db60303801b4a) | 近月 | MIT；Spaces/Bench 为 FSL，感知扩展另看 |
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | 119,885 | [2026-10-30T04:28:48Z](https://github.com/browser-use/browser-use/commit/b49a68e4060acb226da8f784194fef301c53a6d7) | 近月 | MIT |
| [bytedance/UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) | 39,529 | [2026-10-09T01:29:51Z](https://github.com/bytedance/UI-TARS-desktop/commit/3ac2cb8d946d78d5ff92ad17b318eaafa18c178c) | 近月 | Apache-2.0 |
| [bytedance/UI-TARS](https://github.com/bytedance/UI-TARS) | 11,666 | [2025-09-05T03:28:26Z](https://github.com/bytedance/UI-TARS/commit/582f3a7ea5d285ee8ed9e2e84048d1ab01453c49) | 较旧 | Apache-2.0 |
| [simular-ai/Agent-S](https://github.com/simular-ai/Agent-S) | 12,860 | [2026-10-21T21:03:57Z](https://github.com/simular-ai/Agent-S/commit/0fff0e634869dab72027435b4586e62300185d41) | 近月 | Apache-2.0 |
| [microsoft/OmniParser](https://github.com/microsoft/OmniParser) | 25,602 | [2026-07-20T01:09:31Z](https://github.com/microsoft/OmniParser/commit/354021201345a96178360b28733573e27269f2de) | 近半年 | CC-BY-4.0；权重分版本 |
| [microsoft/UFO](https://github.com/microsoft/UFO) | 10,167 | [2026-10-14T04:20:48Z](https://github.com/microsoft/UFO/commit/eae3c0a8d168c47cb10df0652e293e092eda1078) | 近月 | MIT |
| [OpenAdaptAI/OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) | 1,862 | [2026-11-03T04:07:39Z](https://github.com/OpenAdaptAI/OpenAdapt/commit/9633d065f5d7cc4af56a7256fe27717012fd86c9) | 近月 | MIT |
| [OthersideAI/self-operating-computer](https://github.com/OthersideAI/self-operating-computer) | 10,300 | [2026-10-19T21:08:10Z](https://github.com/OthersideAI/self-operating-computer/commit/eb8165a2efb1b34d66a28ecebf8ca97ae67cbb79) | 近月 | MIT |
| [bytebot-ai/bytebot](https://github.com/bytebot-ai/bytebot) | 11,065 | [2025-09-11T15:36:50Z](https://github.com/bytebot-ai/bytebot/commit/3d37894ce07ef8d8b40adc7fd309ad96c2a71313) | 归档 | Apache-2.0 |
| [Skyvern-AI/skyvern](https://github.com/Skyvern-AI/skyvern) | 23,336 | [2026-11-03T01:53:17Z](https://github.com/Skyvern-AI/skyvern/commit/139a954652e06651baa9b3a21e8572c2df668bda) | 近月 | AGPL-3.0 |
| [browserbase/stagehand](https://github.com/browserbase/stagehand) | 25,914 | [2026-11-03T01:19:28Z](https://github.com/browserbase/stagehand/commit/9afa0952453e219f7164a0ea16cf293d3dcaddde) | 近月 | MIT |
| [web-infra-dev/midscene](https://github.com/web-infra-dev/midscene) | 15,480 | [2026-11-02T13:40:35Z](https://github.com/web-infra-dev/midscene/commit/fa2ecdff05106b71b210298bcd8b8c9cd80e52d6) | 近月 | MIT |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 39,072 | [2026-11-01T23:12:54Z](https://github.com/microsoft/playwright-mcp/commit/ec572ee8354015293bed67145db21eed386e876d) | 近月 | Apache-2.0 |
| [modelcontextprotocol/servers-archived](https://github.com/modelcontextprotocol/servers-archived) | 305 | [2025-05-28T17:57:09Z](https://github.com/modelcontextprotocol/servers-archived/commit/9be4674d1ddf8c469e6461a27a337eeb65f76c2e) | 归档 | MIT |
| [anthropics/claude-quickstarts](https://github.com/anthropics/claude-quickstarts) | 19,086 | [2026-11-02T14:11:21Z](https://github.com/anthropics/claude-quickstarts/commit/8ef47d719eba5379ff8f38133f5defcc499e856f) | 近月 | MIT |
| [asweigart/pyautogui](https://github.com/asweigart/pyautogui) | 12,753 | [2023-06-07T11:16:23Z](https://github.com/asweigart/pyautogui/commit/b4255d0be42c377154c7d92337d7f8515fc63234) | 较旧 | BSD-3-Clause |
| [nut-tree/nut.js](https://github.com/nut-tree/nut.js) | 2,854 | [2024-05-01T19:50:13Z](https://github.com/nut-tree/nut.js/commit/e413fa1f19a19c4631812e4e1eaf47aa732b5cbe) | 较旧 | 未核实 |
| [pywinauto/pywinauto](https://github.com/pywinauto/pywinauto) | 6,356 | [2026-10-28T18:05:50Z](https://github.com/pywinauto/pywinauto/commit/a428d9617a429a76779d235f0702ec0e94b26214) | 近月 | BSD-3-Clause |
| [FlaUI/FlaUI](https://github.com/FlaUI/FlaUI) | 3,192 | [2026-08-13T21:45:20Z](https://github.com/FlaUI/FlaUI/commit/fd7cc64ab01908a0ae4cc7d05e704caa34f98d16) | 近半年 | MIT |
| [jordansissel/xdotool](https://github.com/jordansissel/xdotool) | 3,868 | [2026-09-20T16:35:03Z](https://github.com/jordansissel/xdotool/commit/14ca26a2c95035f9c635a6a11d075e8d7d0d6529) | 近半年 | BSD-3-Clause |
| [ReimuNotMoe/ydotool](https://github.com/ReimuNotMoe/ydotool) | 2,379 | [2025-12-22T04:22:09Z](https://github.com/ReimuNotMoe/ydotool/commit/708e96ff27e381a8c549418a9d34cdde12305317) | 较旧 | AGPL-3.0 |
| [xlang-ai/OSWorld](https://github.com/xlang-ai/OSWorld) | 3,249 | [2026-11-02T16:12:55Z](https://github.com/xlang-ai/OSWorld/commit/8903ebeb0efdf74331bd7dc37ed91ccbbff22317) | 近月 | Apache-2.0 |
| [microsoft/WindowsAgentArena](https://github.com/microsoft/WindowsAgentArena) | 915 | [2026-10-26T18:12:13Z](https://github.com/microsoft/WindowsAgentArena/commit/eb220c4dcf64babefc1bfc287edda91ab04132ed) | 近月 | MIT |
| [OSU-NLP-Group/UGround](https://github.com/OSU-NLP-Group/UGround) | 321 | [2026-08-24T03:53:48Z](https://github.com/OSU-NLP-Group/UGround/commit/8974f95b0685f139a6257f82d6b13895db3356cf) | 近半年 | MIT |
| [showlab/ShowUI](https://github.com/showlab/ShowUI) | 1,929 | [2026-04-24T07:16:50Z](https://github.com/showlab/ShowUI/commit/21ed7cb24be0cc877bb8352ee34d58a9aea2c876) | 较旧 | Apache-2.0 |
| [web-arena-x/webarena](https://github.com/web-arena-x/webarena) | 1,640 | [2025-11-26T21:15:59Z](https://github.com/web-arena-x/webarena/commit/dce04686a56253aefba7b18a4fa0937cf1dc987b) | 较旧 | Apache-2.0 |
| [MinorJerry/WebVoyager](https://github.com/MinorJerry/WebVoyager) | 1,128 | [2024-03-04T03:35:46Z](https://github.com/MinorJerry/WebVoyager/commit/5a7896738c10bfb8b9edccce6bb0e0411f8ae569) | 较旧 | Apache-2.0 |
| [microsoft/fara](https://github.com/microsoft/fara) | 6,243 | [2026-07-22T17:03:30Z](https://github.com/microsoft/fara/commit/a675d6d61c41c47ae87bacefeab22caad18e3e84) | 近半年 | MIT |
| [MSR-Orchard/WildAWM](https://github.com/MSR-Orchard/WildAWM) | 85 | [2026-10-21T00:02:43Z](https://github.com/MSR-Orchard/WildAWM/commit/aff585da70c82ab96d83b8a72ccdcb16d6f0f67a) | 近月 | 未核实 |
| [OS-Copilot/OS-Atlas](https://github.com/OS-Copilot/OS-Atlas) | 455 | [2025-04-20T15:59:31Z](https://github.com/OS-Copilot/OS-Atlas/commit/bad08407ab54b5bf6c17a69fe1ced476b9494926) | 较旧 | Apache-2.0 |
| [cloudflare/computer](https://github.com/cloudflare/computer) | 9,780 | [2026-11-02T22:47:46Z](https://github.com/cloudflare/computer/commit/058f8714a87389c4260013207759f4b81545879d) | 近月 | MIT |
| [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) | 24,102 | [2026-10-31T17:35:44Z](https://github.com/browser-use/jev-ultrafast/commit/8251e272398011cdef648965204d1c20cd838333) | 近月 | MIT |
| [meituan/EvoCUA](https://github.com/meituan/EvoCUA) | 355 | [2026-03-31T05:16:36Z](https://github.com/meituan/EvoCUA/commit/4a0ad5fd4eb1d5b65966e1c7cc3feaa3b534eadd) | 较旧 | Apache-2.0 |
| [openclaw/Peekaboo](https://github.com/openclaw/Peekaboo) | 5,423 | [2026-10-27T22:04:34Z](https://github.com/openclaw/Peekaboo/commit/653645cbddb596c8077940fce2506a32cb48f580) | 近月 | MIT |
| [xlang-ai/OpenCUA](https://github.com/xlang-ai/OpenCUA) | 872 | [2026-05-25T01:46:42Z](https://github.com/xlang-ai/OpenCUA/commit/dfc91ba89f700d10f26ec50362d308571482ab8b) | 近半年 | MIT |
| [openai/openai-cua-sample-app](https://github.com/openai/openai-cua-sample-app) | 1.9k；精确值未核实 | [2026-10-19T06:01:47Z](https://github.com/openai/openai-cua-sample-app/commit/6dd34b40acc1d002696ccd41aaf0a1f2f2be290c) | 近月 | MIT（LICENSE 正文） |
| [google-gemini/computer-use-preview](https://github.com/google-gemini/computer-use-preview) | 3.3k；精确值未核实 | [2026-07-28T14:08:35Z](https://github.com/google-gemini/computer-use-preview/commit/77c9797e943aad63bbc963b7fd092a9e51c07863) | 近半年 | Apache-2.0（LICENSE 正文） |
| [likaixin2000/ScreenSpot-Pro-GUI-Grounding](https://github.com/likaixin2000/ScreenSpot-Pro-GUI-Grounding) | 398 | [2026-06-17T14:27:31Z](https://github.com/likaixin2000/ScreenSpot-Pro-GUI-Grounding/commit/dbe00114bc53a32c61c1a267786da85967710da8) | 近半年 | MIT（LICENSE 正文） |

### 3.2 能力比较

平台顺序固定 **Win / Mac / Linux-X11 / Wayland**：`✓`=来源明确列入，`限`=指定组件/条件下，`?`=未核实，`—`=该定位不提供。`浏览器`表示控制页面，不代表控制宿主 OS。所有行的 star/license/活跃度按上表同名关联，避免两处数字漂移。

| 项目 / 定位 | 四平台 | 感知 / 动作空间 / grounding | 失败恢复与自检 | Electron/原生桌面、硬伤 |
|---|---|---|---|---|
| [Cua](https://github.com/trycua/cua)：Driver + SDK + VM/Spaces | ✓/✓/✓/限 | AX/UIA/AT-SPI+截图；元素或像素键鼠、窗口、浏览器；视觉解析可选，非强制自带 planner | effect 回执、过期 token 拒绝、能力拒绝、原生状态回读 | 明确 Electron 覆盖；Wayland 按 compositor；Spaces、Bench 和可选模型不能套根 MIT |
| [browser-use](https://github.com/browser-use/browser-use)：浏览器 Agent | 浏览器/浏览器/浏览器/? | DOM+截图混合；导航/点击/填写/上传/标签；模型及元素定位 | 循环观察、历史、步骤限制；网站成功率仍需业务验证 | 不负责 OS 桌面；不能把 Python 跨平台当原生窗口能力 |
| [UI-TARS Desktop / Agent TARS](https://github.com/bytedance/UI-TARS-desktop) | ✓/✓/?/? | Desktop 像素键鼠；Agent TARS 有 DOM/GUI/hybrid 浏览器；模型 grounding | 观察-执行循环与暂停；未核实通用事务恢复 | Electron 客户端不等于 Electron 被控能力保证；本机、远程、浏览器路线须拆开 |
| [UI-TARS 模型](https://github.com/bytedance/UI-TARS) | 执行器自备 | 像素→动作/坐标；G 是 | 模型可反思；运行时恢复由外层负责 | 模型仓不是驱动；权重许可逐模型核实 |
| [Agent S / S2→S4](https://github.com/simular-ai/Agent-S) | ✓/✓/✓/? | S2 混合 grounding，后续截图+grounder/工具接口；键鼠和代码 | 分层规划、经验/反思；S4 演化接口；评测自报不作验收 | 可操作原生 GUI；grounder、执行器与版本组合决定能力 |
| [OmniParser](https://github.com/microsoft/OmniParser) | 模型执行环境自备 | 截图→文字/图标/框；G=候选区域，不是完整任务 Agent | 不负责动作确认或失败恢复 | 能处理 Electron 像素，无 UIA；根 CC-BY-4.0，旧 detector AGPL，v3 与 caption 另有许可 |
| [UFO/UFO²/Galaxy](https://github.com/microsoft/UFO) | ✓/—/限/? | UFO² UIA/Win32/COM+视觉；控件调用、键鼠、API；混合 G | 多 Agent 规划与执行状态；文档声明混合检测 | Windows 最强对照；Galaxy Linux 设备不等于 UFO² UIA 跨平台；混合检测深链本次 404 |
| [OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) | ✓/✓/✓/? | DOM/UIA/AX/AT-SPI+像素；录制→程序、动作和效果验证 | VERIFIED / COMPLETED_UNVERIFIED 分离，独立回读 | 本地+RDP；README 的小样本验证是作者证据，不能泛化到所有软件 |
| [self-operating-computer](https://github.com/OthersideAI/self-operating-computer) | ✓/✓/✓/? | screenshot + VLM，部分 OCR/SoM；键鼠；G 是 | 步骤式循环；通用副作用验证未核实 | 通用桌面概念验证；不是可直接嵌入的权限底座 |
| [Bytebot](https://github.com/bytebot-ai/bytebot) | —/—/✓/— | Linux 容器桌面像素、截图/键鼠/文件；模型 G | Agent 循环与可见桌面；事务级恢复未核实 | Ubuntu 虚拟桌面可跑原生软件；不是驱动用户 Windows/Mac 的方案，默认分支较旧 |
| [Skyvern](https://github.com/Skyvern-AI/skyvern) | 浏览器/浏览器/浏览器/? | 视觉+网页结构；表单、下载、上传、工作流 | 工作流重试/运行记录；非幂等写需外部核对 | 无通用原生桌面；根 AGPL，部署/分发边界需评审 |
| [Stagehand](https://github.com/browserbase/stagehand) | 浏览器/浏览器/浏览器/? | 页面语义+视觉 Agent；act/observe/extract 与代码结合；可选 G | 可观察动作/可复用 locator；复杂分支需测试 | 浏览器工具不是 OS 控制；自有 API 可比全像素可靠 |
| [Midscene.js](https://github.com/web-infra-dev/midscene) | ✓/✓/✓/? | 视觉；aiAct/aiAssert/提取，Web+移动+桌面/RDP；G 是 | 显式断言、报告、计划缓存 | 当前官方明确 Electron/Qt 桌面；Linux 文档 Xvfb/ImageMagick，不能推导 Wayland 已支持 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | 浏览器/浏览器/浏览器/? | accessibility snapshot/ref；click/fill/key/drag/upload/wait；语义无需视觉 G | locator/actionability、快照、断言工具；宿主定任务终止 | 无任意 OS 窗口；可用文本模型；canvas/ref 不完整时要另有受控路径 |
| [Puppeteer MCP（归档原版）](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/puppeteer) | 浏览器/浏览器/浏览器/? | DOM selector +截图；navigate/click/fill/evaluate；无自带 G | 自动化工具结果，外层负责自检 | 不推荐作为仍活跃默认选型；表中 star 是归档整仓，非单组件 |
| [Peekaboo](https://github.com/openclaw/Peekaboo) | —/✓/—/— | AX+截图、opaque element ID；点击、输入、窗口、菜单；可接视觉 | snapshot 绑定、明确前台许可、失败回执 | macOS 15+；可做 Mac 适配器参考，不能充跨平台方案 |
| [Fara](https://github.com/microsoft/fara) | 浏览器/浏览器/浏览器/? | 截图浏览器模型/Agent；G 是 | Agent loop；声明的基准非通用验收 | 面向网页任务，不是 Windows UIA 替代品 |
| [OpenCUA](https://github.com/xlang-ai/OpenCUA) | 数据涵盖 Win/Mac/Linux；驱动另看 | 轨迹数据与模型，像素→动作；G 是 | 训练/评测项目；线上恢复由集成者负责 | 不能和同名旧项目混淆；数据跨 OS 不等于主机适配可直接复用 |

Anthropic quickstarts、OpenAI sample-app、Gemini preview 是商业协议的参考执行应用，动作与风险见 §2；它们的仓库 star 是整仓热度，不能当底层驱动验收。Anthropic 示例主要隔离 Linux 桌面；OpenAI 示例提供多计算环境；Gemini 示例主要浏览器。代码开源不意味着模型开源。

### 3.3 2026 新项目与新方向：不是只列旧项目

| 项目 | API created_at / star 实测 | 值得看什么 | 不能推出什么 |
|---|---|---|---|
| [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast) | 2026-09-16 / **24,102** | 每次快照产生兼容操作和元素索引；无截图默认循环；执行前检查遮挡、文档与表单状态；DONE 仍独立验真 | 不是通用桌面；README 列明 frames/shadow/canvas/uploads 等 MVP 缺口；依赖 TypeSafe 服务，MIT 不代表模型可离线 |
| [Cloudflare Computer](https://github.com/cloudflare/computer) | 2026-06-05 / **9,780** | 持久 VFS+可插拔执行后端；可参考隔离和权威状态 | **不是 GUI computer-use 驱动**，不能因名字或增长榜收为截图输入候选 |
| [EvoCUA](https://github.com/meituan/EvoCUA) | 2026-01-07 / **355** | 训练/自演进桌面模型，独立 grounding/决策路线 | stars 不高；不能据模型论文承诺部署成熟度或安全性 |
| [WildAWM](https://github.com/MSR-Orchard/WildAWM) | 2026-09-30 / **85** | 环境与长程任务合成，补评测思路 | 不是执行驱动；license API 无检测值，未核实可复用条款 |
| Agent S4（既有仓 2026-10 新版本） | 仓 star **12,860**，不能算 S4 单独热度 | 演化工具接口，提醒“固定像素原语”不是唯一范式 | 不把 S4 的 V2 分数与 S3 的旧 OSWorld 分数横比 |

这些数字证明新出现且已有关注，**没有连续 star 时间序列，增长速度未核实**。本次不借第三方趋势站的“日增”冒充 GitHub 实测。

## 4. 驱动层与平台限制

### 4.1 底座统一维度表

开源库的 star/license/提交见 §3.1；OS API、Electron 内置 API、CDP 协议不是独立 GUI Agent，star/提交不适用。底座通常**没有语言 grounding，也不验证业务效果**，除非表中注明。

| 底座 | Win / Mac / X11 / Wayland | 枚举、截图、感知与动作 | 恢复/自检、Electron 与限制 |
|---|---|---|---|
| [PyAutoGUI](https://pyautogui.readthedocs.io/en/latest/) | ✓/✓/✓/未支持原生路径 | 像素截图/模板匹配、全局键鼠；窗口操作目前 Windows-only | fail-safe 不等于授权；官方限定主显示器；无 UIA，无任务验证；可点 Electron 像素，不保证后台 |
| [nut.js](https://github.com/nut-tree/nut.js) | ✓/✓/✓/不支持 | Node 原生输入、截图、窗口；可选图像/OCR 插件 | 明确列 Electron；截图/辅助功能权限；旧仓最近提交 2024，license API 无值且根 LICENSE 路径未找到；**不可未经核实按旧印象写 MIT** |
| [pywinauto](https://pywinauto.readthedocs.io/en/latest/getting_started.html) | ✓/—/—/— | Win32/UIA 树、查控件、invoke/value 与原生鼠键 | wait 可等控件状态；Chrome/Electron 树取决可访问性启用；自绘控件仍需像素；非所有操作都后台 |
| [FlaUI](https://github.com/FlaUI/FlaUI) | ✓/—/—/— | .NET UIA2/UIA3、元素 pattern、键鼠 | 重试/条件等待可做基础；UIA2/3 各有应用兼容边界；额外 .NET 执行进程/依赖需打包；业务效果另验 |
| [Win32 SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) | ✓/—/—/— | 无感知/grounding；向系统输入流注入 | UIPI 只允许相同或更低完整性，失败原因未必可识别；返回事件数不是目标应用生效证明；不保证只发给指定 HWND |
| [AXUIElement](https://developer.apple.com/documentation/applicationservices/axuielement) + [CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent) | —/✓/—/— | AX 树/动作与事件输入分层；截图另用 ScreenCaptureKit/系统能力 | TCC 授权与进程身份；树为空、失效元素、事件投递分开报错；Electron 可需 AXManualAccessibility；无通用任务自检 |
| [xdotool](https://github.com/jordansissel/xdotool) | —/非原生 AppKit/✓/仅 XWayland 窗口 | XTest/Xlib，找窗口/激活/键鼠；不自带截图或语义树 | X11 synthetic events 可能被工具包拒绝；安装在 macOS 不代表控制原生 AppKit；无法覆盖原生 Wayland |
| [ydotool](https://github.com/ReimuNotMoe/ydotool) | —/—/✓/限 | uinput 虚拟输入设备；key/type/mouse/click，无窗口、截图、语义 | 必须 ydotoold、可访问 /dev/uinput，通常需 root/设备权限；键盘布局配置，焦点错位；不是目标窗口级隔离 |
| [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html) + [ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html) | —/—/后端相关/限 | 授权会话、选源、PipeWire 帧、Notify 输入或 EIS/libei | compositor/backend 版本决定能力；会话撤销/断开须停止；不是任意窗口枚举，不是后台目标窗口注入 |
| [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer) | ✓/✓/✓/限 | 可捕获源清单、thumbnail；不含 UIA/输入/grounding | [Source 结构](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source)没有通用 PID、bounds、dpi；PipeWire 只回一个选中源；缩略图实际尺寸不保证等于请求值 |
| [webContents.capturePage](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts) | 自己持有的 webContents，跨平台 | 捕获页面区域；不是外部 OS 窗口截图 | 可复用内置浏览器捕获；不能因第三方软件也是 Electron 就取得它的 webContents；隐藏/休眠参数需专测 |
| [CDP DOM.setFileInputFiles](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-setFileInputFiles) | 浏览器/浏览器/浏览器/与显示后端无直接关系 | 把 files 路径赋给已定位 file input；无像素 grounding | 在目标浏览器所在文件系统解析路径；跨机器需先传文件；不操作原生文件对话框，不等于服务端上传完成 |

### 4.2 为什么 desktopCapturer 不能独自承担 list

官方 `DesktopCapturerSource` 的通用字段是 source id、名称、thumbnail、display_id、appIcon；没有方案所需的通用 PID、应用身份、窗口 bounds 与 dpiScale。即使 source id 在某平台含原生窗口标识，也不能把它的字符串拆分当跨平台合同。`screen` 的显示器信息不能补出所有窗口几何。

**建议**：保留 Electron 为截图适配器候选，`surface registry` 由平台适配器提供应用/窗口身份，并将捕获源和窗口绑定；绑定不确定时返回有限能力。`list` 是自动元数据读取，不应偷偷触发 portal 选屏或截图权限弹窗。源发现、用户授权选择、帧捕获在同一域内分清状态。[Source 结构](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source)、[PipeWire caveat](https://www.electronjs.org/docs/latest/api/desktop-capturer#linux)

Windows 的 `focus` 必须检查真实前台状态；系统可以拒绝 SetForegroundWindow，不能用 API 调用未抛错冒充已聚焦。[官方限制](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)

### 4.3 Wayland：有可用路线，但无单一通用后台驱动

1. **优先考虑 portal 的授权桌面会话**：ScreenCast 取流，RemoteDesktop 选设备并 Start；支持时 ConnectToEIS 后经 libei 发输入。EIS 建立后不能混用 Notify 系列。需能力探测、会话生命周期和坐标映射，不只是调用一个 CLI。[RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
2. **不要写“portal 每张截图确认”**：确认在建立/恢复选源会话时发生，可持续从授权流抓帧；支持的后端可使用 persist_mode/restore_token，token 轮换且可能失效。OS grant 不等于我们的任务授权。[ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
3. **ydotool/uinput 是可行的另一条输入路线**，代价为 daemon、设备权限、键盘布局与全局 seat/focus 风险。它没有解决窗口枚举、捕获或后台定向输入。不能为了支持 Wayland 默默提权。[ydotool README](https://github.com/ReimuNotMoe/ydotool)
4. **语义路线可独立存在**：AT-SPI action 能力不因 Wayland 就必定为零；反过来有 AT-SPI 树也不保证像素输入安全。Cua 文档区分 Sway、niri、GNOME、KDE、Hyprland；GNOME 有 helper/portal/libei 条件，KDE 部分实验，Hyprland 窄范围隔离插件不能泛化到 Electron。[平台证据](https://cua.ai/docs/cua-driver/concepts/platform-support)

将“Wayland ❌”替换为**运行时后端能力矩阵**：`semanticRead / semanticAct / capture / foregroundInput / backgroundInput / activate`，每格包含 backend、grant 状态、限制、可操作的修复提示。XWayland 回退只适用于真实 X11 窗口；不把“登录 Wayland 但测试 XWayland 应用”写成原生 Wayland 通过。

### 4.4 坐标合同：不能只乘一个 dpiScale

来源已经有至少三种空间：Claude 完整截图像素、Gemini 0–1000 归一化、Playwright CSS 像素。另有物理屏幕像素、OS 逻辑坐标、窗口 client area、裁剪图、缩图和多屏负原点。**这是集成推论**：每次 `look` 应返回 `captureId`、`surfaceGeneration`、时间、实际图像宽高、裁剪原点、源/目标坐标空间及变换；适配器把厂商坐标转换为宿主内部空间。

示例（无旋转/非均匀缩放已用 sx/sy 表示）：截图点 `(x,y)` 对应物理点 `originPx + cropOffsetPx + (x*sx,y*sy)`。dpiScale 只是变换的一部分；窗口跨屏、移动或布局变化后旧 capture 的变换不能继续复用。Claude zoom 仍按完整截图空间，不能再加一次裁剪偏移。[Claude 坐标](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)、[Gemini 归一化](https://aistudio.google.com/docs/computer-use)、[Playwright screenshot scale](https://github.com/microsoft/playwright-mcp)

### 4.5 “禁止另建截图/输入”应约束层次，不应冻结实现

有需要原生/自建后端的明确先例：Cua 使用 Win32/UIA、ScreenCaptureKit/AX、X11/AT-SPI、合成器专用路径乃至嵌套 compositor；厂商参考容器也拥有 guest 执行服务。Electron API 没有包办这些能力。

**建议措辞**：“所有 Agent、视觉解析器、MCP 与扩展只消费 host.desktop 权限、捕获和输入入口；本域内部允许复用库及必要的平台原生后端。禁止模型侧另起可绕过权限/审计的捕获或注入通道。”这保留单一权威入口，又允许解决真正的平台缺口。是否引入 Cua Driver，应先做 license、进程身份、包体和能力一致性验证，不在本调研里直接决定安装。[Cua 架构](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works)

## 5. 范式与基准：分别测定位、执行与业务效果

### 5.1 语义优先到了什么程度

**网页已是成熟工程路线；原生桌面是可用但覆盖不均的混合路线。** Playwright MCP 明确无需视觉模型即可用 accessibility snapshot 操作网页；UFO² 把 Windows UIA/COM 放在核心；Cua 与 OpenAdapt 扩展到 AX/AT-SPI。不能从视觉模型在榜单领先推出“语义树已过时”，也不能从几个标准控件成功推出“纯文本模型能控制所有桌面”。[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[UFO](https://github.com/microsoft/UFO)、[OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt)

| 纯文本模型可依赖 | 不能从树中可靠推出 | 我们应返回什么 |
|---|---|---|
| 有角色/名称/值/状态的按钮、菜单、表单；按 ref 调用 pattern；读取结果文本 | 图标含义、颜色/布局比较、canvas/3D 视口、远程视频、自绘无标签控件 | `semanticStatus`（available/partial/unavailable）、裁剪/分页信息、可执行 action 集、截图 artifact |
| 有 UIA/AX/AT-SPI 控件的原生程序和启用 a11y 的 Electron | 虚拟列表未实现的离屏节点、遮挡控件是否能原生点击、disabled 控件的业务原因 | ref 绑定 surface/capture/generation；不能把“树存在”当“元素可操作” |
| 文字快照选择目标、通过视觉工具获得结构化定位后继续规划 | 只收到文件路径就自行理解图片 | 视觉辅助输出带原 captureId、图像尺寸、bounds、置信度/歧义；纯文本模型不会因此突然具备视觉 |

Electron 官方提供可访问性自动启用和手动启用机制，第三方工具在 macOS 可使用 AXManualAccessibility；因此 Electron 应用既非“天然没树”，也非“天然完整有树”。飞书、MWEditor 等具体应用仍需逐控件真机检查。[Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility)

“网页只给截图不给 ref”会与语义优先冲突。建议改为：可绑定现有浏览器 tab 时，返回明确 `browserTarget` 并引导 browser 域；桌面像素写入默认拒绝并附 route hint。无法接管的外部浏览器、原生对话框、canvas 只能在授权范围内走明确视觉 fallback。不要剥夺可用语义，再希望模型自己避免像素。

### 5.2 SoM 与专用 grounding 模型

| 路线/项目 | 感知与输出 / 动作 | 平台、Electron、恢复边界 | 当前地位及我们取舍 |
|---|---|---|---|
| [Set-of-Mark](https://arxiv.org/abs/2310.11441) | 分割/检测区域叠编号，模型选标记；不是 OS 元素引用 | 任意截图；不提供输入、不验证保存 | 可降低坐标表达负担，但漏检/错框/过期标号仍在；编号必须与 capture 绑定，不能持久化成永久 ref |
| [OS-Atlas](https://github.com/OS-Copilot/OS-Atlas) | 跨平台 GUI grounding/动作模型；像素→位置/动作 | 数据涵盖多个 OS；执行器自备，无事务恢复 | 研究基线；仓代码 Apache-2.0 不代表所有权重/数据同许可；不作为内置必选依赖 |
| [UGround](https://github.com/OSU-NLP-Group/UGround) | 指令+截图→位置，专用视觉 grounding | 桌面/网页/移动截图；无原生窗口驱动/业务验证 | 把 planner 与 grounder 分离的明确例子；系列从 2B 到 72B，不宜统称“小模型” |
| [ShowUI](https://github.com/showlab/ShowUI) | 轻量 VLA，视觉 token 与动作序列 | 配执行器才可操作 Electron/桌面；本仓展示训练/推理 | 可候选本地或远程感知；延迟、图像尺寸与本地硬件待测；不能据 2B 宣称无成本 |
| [Agent S2 混合 grounding](https://arxiv.org/abs/2504.00906) | generalist + specialist 分工、Mixture-of-Grounding | 多基准研究；长程计划与定位分别优化 | 说明“双路+辅助视觉”有依据，但不能把 S2 论文消融结论无条件外推到最新 S4 |

这些路线仍有价值，但产品契约应是可替换的 perception provider，而不是将某权重的坐标格式、token 名或许可写死到 `host.desktop`。优先现成结构，再在同一截图上调用 grounder；每次执行前重验目标和图像新鲜度。

### 5.3 基准比较（star/license/活跃度见 §3.1）

| 基准 | 被测范围与感知/动作 | 自检/评分 | 能证明与不能证明 |
|---|---|---|---|
| [OSWorld](https://github.com/xlang-ai/OSWorld) / [Verified](https://os-world.github.io/) | 桌面 VM 多应用；截图/语义等观察配置，键鼠/代码执行 | 环境状态 evaluator，复现任务后判结果 | 可测端到端桌面；不直接证明用户真机、Wayland、混合 DPI、授权正确。版本、步数、模型和 evaluator 必须相同再比 |
| [OSWorld 2.0](https://osworld-v2.xlang.ai/) | 长程真实工作，任务复杂度与旧版不同 | 更长流程的结果评估 | 旧版高分不能推导长程可靠；partial credit 与 binary 不能混。Agent S4 README 自报 21.3% binary，本次未复跑也不排名 |
| [WindowsAgentArena](https://github.com/microsoft/WindowsAgentArena) | Windows 11 VM；Navi 可配 win32/UIA、视觉 SoM/mixed | 任务 evaluator；normal/hard 初态不同 | 最贴近 Windows；不覆盖 Mac/Linux；VM 权限、语言、软件版本与真实用户环境不同 |
| [ScreenSpot-Pro](https://github.com/likaixin2000/ScreenSpot-Pro-GUI-Grounding) | 高分辨率专业软件截图，包含 Win/Mac/Linux UI | 单目标 grounding 命中率 | 测定位，不测点击后是否生效、长链路、恢复/授权；有 Unreal/设计软件场景，对我们的自绘界面有参考价值 |
| [WebArena](https://github.com/web-arena-x/webarena) | 可复现自建网站，812 个例子；支持 accessibility_tree 等观察 | 环境重置、任务结果检查 | 能隔离浏览器链路；不能证明原生 desktop；官方推荐新实验看 AgentLab/BrowserGym |
| [WebVoyager](https://github.com/MinorJerry/WebVoyager) | 真实网页多步浏览，截图/元素与键鼠 | 轨迹/结果评估；实时网站有漂移 | 可看真实页面困难；网络、站点更新使跨时间数字不可直接比；不能证明安全或副作用恰好一次 |

本报告刻意不制作“最新分数排行榜”：未逐项复跑、核对所有榜单配置，不能用不同预算与任务集的自报分数决定底座。比起复刻论文评测，实施验收先覆盖下列**合同测试矩阵**：

- 窗口：同名多实例、关闭重开 PID/句柄复用、隐藏/最小化/遮挡、用户主动切焦点。
- 坐标：100/125/150/200% 缩放、多屏不同 DPI、负原点、跨屏移动、裁剪/缩图、滚动后 stale ref。
- 输入：中文/IME、快捷键按下释放、鼠标拖曳取消、输入过程中目标退出；失败后无残留按键。
- 权限：TCC 拒绝/撤回、Windows 高完整性、portal 取消/会话断开、X11 与原生 Wayland 分开；任何失败不静默转全屏/前台/提权。
- 结果：写入后重新读取目标应用/文件/服务记录；网络超时后先确认是否已发生，不重放发送/付款/删除。
- 并发：多个 Worker 共用真实键鼠时必须串行占用；后台语义调用也应按目标有序，不能假定“各有 session 就各有键盘”。

这些是拟定验收，不是本次已跑测试。

## 6. 授权、截图路径与恢复合同

### 6.1 任务级授权是主体，不是无限授权

建议保留已确认的“一次授权一条任务链”，增加可执行的 grant 结构：taskId、应用身份、surface scope、允许的动作/数据范围、有效期、前台接管权限和撤销状态。进程重启、窗口复用、新域名/应用、原始输入无法保证目标等情况必须重新判断范围；用户已明确授权的同一具体操作不重复问。

**中间形态**：任务内低风险连续执行；只有超范围、未授权的不可逆副作用或 provider 强制确认时暂停。高风险业务授权应绑定具体对象和内容，例如收件人/金额/文件集合，而不是“这个窗口里的所有 click”。单靠 `surfaceId + app` 无法区分同一应用里的草稿和发送。截图文字不能扩充 grant。

来源对应：Claude 桌面按新应用授权；Anthropic API 建议重要后果确认；OpenAI 要求限定环境并验证结果；Gemini 将 allow/confirm/block 暴露给客户端；Cua 的 bounded manifest 在所有 transport 下统一检查。**推荐组合是本报告的设计判断，不宣称行业只有一种权限标准。**[Claude 桌面](https://claude.com/resources/articles/dispatch-and-computer-use)、[Anthropic API](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)、[OpenAI API](https://developers.openai.com/api/docs/guides/tools-computer-use)、[Gemini](https://aistudio.google.com/docs/computer-use)、[Cua permissions](https://cua.ai/docs/cua-driver/guides/permissions)

权限必须位于执行底座。仅在模型 prompt 写“不要越权”不足；不能允许模型通过 shell/CDP/另一 MCP 绕开已有 grant。中断时释放按键/鼠标和输入租约；输入动作按桌面 seat 串行，用户接管优先。

### 6.2 截图返回本地路径可行，但路径不是图像传输

**答案：可行，且有文件输出先例；不能保证任意 MCP 视觉服务器能直接读。** Peekaboo 的 `see --path`、Playwright MCP 的 screenshot filename/output-dir 都落盘；Gemini CLI 的浏览器视觉辅助工具展示了“主 Agent 调独立视觉模型”路线。三者不等于远端模型理解 `C:\...` 字符串。[Peekaboo](https://github.com/openclaw/Peekaboo)、[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[Gemini CLI visual agent](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md)

| 接收方 | 可行做法 | 必须明示的边界 |
|---|---|---|
| 同机、同权限的视觉工具 | 接 path，由受信工具读文件并转模型接受的 image bytes | 路径 allowlist、文件存在、过期与删除、拒绝任意路径读取 |
| 不同用户/容器/远程 MCP | artifactId → 宿主按授权读取/传输；或可访问的受控资源 URL | Windows 本地路径在远端无意义；不能暴露任意 file URL 或未经授权上传截图 |
| 原生多模态 Harness | path 元数据 + 可选内联 image/resource 内容 | 继续满足用户“不仅内联”要求；宿主适配模型实际图像输入能力 |
| 纯文本模型，无视觉辅助 | 用语义树继续；pixelsOnly 时明确不能视觉判断 | 不能凭路径猜图，不应对用户声称全功能支持 |

MCP 工具结果可含 text、image、resource link 等；协议没有“任何 server 自动读取任意 client 本地路径”的保证。[MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

建议 `look` 返回 `{captureId, path, artifactId, mimeType, width, height, capturedAt, expiresAt, coordinateSpace, transform, semanticStatus}`；路径是本地消费入口，artifactId 是跨边界引用。视觉结果必须回带 captureId，宿主校验过期/窗口代次后才能 act。截图落盘也需清理和访问隔离；日志只留必要引用，不把密码图或输入全文永久写入审计。

### 6.3 执行、稳定与成功必须分开

建议 `act` 返回以下独立状态，而非一个 `ok`：

- `delivery`：未派发 / 已派发 / 部分派发 / 结果未知。
- `effect`：confirmed / suspected_noop / unverifiable / partial / refused；附机器可读 reason。
- `after`：新快照或可追索 captureId，以及观测是否超时；**after 存在不等于业务成功**。
- `verification`：具体 predicate、来源、结果；是否写入文件/提交服务器，要用对应权威记录验证。

`verify?` 可选只表示是否额外请求验证；没有验证时明确 unverified，不默认 verified。`waitForStable` 设超时/采样窗和结果原因；光标闪烁、视频、进度条可能永不像素稳定，画面不变也可能后台仍在保存。不可把一秒 sleep 当稳定成功。

**恢复策略（本报告建议）**：只读重观测可以有界重试；目标失效先重新 look；写动作派发后响应丢失，标 outcome_unknown，先核验外部状态；禁止自动重放可能已发送/付款/删除的动作。前台回退是能力/授权升级，不能当普通 retry。Cua effect 模式与 OpenAdapt 独立效果核验提供直接依据。[Cua 架构](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works)、[OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt)

## 7. 直接采用 / 需改造 / 明确避免

### 直接采用

| 项 | 实施方向 | 来源依据 |
|---|---|---|
| 五动词、模型循环与执行底座分离 | 维持顶层工具简洁；provider adapter 映射具体动作，不另开越权执行面 | [Anthropic client tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)、[Cua](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works) |
| 语义树+截图双路，path 必返 | 为文本与视觉 Harness 共用；允许只读增量模式降低开销，保留原始截图引用 | [Cua](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works)、[Peekaboo](https://github.com/openclaw/Peekaboo) |
| 元素引用来自观测 | ref 不接受模型自造；有状态/代次/时效检查 | [Playwright MCP](https://github.com/microsoft/playwright-mcp)、[Jev](https://github.com/browser-use/jev-ultrafast) |
| 浏览器文件赋值走语义接口 | browser.upload 经现有 locator/CDP 能力；赋值后另验上传完成 | [Playwright setInputFiles](https://playwright.dev/docs/input#upload-files)、[CDP schema](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json) |
| 能力不足明确拒绝 | 返回 code、backend、缺失权限和恢复步骤，不假成功 | [Cua platform support](https://cua.ai/docs/cua-driver/concepts/platform-support) |

### 需改造

| 项 | 改造内容 | 来源依据 |
|---|---|---|
| 坐标 | capture 绑定的多空间变换；模型适配器消化像素/归一化；DPI 不再唯一参数 | [Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)、[Gemini](https://aistudio.google.com/docs/computer-use) |
| 平台能力 | 拆元数据/树/截图/语义输入/前台/后台/激活，Wayland 按后端与 grant | [Electron](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html) |
| 任务授权 | 绑定目标与副作用；同范围不重复确认，扩范围和强制安全闸门单独处理 | [Cua permissions](https://cua.ai/docs/cua-driver/guides/permissions)、[OpenAI](https://developers.openai.com/api/docs/guides/tools-computer-use) |
| 截图路径 | 增 artifact/资源读取合同、有效期、图像输入能力协商 | [MCP](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、[Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md) |
| 动作空间与回执 | click 的 button/count/modifier、move/hover、拖曳路径/取消；动作能力清单，effect 与 verification 分开 | [Anthropic actions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)、[Cua](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works) |
| 复用约束 | 统一权限入口下允许平台原生后端；不把“禁重复实现”解释成“禁补缺” | [Cua platform mechanisms](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works) |

### 明确避免

| 禁区 | 为什么 | 来源依据 |
|---|---|---|
| 将 desktopCapturer 当完整 OS window registry | 缺 PID/bounds/dpi 等字段，PipeWire 选源行为不同 | [Source schema](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source) |
| “网页去掉 ref”强迫模型走截图 | 与已验证的语义网页路线相反；应返回域路由 | [Playwright MCP](https://github.com/microsoft/playwright-mcp) |
| 输入返回正常就报告已保存 | 原生输入可无效，应用可能异步失败 | [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) |
| 静默后台→前台、自动提权 | 焦点和用户操作冲突，扩大任务权限 | [Cua](https://cua.ai/docs/cua-driver/concepts/platform-support)、[Windows foreground](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow) |
| 凭 root license 打包所有模型/扩展 | Cua 子组件、OmniParser 不同模型分版本许可 | [Cua licensing](https://github.com/trycua/cua#licensing)、[OmniParser weights](https://github.com/microsoft/OmniParser#model-weights-license) |
| 用 star 或旧基准高分当跨平台可靠性 | 热度、单点定位、任务成功是不同指标 | [ScreenSpot-Pro](https://gui-agent.github.io/grounding-leaderboard/)、[OSWorld V2](https://osworld-v2.xlang.ai/) |

## 8. 对现有方案的逐节修改建议（只建议，未改 plans）

| 原章节 | 具体替换/补充 | 验收要点 |
|---|---|---|
| §0.9 / §6 任务级授权 | 保留已定任务链授权；补 grant 范围、过期/撤销、目标代次与尚未授权副作用的确认规则 | 范围内连续执行不弹窗；越界必须暂停 |
| §0.10 / §4 look | 必返 path；补 artifactId、captureId、图像几何、语义覆盖、远端视觉读取方式 | 文本模型同机/容器/远端 MCP 分别验证；pixelsOnly 不假装能看 |
| §4 list | 不承诺 Electron 独自提供 app/bounds/dpi；明确 registry 与平台 adapter | 同名窗口不误认；只读 list 不启动选屏弹窗 |
| §4 act | 保留五顶层动词；细化 action 参数与 supports 清单，补 hover/move、modifier、button/count、拖曳释放 | 厂商原生动作映射全覆盖；不支持动作明确拒绝 |
| §4 act target | ref/坐标带 capture/generation；以新鲜目标验权，不能只凭标题 | 旧快照、窗口重建、移动跨屏被识别 |
| §4 坐标契约 | 将“AI 只给逻辑坐标，按 dpiScale 换算”换成版本化 coordinateSpace + transform | 缩图、裁剪、多屏、归一化、zoom 不重复缩放 |
| §4 语义优先 | 将“遇网页不给 ref”换成 browserTarget/route hint；明确拒绝未批准的 pixel fallback | 内置浏览器优先 browser；不可接管表面有显式降级 |
| §4 waitForStable / verify | 稳定与业务效果分离；超时如实回执；派发未知状态不重放 | 视频/动画可超时；保存失败不报告完成 |
| §4 硬约束 | 统一域入口和审计，不禁止本域新增必要原生后端 | 所有传输方式共用权限检查 |
| §5 browser.upload | 首选现有定位+setInputFiles/CDP；file 路径属于执行端；外部上传另验 | 远端文件传输/权限、空 files、多文件、服务器拒绝 |
| §6 输入/审计 | 补输入租约、用户接管、前台策略；审计敏感输入脱敏，截图引用有生命周期 | 多 Worker 不抢键盘；取消释放键；无密码明文持久化 |
| §7 平台矩阵 | Wayland 按 compositor/portal/libei/uinput 能力细分；macOS 元数据权限与屏幕录制/AX 分开 | Windows/Mac/X11/原生 Wayland 分列真机结果 |
| §9 验收 | 纳入 §5.3 合同矩阵与 effect/业务结果两级证据 | 模拟测试与各平台真机不混报 |

其中“细化任务授权、动作空间和后台回退”涉及产品规则，调度应把具体修改交用户审阅；其余为补足现有目标的工程合同。此报告没有自行改动已确认决策。

## 9. 未核实项、异常与可复核范围

1. **真机/模型实测**：所有候选 Agent 的安装、任务成功率、延迟/成本、Windows/macOS/X11/原生 Wayland 能力，本次未实测。飞书/MWEditor 的 UIA/AX 覆盖、中文 IME、受保护/管理员窗口、混合 DPI 与远程 MCP 图像转交均待实施验证。
2. **数字**：OpenAI sample-app 页面只显示 1.9k、Gemini preview 只显示 3.3k，精确 star 未核实；其默认分支提交已用官方 Atom 核实。新项目 star 增长速率没有连续样本，未核实；未称“增长最快”。
3. **许可**：nut.js 根许可证未核实（API null，尝试的 LICENSE 路径 404）；WildAWM API null，具体复用条款未核实。模型权重/训练数据、商业发行包与所有传递依赖未逐件审计；不能由根许可证作法律结论。
4. **声明边界**：平台 `?` 格均未核实；尤其 UI-TARS Desktop Linux、多数库的原生 Wayland、Fara 的本机桌面能力。Cua 平台覆盖和 OpenAdapt 小样本是作者证据，非我们验收；第三方所谓“全自动安全”不采信。
5. **商业产品**：Perplexity 官方索引可读，但安全文章正文抓取失败，内部 grounding/动作/授权协议未核实；ChatGPT 2025 发布页标 outdated，只作历史先例，不用于当前产品支持清单。
6. **来源异常已处理**：GitHub 匿名 API 403 后转官方 commits Atom，补齐 39 个已确认仓库的 commit 时间；误猜 URL 的 404 已用官方链接纠正，不据此报删库；UFO 混合检测深链 404，仅引用仍可读 README，细节未补造。CDP HTML viewer 只返回 JS 壳，改读官方 `json/browser_protocol.json` 核实 files/nodeId/backendNodeId/objectId 参数。
7. **未采用旧报告的排行榜结论**：本次只比较范式和测试边界，不复述“某榜 Top20 全不用 a11y”“通用能力已超人”等未经本次复核的结论。

可复核产物为本报告与 CSV；CSV 的 metadata_source/commit_source 可重取，SHA 可定位当时默认分支。官网文档为查询日的动态版本，今后实施前重新核对。外部下载仅用于阅读 README/LICENSE/元数据，没有执行其脚本。仅运行文档一致性检查与 Git diff 检查，不运行产品测试，不声称完成平台验收。

交付检查：39 条唯一仓库记录的 SHA/日期及来源检查通过（37 条精确 star，2 条网页取整）；报告内部本地链接和两处新增索引链接通过，调研索引 46 条与声明一致，UTF-8/`git diff --check` 通过。扩展检查总索引时发现既有 `docs/prd.md` 断链，已与基线确认，不在本次范围修改。`docs/plans/`、`src/`、`test/` 相对任务基线无改动。
