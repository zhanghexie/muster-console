# 本地演示场景与会话回放

每个场景都会保存可继续编辑的工作台状态和会话。整窗录制默认关闭。需要连同鼠标、滚动和切屏一起重播时，启动这次搭建时加上 `--record`。

要自己控制镜头并让一段真实对话重新出字，在可操作的工作台里选中会话，调用 `window.replaySession()`。该入口也可在普通工作台使用。[用真实会话回放聊天](session-replay.md)

## 搭建和拍摄

| 操作 | 源码启动命令 |
| --- | --- |
| 搭建或继续编辑「分镜」 | `npm run demo-build -- --scene 分镜` |
| 搭建「分镜」并录制本次整窗操作 | `npm run demo-build -- --scene 分镜 --record` |
| 从保存的场景打开可操作的工作台 | `npm run demo-run -- --scene 分镜` |
| 列出该场景的回放编号和开始时间 | `npm run demo-run -- --scene 分镜 --list` |
| 按原速回放最近一条 | `npm run demo-run -- --scene 分镜 --replay` |
| 回放指定记录，从第 8 秒开始，以 1.5 倍速播放 | `npm run demo-run -- --scene 分镜 --replay <记录编号> --from 8 --speed 1.5` |
| 删除「分镜」的演示配置、受管会话和回放 | `npm run demo-delete -- --scene 分镜` |
| 删除全部场景 | `npm run demo-delete` |

1. 启动 `demo-build`。在工作区入口选择已有项目文件夹，或者用「一键填入」创建项目。首次使用可在演示实例的设置中配置模型，再像平时一样发送消息、运行命令、派发 Worker、切换会话和布局。
2. 通过 `--record` 启动后，每个搭建窗口会生成一条整窗记录。用应用菜单或托盘的「退出」结束录制，下次搭建可重新选择是否录制。仅把窗口收进托盘会保持场景占用。同一数据目录每次只允许一个 demo 进程打开。
3. 用 `demo-run` 打开保存的场景即可亲手操作。已有整窗记录可用 `demo-run --replay` 打开，按搭建时的顺序重现鼠标移动和停顿。空格暂停或继续，Home 从指定起点重播。窗口按原画面比例缩放。下次启动 run 或 build 会恢复搭建时保存的工作台状态。

编译后的 Electron 应用接受 `--demo-build`、`--demo-run`、`--demo-delete`。省略 `--scene` 时打开 `default` 场景，删除命令省略场景名时清理全部。场景名支持 1–64 个文字、数字、下划线或短横线。`--demo-base <父目录>` 可指定本地存储位置，后续操作传入同一位置。

## 项目和数据归属

- 现有项目仍作为真实工作目录。搭建和交互运行时，你或 AI 对源码的编辑会保留。工作区的演示管理数据、配置、布局、受管会话和回放记录保存在场景内。「一键填入」推荐的项目位于同级 `.muster-demo-projects/<场景>`，删除演示时也会保留。
- 默认在 Electron 的系统 `appData` 下存储。演示数据和推荐项目目录自带 Git 忽略规则，在开发仓库中也已排除。删除只清理具有归属标记的 `.muster-demo` 内部数据，不遍历登记的项目，也不沿符号链接或 Windows junction 删除目标。外部工具自行保存的历史和项目内的实际改动仍归原工具或项目管理。
- 普通启动继续使用现有工作台或开发 sandbox。开启整窗录制时会遮挡常见密码输入框，普通聊天文本、可见文件内容和画面会按原样记录。
- 在 macOS 和 Linux 上，搭建和交互运行会先用用户的登录 Shell 查询 `PATH`，再切换到场景主目录。这样从桌面打开 Demo 后，后台命令也能找到 nvm 等工具，命令的主目录仍属于场景。探测失败时日志会提示改从能找到目标工具的终端启动。Windows 使用启动时继承的 `PATH`。离线回放、列出记录和删除场景均跳过探测。

## 实现与边界

| 入口 | 职责 |
| --- | --- |
| `scripts/demo.mjs`、`src/main/launch.ts`、`src/main/demo/options.ts` | 源码启动、普通工作台和 demo 分发、参数校验 |
| `src/main/demo/boot.ts`、`src/main/demo/storage.ts` | 隔离 Electron 配置和工具主目录。持有进程锁，管理场景、项目数据目录和离线播放器 |
| `src/main/demo/tapes.ts` | 用 UTC 时间和随机后缀命名记录，保存窗口尺寸和带时间戳的 JSONL 事件。完整初始快照写入后记录才出现在列表中 |
| `src/renderer/src/demo/record.ts`、`surfaces.ts` | 用 rrweb 记录 DOM 快照、增量变化、输入、滚动及鼠标。终端、画布、视频和本地扩展的可见区域以每秒至多约四次的真实画面补录 |
| `src/renderer/src/demo/play.ts`、`src/preload/demoReplay.ts` | 在独立窗口重建界面，处理缩放、暂停和重播。窗口只接收回放数据，禁用录制内容中的脚本和外部网络，播放器文案跟随系统语言 |

数据按 `.muster-demo/scenes/<场景>/` 分组。搭建写入 `work/`，回放记录在同级 `recordings/`。交互 run 暂存搭建基准，再把工作副本放回同一个绝对路径，以保留持久化的路径引用。进程中断后，下次启动可恢复基准。跨进程 SQLite 锁在进程退出后自动释放，独立的空锁文件不含场景数据。

仅当搭建时传入 `--record`，主进程才注册整窗录制接口并向窗口提供录制能力。窗口通过 `demo:recordStart` 开启记录，通过 `demo:recordBatch` 写入事件。`demo:surface` 只截取该窗口指定的可见区域。播放器用 `demo:read` 分批读取记录，`demo:appearance` 把当时的主题框色和文字色同步到原生标题栏。

窗口内的 Worker 创建、子代理回复、侧栏层级和工具卡跟随同一时间线回放，播放时无需启动 Worker、模型、Shell 或原工程。系统选目录对话框、应用外独立窗口、远程网页内部及音频不在回放范围内。需要按原生帧率录制扩展动画或视频时，可用交互 `demo-run` 打开搭好的现场实录。

验证入口为 `node test/demo-mode.mjs`、`npm run test:unit -- test/unit/demo-replay.spec.ts` 和 `npm run test:e2e -- test/e2e/demo-replay.spec.ts`。
