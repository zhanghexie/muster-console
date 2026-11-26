# 扩展图标设计来源

四张总图由 imagegen 生成，分别覆盖开发与数据、文件与生产力、通信与安全、创意与科学四个领域；每张按 8×4 网格排列 32 个透明、纯单色系统 glyph，共 128 个。`extension-icons-preview.png` 是裁切后的画廊预览。

运行 `python scripts/build-extension-icons.py` 会按网格裁切、去除低 alpha 噪声、统一为中性灰、缩放到 64×64，并输出到 `src/renderer/src/assets/extensions/`。运行时只静态导入裁切后的 PNG，不加载总图。
