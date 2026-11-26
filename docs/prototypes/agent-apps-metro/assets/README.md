# 黄色 Lumia 930 风格机身

`lumia-930-yellow.png` 使用内置 **image_gen** 工具生成，再由同一工具移除外部背景；没有使用 CLI 或代码绘制替代机身。黄色配色按用户要求制作，属于概念视觉。造型参考 [Microsoft 的 Lumia 930 介绍](https://blogs.windows.com/devices/2014/04/02/nokia-lumia-930-simply-the-best-of-microsoft-and-lumia/)。

- 原图 1024 × 1536，RGBA；浏览器 Canvas 只用于读取并核验左上角 alpha=0，未修改像素。
- 图片中的机身、听筒、NOKIA 标识和返回/Windows/搜索三个符号来自生成素材。
- 真实 React 页面叠放在屏幕区域；图片上不包含 App 文本。三个实体键区域叠放可聚焦的透明按钮。
- `lumia-apps-preview.png` 是三个实际 App 嵌入机身后的浏览器截图。
- 构建读取产品侧机身 PNG 并内联到单文件 HTML，直接打开即可离线预览。[原型预览](../index.html)
- 生成源保留于 Codex generated_images。工作台和原型共用产品侧的一份 PNG。[项目内的机身图片](../../../../src/renderer/src/agentApps/assets/lumia-930-yellow.png)

## 生成提示词

```text
Use case: product-mockup. Create ONE isolated, high fidelity photorealistic 3D product asset: a Nokia Lumia 930 smartphone in a vivid canary-yellow custom colour, perfectly straight-on front orthographic view. This is a reusable PHONE FRAME for a live interactive Windows Phone app prototype; real HTML will be composited over its empty display afterwards. Portrait composition, entire device visible, no perspective tilt, no rotated angle, no hand, no second phone, no environment. Exact Lumia 930 design language: compact squared-off monoblock, very gently rounded exterior corners, subtly machined aluminium inner rim, cheerful yellow polycarbonate outer edge and body visible as a consistent substantial 6-9 mm-looking yellow frame around the black front glass. Not an iPhone and not a modern edge-to-edge screen. Deep charcoal/black glossy front bezel, discrete horizontal earpiece and small NOKIA wordmark above the display, tiny front camera. The display itself is a clean, completely blank, uniform near-black rectangle, square screen corners, 9:16 aspect ratio, no reflections or gradients over the display, NO UI, NO wallpaper, NO text within the display. There is a proper top bezel and bottom chin outside the display. On the bottom BLACK chin print EXACTLY THREE slender white capacitive navigation symbols in a single row: left a leftwards back arrow (←), centre the authentic four-pane Windows Phone window logo, right a magnifying-glass search icon. They must be evenly spaced and completely outside the screen rectangle. No words labelling the three buttons; no circles around these hardware icons; no fourth button. The phone is completely symmetrical, vertical edges perfectly parallel. Lighting is soft neutral studio illumination, small realistic rim highlights with restrained shadows, sharp material detail and clean anti-aliased outline. Outer background must be genuinely transparent alpha, not a checkerboard drawing. Keep the whole black screen opaque. Frame tightly with a small equal transparent margin; the body should occupy about 84% of image width and 94% of image height. No watermark, no layout labels, no measurements. The visual priority is a joyful iconic YELLOW Lumia body with black glass and these three precise bottom keys.
```

## 去背景提示词

```text
Precise edit of the supplied phone image. REMOVE ONLY THE BACKGROUND: isolate the entire yellow phone including its right-side buttons onto genuinely transparent alpha. Remove absolutely all yellow background, yellow glow, vignette and cast shadow OUTSIDE the phone silhouette. Outside pixels must be transparent, not white, black or a drawn checkerboard. Keep the phone itself pixel-faithful in appearance and position: unchanged bright yellow frame, black glass and rectangular blank opaque-black display, earpiece, camera, NOKIA text, and the EXACT three bottom white navigation symbols: back arrow, Windows four-pane Home logo, magnifying glass. No new objects, no relighting or re-design. Keep the same canvas size and phone scale and coordinates as the original. The interior display must remain solid black, not transparent. This is a clean isolated product cutout for a UI prototype.
```

两个调用均设置 `transparent_background: true`。首张仍有外部光晕，第二次定向去背景后核验真实 alpha；最终浏览器截图已确认不存在黄色矩形底图。
