# 中国象棋 · 楚河汉界

「中国象棋」是全局安装、按工作区启用的离线面板扩展。可在工作台分屏中走棋，也可关掉面板，之后打开续局。源码在 `resources/extensions/xiangqi/`，不随应用默认安装。通过扩展创作审核发布全局包，或由扩展管理的「安装本地扩展」选择该目录；按宿主提示启用和信任。棋谱按工作区隔离，不跨工作区同步。

## 棋桌与操作

用户在工作间隙编辑一盘进行中的棋局，棋盘是主操作区：红黑席位、回合、将军与合法落点就近显示。宽面板中棋谱和设置靠右，窄面板中排在棋盘及操作条下方。SVG 网格保持 9 路 × 10 行交叉点、河界、九宫和传统定位纹；CSS 和随包矢量纹理绘制胡桃木外框、浅木台面和雕刻棋子，跟随宿主深浅色，不加载外部素材，也不发声。

- 人机局由用户执红、电脑执黑，有初弈和进阶两档；双人同屏在同一面板轮流执红、黑。
- 新局可从空盘直接开始；替换有着法的对局或损坏存档前用宿主确认。悔棋在人机局退回一个人机回合，双人局退回一着。提示只计算一着，不代走、不改变棋谱。
- 键盘 Tab 进入棋盘，方向键移动焦点，回车/空格选棋与落子，Escape 清除选择。翻转后键盘方向仍与画面一致。
- 加载时禁止下棋；空盘可直接开始；保存失败显示可操作的读回提示，不把未确认写入当作成功；损坏存档不自动覆盖。棋谱只显示最近 14 着，长局保存完整着法和设置，不拉长列表。

## 入口与数据流

| 文件 | 职责 |
| --- | --- |
| `resources/extensions/xiangqi/extension.json` | 全局 sidebar、工作区数据许可及命令/查询契约；不挂 Agent，不申请联网、模型或宿主工具能力 |
| `resources/extensions/xiangqi/domain.mjs` | `ma.agent.domain.snapshot/query/command` 对应的 DomainRuntime。串行校验版本、走棋、读写棋谱、推送 `state.changed` |
| `resources/extensions/xiangqi/rules.mjs` | 走法及终局判定、简式记谱、以着法记录重建局面 |
| `resources/extensions/xiangqi/engine.mjs` | 独立 DomainRuntime 进程内限时、限节点的迭代加深搜索；人机应手与提示不调用模型 |
| `resources/extensions/xiangqi/ui/panel.mjs` | 等待 `ma.ready`；以宿主快照绘制棋桌及棋谱，局部管理焦点和选中态 |

面板通过 `game.move`、`game.undo`、`game.new`、`game.settings` 提交命令。DomainRuntime 只在存储 broker 确认后更新快照及发送事件。人机局在一次提交中保存红方走棋和黑方应手，避免关面板、读回或失败重试停在半个回合。`game.hint` 只查询；面板丢弃落后于已知快照的结果。

标准基本着法、将军、将死和困毙遵循 [世界象棋联合会规则第一章](https://www.wxf-xiangqi.org/images/wxf-rules/2018_World_XiangQi_Rules_English2018.pdf)。休闲终局策略：同局面与同走棋方出现四次时，单方持续将军判负，其余判和；双方各 50 着未吃子判和。不包含比赛裁判、用时规则和完整的长捉/长打裁定。

## 验证入口

`v1.0.0` 已由桌面投稿入口上传到公开的 [中国象棋扩展仓库](https://github.com/zhanghexie/muster-extension-xiangqi/tree/v1.0.0)。固定提交为 `954f08d06c3e32e9454813f411789a54d3e6fb96`，安装包 SHA-256 为 `51f4be6fd69bf3b5abf1d9501027e3f8bc8a830e3138d2ced1e32aba69b79cf5`。服务从 GitHub 回读、初检，再通过桌面审核页在 macOS 隔离试装实例安装同一包，实际完成红方落子、电脑应手和棋谱保存。此版本留待批准进入公开扩展中心。验收的 GitHub 写入使用本机已授权 SSH，GitHub App 上线授权另验。

- `node --test test/xiangqi.mjs`：走法、将死与困毙、重复判定、离线引擎、存档恢复和写入失败。
- `npm run test:unit -- xiangqi-panel`：棋盘焦点、走棋提示、翻转、确认和错误恢复。
- `npm run test:e2e -- test/e2e/extensions-xiangqi-panel.spec.ts`：隔离 Electron 中安装、启用、受信任运行、键盘走棋、重载续弈、悔棋和窄栏布局。
- `test/e2e/extensions-publishing.spec.ts`：使用授权的服务与仓库，验证桌面投稿、候选初检、审核者试装和实际走棋。
