# 文本实体识别（URL / 路径 / path:line）

功能职责：终端胶囊识屏、划词浮条、会话 Markdown 路径链接化、「爆炸」分词四个消费方共用的**唯一**文本识别核心——把一行纯文本切成 URL / 文件 / 目录 / `path:line[:col]` 实体。历史上这五个正则在 3 个文件里重复维护且互相漂移（URL 吞并边界不一、LOC 正则两份），2026-09-02 统一收敛到 `terminalSelectionText.ts` 单源。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/shared/terminalSelectionText.ts` | **识别核心**：URL_RE（唯一导出）、路径/裸文件名/宽松 CJK 正则与手扫、detectUrlEntities / detectPathEntities / detectLocEntities、trimUrlNoise / trimPathNoise、localFileFromUrl、greedyPathTextAt + pathStatVariants、resolvePathCandidate、tokenizeForBang |
| `src/shared/terminalScan.ts` | 终端扫描实体组装（按 isWrapped 合并逻辑行、collectLineHits：url<loc<path 去重叠 + cwd 过滤）与 filterEntitiesByStat（stat 过滤/回填/纠正 kind） |
| `src/shared/linkifyWorkspacePaths.ts` | 会话 Markdown 路径→`muster-file:` 链接（代码块/URL/markdown 链接整段保护，幂等；`filter.exists` 供调用方 stat 把关；包装定位用候选自带下标，勿 indexOf） |
| `src/renderer/src/chatSurface/ChatMarkdownBody.tsx` | assistant 正文渲染层链接化：先渲染原文，候选批量 statPaths（微批合并 + 模块级缓存）后只链真实存在的路径；流式跳过，cwd 与点击路由同源 |
| `src/renderer/src/components/TerminalView.tsx`、`CliSessionView.tsx`、`TerminalScanCapsule.tsx` | 工作台胶囊 / 普通终端胶囊调用会话内识屏（视口行→scanLinesForEntities→statPaths→浮层）；stat 清单含 localhost 映射与空格贪心变体 |
| `src/renderer/src/terminal/scanBuffer.ts` | xterm 视口读取（补齐上下沿软折行上下文）、逻辑行实体投影为多个可见矩形、UTF-16→终端列映射 |
| `src/renderer/src/components/TerminalScanOverlay.tsx` | 扫描浮层渲染；url 命中带 absPath（localhost 映射成立）时菜单追加「在文件区预览/资源管理器」；截图 canvas 遮罩取当前 ResolvedAppearance.scrim，并订阅 revision 重新合成，菜单与 IME 使用统一 overlay/primary 配对 |
| `src/renderer/src/terminal/selectionActions.ts` | 划词动作：点击时 stat 变体回退（空格路径取最长存在前缀）、localhost URL 预览校验 |
| `src/renderer/src/components/selectionMenuAreas.ts` | 划词浮条菜单项条件（detectFirstUrl / selectionHasPath / selectionHasPreviewablePath） |

## 识别规则（terminalSelectionText）

**边界模型**：路径候选的左边界是「任何非路径组成字符」——CJK、`：:|*` 等全部合法（`已修改src/app.tsx`、`文件:src/app.ts`、`|src/app.ts|`、`**src/app.ts**` 都能识别）。

**URL**（`URL_RE` + `trimUrlNoise`）：`https?://` 起配（左边界防 `xhttps://` 半截匹配）；主体排除空白/引号/尖方花括号/全角标点；**半角圆括号允许进入**（wiki 风格 `函数_(数学)`），尾部做配平修剪（闭多于开则退掉多余 `)`，`https://a.com/b).` → `.../b`）。

**Windows 盘符 / UNC**（程序化手扫，非正则）：
- 盘符 `[A-Za-z]:[\\/]` 起扫，硬停字符含空白、括号、引号、全角标点与**半角 `:`**（`path:line` 归 loc 处理）；扫描跳过 `E:\` 前缀（盘符冒号本身是停字符）。
- **引号感知**：紧贴成对 `'`/`"` 时捕获引号内整段——`'E:\Projects\my app\src\App.tsx'`（npm/node 错误信息标准格式）支持空格。
- **UNC**：`\\server\share`、`\\wsl$\…`、`\\?\C:\…`（UNC 停字符集放行 `:` 供盘符形态）；`resolvePathCandidate` 原样放行 `\\` 开头。

