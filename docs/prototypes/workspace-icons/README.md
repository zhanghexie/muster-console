# 工作区软件分类图标设计来源

用户确认 `approved-flat-36.png` 后要求切成透明图标，供新建/编辑工作区选择，并移除工作区 emoji 控件。风格沿用已确认的职业符号，主题改为软件类别和游戏类型。

- 原图：内置 image_gen 生成的 1254×1254、6×6 图，保留原像素；原生成文件名 `exec-35aa261a-b60d-4c63-9e97-b10644b861f8.png`。提示核心：36 workspace icons for software categories and game genres, flat geometric solid glyphs, no people/3D/complex materials, recognizable universal gamepad, Chinese category labels。
- `crops.json`：36 个 ID 的精确裁切坐标和输出参数；裁掉文字，保留图案及内部留白。
- `cut-icons.mjs`：沿用职业符号的确定性裁切/透明处理方法，保留内部颜色，从相邻实心颜色恢复边缘 alpha，去除深色底。需仓库可解析 sharp；运行 `node docs/prototypes/workspace-icons/cut-icons.mjs` 重建，不调用模型。
- 输出：`src/renderer/src/assets/workspaces/<id>.webp`，36 张、256×256（208px 主体范围 + 四边 24px 透明留白）、质量 95、alphaQuality 100，总计 373940 字节。

软件包括新闻、社交、即时通讯、开发、视频、音乐、直播、摄影、设计、写作、阅读、教育、日程、任务、笔记、邮件、云盘、安全、数据、财务、购物、旅行、地图、健康；游戏包括通用手柄、动作、射击、角色扮演、策略、竞速、体育、解谜、模拟经营、沙盒、节奏、卡牌。

目录/ID 以 `src/shared/workspaceIcons.ts` 为单一来源，正式接线见 [工作区分类图标](../../features/workspace-icons.md)。原图与此目录只用于维护来源，应用加载独立 WebP。
