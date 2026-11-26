# 界面表面与悬浮层级

## 职责与规则

背景角色、视觉海拔、交互层叠分开管理。悬浮感由实底、连续轮廓与投影共同建立，不通过提高 z-index 或加亮文字模拟。保持现有布局尺寸与圆角。

| 层 | 对象 | 边缘 | 投影 |
|---|---|---|---|
| 框 | 顶栏、侧栏、布局留白 | 不额外描边 | 无 |
| 工作面 | 会话、右侧页 | surface-rim | 无（2026-10-26 去投影，elevation-sheet 置 none） |
| 输入壳 | Composer | border-control；焦点单独替换边色 | 无（用户试看方案） |
| 页内浮起物 | 看板会话卡片 | board-card-border；选中用 board-card-border-focus | 无（2026-10-26 去投影，elevation-raised 置 none） |
| 临时浮层 | 菜单、弹窗、调度浮窗、全局看板外壳 | 全局看板用 surface-edge（与会话区域同源），其余沿用 overlay 边界 | shadow-pop |

看板外壳与列共用会话 canvas 底面；状态列不画装饰轮廓，靠留白组织会话卡片。自由画布也取消视口轮廓与内层圆角，保留裁切及交互边界，与状态视图保持连续底面。

## 单一来源与实现

- `src/shared/resolvedAppearance.ts` 派生颜色和主题投影。material-rim 在主题色关闭时使用 ink 的 10% 透明度；开启时先把 ink 向工作区色混合 65%，再取同样透明度，形成轻染的连续轮廓。会话、右页与全局看板的共用描边从 6% 调到 10%，保持 1px 宽度。全局看板外壳使用与会话工作面相同的 surface-edge（material-rim），frame-edge 保留为兼容派生角色。颜色计算只在 resolver 中完成，不使用状态色。
- `styles/base.css` 的结构 token 定义 surface-edge → material-rim，surface-rim → inset 0 0 0 1px；elevation-sheet 与 elevation-raised 自 2026-10-26 起均为 none（用户定稿：工作面与看板卡片去投影、只留描边），token 槽位保留，需要时再独立调档。
- `base.css` 的会话/右页：宿主投影当前为 none；独立 ::after 仍在内容上画完整内圈，继承宿主圆角，不占布局、不截获操作。不得再用上下两条 inset 阴影拼圆角。
- `chat.css` 的 chat-input-shell 静息/聚焦均无阴影；`board.css` 的 board-card 无投影（elevation-raised=none），保留一圈 board-card-border 作为唯一轮廓，不叠第二圈材质高光。聚焦/选中只改变既有边色，避免双框。
- `material.css` 只负责材质与实底，不再次覆盖工作面的投影。窄屏右抽屉继续取消内页皮肤，避免外抽屉和内页双重悬浮。
- 滚动裁剪属于内容，阴影需要祖先绘制空间。现有 4px 框距和看板滚动缓冲保留。不要全局移除 overflow/contain 来解决某条细边。

无新增 IPC、设置字段或动画。业务通知 Beam、状态边框与拖动反馈各保留独立语义，不属于静态材质高光。

## 审查结论与验证

分屏子面板原先额外绘制右/下边框，会与工作面外轮廓叠加（截图会话边 RGB 54/54/56，右页 33/33/35）；现删除子面板伪边，只让现有 center-split-divider 绘制真实内部缝。会话输入聚焦的旧 shadow-input 高优先级覆盖也已移除。原会话/右页 ::after 只有上下 inset 细线，左右缺线导致角部过渡不连续；看板使用单顶边 shadow-paper，绘制层和工作面不同；主题色分支重复写 shadow-page；深色 Composer 无投影而浅色有。现统一上述消费点。

`node test/frame-gap-visual.mjs` 加载完整生产 styles.css 导入链，包含分屏子面板与右工作面的真实类名结构，覆盖深浅主题、主题色、窄屏、页面位置及四边像素；追加相邻工作面边缘像素相等、内部缝可见、看板容器圆角/完整边缘、输入静息及聚焦同档投影检查。--baseline-pane-borders 恢复旧分屏伪边后能复现截图的同值像素差异并转红。夹具证明 CSS 绘制，不证明完整应用的原生 Mica、原生浏览器视图或所有分屏组合。真实桌面仍需验收四角、满铺编辑器、看板滚动与切换后的边缘。

全局看板染色回归：node test/global-board-edge-visual.mjs 使用真实 GlobalBoard 与主题发布函数，mock IPC；深浅主题、1440/780 宽度验证关闭→紫→绿→关闭，检查实际外缘像素与 surface-edge 消费，并生成截图。原生桌面合成不在该测试范围内。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D07.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：背景角色/视觉海拔/交互层叠分离的表面体系：框（顶栏侧栏）→工作面（elevation-sheet+surface-rim）→输入壳→页内浮起（elevation-raised）→临时浮层（shadow-pop）五档。
- 为什么这样设计：颜色/投影只在 resolvedAppearance resolver 单一来源计算（material-rim 主题色轻染、全局看板专属 frame-edge）；工作面外投影+::after 内容上完整内圈（继承圆角、不截获操作）——废除上下 inset 拼圆角与主题分支重复写档；悬浮感由实底+连续轮廓+投影建立，不靠 z-index/加亮文字模拟。
- 明确不做：不加新 IPC/设置字段/动画；外缘/底部 4px、中央页缝 4px，保留看板滚动缓冲（阴影需祖先绘制空间）；不用全局移除 overflow/contain 换细边；通知 Beam/状态边框/拖动反馈保留独立语义不并入材质高光。
- 歧义点：无真决策（审查结论已统一各消费点，frame-gap-visual 像素回归守卫；剩余属真机验收事项）。