**Unix 绝对路径**：`/seg[/seg…]`，但**单段无扩展名的 `/word` 不产候选**（`本仓/pi`、`页数/token`、`文本/Markdown` 这类 CJK 散文斜杠组合是高频误报源）；放行多段（`/etc/hosts`）、尾分隔符（`/var/log/`）、末段带扩展名与点开头（`/.bashrc`）。相对路径通道**不设**此约束（`src/utils` 这类无扩展名真实目录合法，存在性由消费方 stat 把关）。

**相对路径**：ASCII 段 `[\w.@~+-]`（`@scope`、`~`、`+` 可入段）+ 分隔符；**含 CJK 段走宽松通道**，须满足「末段带扩展名或候选尾分隔符」（文件主体允许多个点，如 `release\MetaAgent-工作台-0.1.31-Setup.exe.blockmap`）（`文档/会议纪要.md` ✓，`他/她都行` 散文 ✗），且剥离前置 CJK 散文段（`已修改src/a.ts` → `src/a.ts`；剥离后须仍有分隔符结构，否则视作真 CJK 目录段）。纯 ASCII 多段（`PDF/DOCX/PPTX`、`Marker/pdftotext` 这类斜杠组合词同样命中）语法层**故意不设**末段约束——无扩展名真实目录（`src/utils`）与组合词语法无法区分，存在性交由消费方把关（扫描/点击本就 stat；聊天区渲染前批量 stat，见下文数据流）。宽松段字符**排除箭头/数学符号区**（U+2190–21FF、U+2200–22FF）：`zip→slideN.xml` 不再整体成「文件名」。

**裸文件名**：须带字母开头扩展名（≤24 字符）或命中构建文件白名单（Dockerfile/Makefile/Rakefile/Gemfile/Procfile/Jenkinsfile/Vagrantfile/Justfile/Taskfile/LICENSE/CHANGELOG/README/NOTICE/CONTRIBUTING/AUTHORS）；含 CJK 的裸文件名（`会议纪要.md`）走宽松通道。纯数字版本号（`1.2.3`）排除。

**尾部修剪**（`trimPathNoise`）：半角/全角标点、未闭合括号；**尾部 CJK 连续段在前字符是 ASCII 字母数字时视为粘连正文退掉**（`…b.md里修改` → `…b.md`）——跟在分隔符后的 CJK 目录名（`E:\项目`）不受影响。

**URL/路径互斥**：`detectPathEntities` 先挖 URL 洞，区间重叠的路径候选丢弃——选中 `https://github.com/.../src/App.tsx` 不再出「资源管理器/预览」假按钮。

**裸域名护栏**：候选首段是域名形态（多标签 + 尾标签在常见 TLD 集）且末段无扩展名 → 当网址文本不产路径候选（`registry.npmjs.org/@scope/pkg` 不被链接化成文件）；末段带扩展名仍当路径（`app.dev/config.ts`）。注意权衡：真叫 `xxx.dev` 的单段文件会被让位给域名判定（stat 兜底）。

**localhost → 本地文件映射**（`localFileFromUrl(url, cwd)`）：`http(s)://(localhost|127.0.0.1|0.0.0.0|[::1])(:port)/<path>` → 去 query/hash → decodeURIComponent → 相对 cwd 拼绝对路径。用户实证场景：`http://localhost:5188/docs/features/virtual-screen.md` 应当按本地文件打开而非浏览器。

**含空格路径（未引号）**：识别保守截断到空白；消费方用 `greedyPathTextAt`（跨空格贪心扩展，尾部 trimPathNoise 自清理）+ `pathStatVariants`（逐空格前缀链）做 stat 回退取**最长存在前缀**。终端扫描对带分隔符的相对路径、Unix 路径同样尝试贪心扩展，以 stat 确认的最长前缀回填实体文本；划词动作仍仅对盘符/UNC 做贪心扩展；划词动作（reveal/preview）点击时回退。

