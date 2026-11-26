# 子代理职业头像设计来源

当前采用用户最终确认的简约扁平几何符号：参考软件侧栏小符号的简洁感，用少量色块和留白表达职业，完全去除人物和复杂材质。24 个职业名、角色 ID 与 AI 选角接口保持原合同。

- `approved-flat-24.png`：内置 image_gen 生成、用户确认的 1536×1024、6 列 × 4 行简约版原图，保留原始像素。原生成文件名 `exec-de1543e5-cab8-4ff2-a703-c575b2edded5.png`。提示核心：flat abstract profession glyphs, 2–5 bold rounded pieces, subtle profession metaphors, dark neutral background, no people / 3D / complex materials。
- `crops.json`：当前各符号在原图中的裁切坐标（左上原点、像素单位）及输出参数，裁掉名字和职业文字。
- `cut-avatars.mjs`：用 sharp 裁切并去除近中性的深色背景；内部保持不透明原色，边缘从邻近内部颜色恢复 alpha，清除留白与中心空隙中的背景。修齐后等比放入 208×208，四边各补 24px 透明留白，以质量 95、alphaQuality 100 输出 256×256 WebP。复现：仓库已可解析 sharp 时执行 `node docs/prototypes/subagent-avatars/cut-avatars.mjs`；脚本不调用模型、不改角色定义。
- 正式头像：`src/renderer/src/assets/subagents/<id>.webp`，共 24 张、239542 字节。名字、职业和 ID 以 `src/shared/subagentCharacters.ts` 为准。角色本体不重绘；去底后同一文件适配深浅主题。
- `approved-a-24.png` / `crops-a.json`：早期 A 软萌 3D 方案及其裁切坐标，仅保留历史设计来源，不再用于运行时。用户实际查看后改选了当前扁平方案。

运行时只加载单张头像，不加载此预览原图。完整实现、数据流与测试见 [子代理职业角色](../../features/subagent-characters.md)。
