---
doc_type: feature
---

# 代码动画扩展

源码与扩展级回归位于 [muster-extension-code-animation](https://github.com/zhanghexie/muster-extension-code-animation)。扩展目录为 `code-animation/`。

早期动映原型的页面、素材和许可已整体归档，恢复入口见原型索引。[仓库外归档](../prototypes/README.md#仓库外归档)

代码动画扩展提供风格检索、作品管理和可复现的 HTML 动画交付。风格库用于按系列和关键词筛选 341 个风格，区分 196 张静帧参考与文字参考；我的作品用于保存待制作作品、项目任务成品和导入的 HTML/WebM 文件。

## 关键文件与职责

- `code-animation/extension.json` 声明 sidebar、工作区数据、项目任务和领域查询/命令。
- `code-animation/domain.mjs` 读取 `skills/code-animation-prompts/references/catalog.json`，通过宿主 `data.read` / `data.write` 保存 `library.json`，并校验作品版本、任务引用和项目相对 HTML 路径。
- `code-animation/panel/` 提供风格卡片、静帧预览、已选清单、任务创建、作品筛选、缩略图和作品预览；面板颜色继承宿主主题，作品和风格详情使用全视口 scrim 与居中卡片。
- `code-animation/skills/code-animation-prompts/` 固化提示词、参考静帧、`render-contract` 模板、`scripts/styles.mjs` 风格查询、`scripts/check_render.mjs` 渲染预检、`scripts/generate_previews.mjs` 生成式预览、`scripts/crop_preview_sheet.mjs` contact sheet 裁剪和 `references/rendering.md` 协议；`assets/generated-previews/manifest.json` 记录预览来源，生图模型产出的 `assets/generated-previews/ai/*.webp` 会覆盖同编号的通用占位图，当前 145 个风格条目均使用生图预览。
- 通过扩展中心安装版本包，或用本地安装入口导入同名扩展目录。重载会刷新面板 iframe 和领域实例。
- 独立仓库的 `test/code-animation-extension.mjs` 覆盖扩展领域和面板的持久化/交互回归；`test/code-animation-protocol.mjs` 防止渲染协议和旧文案漂移。

面板用 SDK 的 canvas、raised、overlay 及配对前景渲染浏览区和作品详情，预览画面保持原有配色。窄栏使用双列卡片和可换行筛选。勾选风格导致卡片更新时，焦点恢复到同一风格的控件。

## 数据流

面板打开后通过 `catalog` 读取索引，通过 `library` 读取当前工作区的已选风格和作品。勾选、作品资料、收藏、任务登记和移除都经 domain command 串行写入 `library.json`。导入的 HTML/视频先走宿主文件选择器和媒体资产存储，再只在扩展数据中保存资产 ID；项目任务成品保存任务引用和项目相对 HTML 路径，缩略图由宿主任务预览接口生成。

制作任务按以下顺序使用同一份项目文件：

1. 在任务目录中保存 HTML 入口和 `assets/` 等多文件资源，入口仅引用项目相对路径。
2. 在入口中实现 `window.renderAt(t)` 和 `render-contract` 元数据。`renderAt` 以秒为单位从固定种子和 `t` 重算完整画面；最终任务加载带 `?export=1` 的入口以禁止自播放循环。
3. 运行 `node code-animation/skills/code-animation-prompts/scripts/check_render.mjs <入口> --project-root <任务目录>`，检查元数据、关键帧、资源存在性、确定性时钟/随机数和最小可见绘制输出。
4. 使用 `ma.tasks.preview` 或 `ma.exports.preview` 在工作台内置浏览器打开页面，检查资源加载、页面错误和开头/中段/结尾关键帧。内置浏览器实时录屏只用于预览或证据，不能作为最终确定性导出。
5. 将入口、资源清单、尺寸、帧率、时长、种子和关键帧交给 `host.tasks.render`（SDK 入口为 `ma.tasks.validate` / `ma.tasks.render`）：`validate` 传入关键帧时会重复采样并比较，`preview` 可单独采样，最后 `start`；用 `status` 查询进度、用 `cancel` 取消。服务逐帧调用 `renderAt(frame / fps)`，用 Node/WebCodecs 编码 VP8 并封装 `video/webm`，返回产物引用、实际帧数、尺寸和时长。
6. 只有状态为 `completed`、产物 MIME 为 `video/webm` 且关键帧两次像素摘要一致时才登记作品；失败或取消只保存可读报告，不写入假成功记录。

## 渲染任务合同

`render-contract` 是预检、渲染服务和验收的共同输入，至少包含：

```json
{
  "duration": 12,
  "fps": 30,
  "width": 1920,
  "height": 1080,
  "seed": "launch-v3",
  "keyframes": [0, 6, 11.966666667],
  "assets": ["assets/logo.svg", "assets/hero.webp"]
}
```

关键帧必须从 0 秒开始，包含中段且严格递增；`assets` 中的每个路径必须位于项目目录并可读取。多文件资源不能通过本机绝对路径或大段 Base64 绕过项目管理。页面必须有可验收的几何、图像、视频、粒子或其他绘制输出，只有标题、段落或字幕的页面不合格。

渲染状态为 `preparing → rendering → finalizing → completed`，也可进入 `failed` 或 `cancelled`。`host.tasks.render` 的 `times` 传输值以毫秒表示，宿主调用页面时转换为 `renderAt` 所需的秒；页面接口始终以秒为单位。失败回执通过 `failure` 提供阶段、已完成帧数、失败帧/关键帧时间、错误消息和下一步；资源检查与页面 console 摘要由扩展验收记录补充，不写入凭据、宿主私有路径或整页正文。关闭页面、工作区换代或用户取消后旧任务不能覆盖新任务。

## 边界与验收

扩展不把本地绝对路径写入作品记录，也不把大文件经 IPC 或 Base64 传给面板。作品移除需要宿主确认，项目文件不会因移除作品记录而删除。风格提示词和静帧保留原始来源及许可说明。

最终验收需要同时满足：Node 预检通过；内置浏览器中的资源无错误；三个关键帧重复渲染得到相同像素摘要；截图能证明非文字视觉输出；渲染回执状态为 `completed` 且 WebM 可在工作台浏览器中播放。音频、远程网络资源和真实用户手势不是该合同的隐式能力，任务若需要必须显式声明并接受宿主能力检查。