## 数据流

- **终端胶囊识屏**：CLI 工作台胶囊或展开输入区的识屏按钮、普通 Shell / 后台终端的识屏胶囊 → 对应 `TerminalView` 的扫描控制 → 视口物理行（`readViewportLines` 带 isWrapped，保留折行前行尾空格并补齐上下沿逻辑行）→ `scanLinesForEntities(lines, cwd)` 合并软折行 → absList（含 localhost 映射 + 贪心变体）批量 `shell:statPaths` → `filterEntitiesByStat`（url 映射成立挂 absPath；file/dir 回填最长存在前缀；loc 须存在）→ `entitiesToHits`（stat 后通过 sourceRows 把逻辑行区间投影回可见物理行，再做 UTF-16 下标→列/宽字符映射；一个实体多个矩形共享完整路径）→ `TerminalScanOverlay`。url hit 带 absPath 时菜单在「打开链接/复制」外追加「在文件区预览/资源管理器」。终端右键不再触发识屏或由宿主扫描逻辑拦截；右键实际行为由 CLI / 系统决定。
- **划词浮条**：菜单项条件纯语法判定；「资源管理器/预览」点击时做 stat 变体回退与 localhost 校验（失败 toast「文件不存在，可改用打开链接」）。GUI 会话区划词的 cwd 来自 `.chat-list` 的 `data-sel-cwd`（会话 cwd，与链接点击同源）；其它 DOM 区域用工作区根。
- **预览打开闸口**（SideToolsPanel 统一持有）：工作区内存在直接开；找不到时仅完整（绝对）路径做磁盘级判断，存在即「外部只读预览」（`fs:readExternal` 只读通道，无写权限，详见 [files-panel.md](files-panel.md)）。会话链接化与 localhost 映射的打开都汇入该闸口。
- **会话链接化**（2026-09-11 起在渲染层）：assistant 文本由 `ChatMarkdownBody` 渲染——先出原文，挂载后 `findWorkspacePathLinks` 收集候选 → `resolvePathCandidate(cwd)` 解析 → 批量 `shell:statPaths`（20ms 微批合并多消息 + 模块级缓存，超限清空）→ **磁盘存在的候选**才由 `linkifyWorkspacePaths(text, { exists })` 包成 `` [`x`](muster-file:…) ``；流式期间跳过（文本每拍变），回合结束 streaming 翻 false 后补链。代码块/URL/已有 markdown 链接整段保护。点击路由（`AgentChatView.onFileLink` + `MarkdownBody`）：`muster-file:` / `file://` / 相对绝对路径 → 文件面板（stat 校验）；**localhost 家族 http 链接 → localFileFromUrl 映射，stat 成功进文件面板、失败回退浏览器**。链接化迁到渲染层的动机：映射层是纯同步、拿不到磁盘上下文，语法包装出的死链只能点击时 toast 兜底；副作用是消息复制（hoverbar copy parts 原文）不再混入生成的链接语法。

## 已知边界

`resolvePathCandidate` 兼容模型误写的 `/E:/...`（以及盘符后的反斜杠）：仅剥离明确 `/盘符:/` 或 `/盘符:\` 形态的一个前导斜杠，普通 Unix 绝对路径与 UNC 不变。会话链接点击解析后再进入原有文件预览闸口。

- **粘连 CJK 路径段的二义性**：`看下文档/会议纪要.md` 中「看下」与「文档」都是 CJK，语法上无法切分散文前缀与目录段——整机按整段候选处理（stat 失败即弃）。空格/标点引导的 `整理到 文档/会议纪要.md` 正常。
- **聊天链接化的存在性闸口**以会话 cwd 为基准：模型提到「计划创建」的文件尚未落盘时不出现链接；stat 结果缓存 60s 惰性 TTL（先提到、后创建的文件最迟 60s 出链接），超限整体清空；stat IPC 失败按不存在处理（宁缺链接不出假链接）、不缓存、下次渲染重试。`src/utils` 这类无扩展名目录在聊天区仍可链接（stat 放行），但在纯语法通道（划词浮条菜单条件、爆炸分词）里与组合词无法区分。
- 扫描只扫当前视口、stat 必须存在（设计约定，见 `docs/superpowers/specs/2026-08-11-terminal-right-click-scan-design.md`）；截断误报在扫描里的表现是整条消失。
- 未引号且含 `(` 的空格路径（`Program Files (x86)` 裸形态）不贪心（括号是硬停），只有引号包裹形态支持。
- 自动软折行按 xterm `isWrapped` 合并；真实换行不拼接。视口外上下文只用于补齐与视口相交的逻辑行，浮层仅显示可见片段。文件必须仍然存在：构建日志里的临时卸载程序等若已被清理，仍不会高亮。
- **形如路径的 markdown 链接 label 不再被嵌套双包**（2026-09-11 评审发现，2026-10-26 已修）：链接化层对「前有未闭合 `[`」的候选跳过包裹——`[src/a.ts](url)` 的 label 与磁盘真实路径同名时不再产出损坏嵌套；同段纯文本路径与 `arr[0]` 后的路径照常包裹（守卫在 linkifyWorkspacePaths 候选入口，识别核心不动，终端扫描/划词/爆炸分词行为不变）。

## 测试

`test/terminal-selection-text.mjs`（核心：边界/修剪/引号/UNC/段字符/白名单/URL 配平/互斥/域名护栏/localhost 映射）、`test/terminal-scan.mjs`（实体组装 + stat 回填 + localhost 挂载 + 空格贪心）、`test/linkify-paths.mjs`、`test/gui-worker-paths.mjs`（链接化与幂等）。`test/unit/terminal-ui-open.spec.tsx` 另覆盖跨行矩形点击与完整路径预览、视口外上下文读取；`cli-session-view`、`terminal-scan-capsule`、`terminal-scan-overlay-focus` 组件用例覆盖识屏入口、焦点和截图时隐藏悬浮层；`test/e2e/cli-workspace-context.spec.ts` 覆盖右键不触发扫描、输入区层级及截图等待超时/切会话恢复。浏览器视觉可用生产 xterm + scanBuffer + TerminalScanOverlay 夹具验证。改识别规则先补红用例再动正则。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D04-D05.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：终端胶囊识屏、划词浮条、会话 Markdown 路径链接化、「爆炸」分词四个消费方共用的唯一识别核心——把一行纯文本切成 URL/文件/目录/path:line 实体；源于三个文件五份正则互相漂移的历史教训（2026-09-02 收敛单源）。
- 为什么这样设计：单源收敛防漂移；**纯语法识别 + 消费方 stat 把关**——识别核心不摸磁盘，扫描/点击本就 stat，聊天区先渲染原文再批量 stat（20ms 微批+60s 缓存）、磁盘存在的候选才包链接，「宁缺链接不出假链接」；URL/路径互斥、裸域名护栏、CJK 散文斜杠不产候选、localhost→本地文件映射（用户实证场景）等全是误报驱动的取舍；识别规则改动必须先补红用例（测试即合同）。
- 明确不做：识别核心不做磁盘感知/缓存（存在性一律消费方把关）；粘连 CJK 前缀二义性语法上无法切分（「看下文档/会议纪要.md」整段候选、stat 失败即弃）；未引号含 `(` 的空格路径不贪心；文件必须仍存在（构建日志里已清理的临时路径不高亮）。
- 歧义点：①「纯语法核心+stat 把关」是长期架构吗：A=长期（「语法层无法区分组合词与无扩展名目录」不是缺陷；误报调优只动语法层，review 不催加磁盘感知）／B=未来加磁盘感知/缓存层进核心。推荐 A。②嵌套双包已知 bug（形如路径的 markdown 链接 label 被嵌套双包损坏渲染，2026-09-11 评审发现、修复方向已注明：对「前有未闭合 `[`」的候选跳过）的处置：A=吸收进本专项（review 确认后按 P2 排修）／B=维持「待后续轮次」不吸收。推荐 A——有复现路径、有方案方向，正是可靠性专项的目标类问题。
