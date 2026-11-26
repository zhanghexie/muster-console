# 实用工具：常用网格与文件夹列表原型

2026-10-05 · [打开单文件原型](extension-sidebar-study.html) · 产品方案

本批交付用来实际体验导航组织。文件夹放进原有实用工具：仅保留“实用工具”标题，上方是内置工具与常用磁贴，末尾增加“展开 / 收起”。下方网页/扩展列表默认完全收起，并记住上次选择；展开时显示分隔线和文件夹树，无“常用”“网页与扩展”两个表头。折叠后列表、分隔线与管理按钮一起释放空间，会话列表上移。侧栏选择入口后在中央显示示例工作区；会话独立。样例中的内置工具、素材、队列、网页与 Agent 都是演示内容，不构成具体业务产品的接入。

## 运行与操作

从仓库根运行 `node scripts/build-extension-sidebar-study.mjs --serve`，打开命令输出的回环地址。也可直接用浏览器打开 HTML；代码与样式已内嵌，产品字体仍按现有 CSS 尝试加载，离线时走系统回退。

| 操作 | 可见结果 |
|---|---|
| 网格最后一格“展开 / 收起” | 整段列表开合；折叠后不留占位、不丢分组与当前面板，Enter/Space 同样可操作，刷新记住选择 |
| 点击常用磁贴（含文件夹） | 直接打开中央内容，保持列表当前开合状态 |
| 下方条目 ··· → 添加到常用 | 上方出现同一入口的磁贴；下方仍保留在原文件夹，不重复添加 |
| 常用磁贴 ··· → 从常用移除 | 只移除上方快捷入口，下方入口与当前内容保留；支持撤销 |
| 常用磁贴 ··· → 在列表中显示 | 自动展开整段列表及父文件夹，在下方选中并聚焦对应入口 |
| 改名已添加常用的条目 | 上方磁贴与下方列表名称同步；从列表取消固定时两处同步消失 |
| 展开/收起文件夹 | 只改变下方子项可见性；滚动条占位固定，常用网格与列表的宽度、边距保持一致 |
| 把“日常工具”拖到“创作工具”上边缘 | 出现插入线，松开后交换相对顺序，整组子项保留 |
| 把“参考图库”拖到“灵感参考”中间 | 文件夹高亮，松开后移入；折叠目标悬停可自动展开 |
| 拖到列表下方“移到最外层” | 入口移出文件夹；也可右键 → 移动到 → 最外层 |
| 展开后点击列表末尾“新建文件夹” / 右键 → 新建子文件夹 | 创建分组或嵌套分组；选中后 F2 改名 |
| 展开后点击列表末尾“固定网页” | 添加 HTTP(S) 网页入口；无协议域名补 HTTPS，本机 localhost 补 HTTP |
| 右键 → 解散文件夹，保留内容 | 直接子项提升到原分组位置；子文件夹内部结构保留 |
| 点击底部“撤销” | 撤销最近一次结构/名称变更，最多保留本页 20 步 |
| 方向键、Home/End、Alt+↑/↓、Shift+F10 | 浏览树、同级排序、打开操作菜单；不依赖拖拽 |
| 编辑“工作笔记”后切换面板再返回 | 本次页面运行期的草稿保留 |
| 刷新页面 | 分组、排序、名称和折叠状态保留；“恢复示例”可重置 |

禁止把文件夹移入自己或后代；不会搬动磁盘目录。预览导航用独立 localStorage key `metaagent.extension-sidebar-prototype.v1`，整段列表开合用同 key 的 `.library-expanded` 后缀；不读取真实扩展或工作台配置。HTTP 预览地址端口不同属于不同浏览器 origin，因此重新启动预览服务可能出现新的一份样例数据。

## 实现与后续接入

- 复用的模型：`src/shared/extensionNavigation.ts`。同父节点按数组次序排序，`parentId` 描述树，移动文件夹不改子项引用；解散只提升直接子项。`favorite` 可选布尔标记常用，两处引用同一节点；旧预览数据缺省无常用标记，不清空已有分组。持久化加载拒绝坏父节点、环、重复 ID 和非 HTTP(S) URL。
- 候选组件：`src/renderer/src/components/UtilityNavigationSection.tsx`、`ExtensionNavigationTree.tsx` 与 `styles/extension-navigation.css`。接口为 nodes/selection/change/select 与 libraryExpanded/onLibraryExpandedChange；原型回调实现内存撤销与保存，组件不绑定正式 store/IPC。整体开合使用 usePresence + acc，退场立即 aria-hidden/inert，动画完成后卸载；文件夹内部折叠状态由节点持有，重新打开不会丢失。
- 预览外壳：同目录 TSX/CSS；`scripts/build-extension-sidebar-study.mjs` 复用产品 React、图标、base.css、left.css 的磁贴网格、主题及 presence 生成 HTML。
- 导航滚动容器用 `scrollbar-gutter: stable` 保留滚动条空间。真实 Chromium 验证显式移除 Playwright 默认的 `--hide-scrollbars`，避免隐藏开合时滚动条挤占宽度的问题；`--layout-only` 可仅跑几何回归。
- 正式接入仍需：导航存储与迁移、工作区/全局作用域、URL/视图实例绑定、Pin 浏览器当前页、页面/后台生命周期、扩展信任与高级原生能力。现有扩展 review 两项 P1 不在本批中修复。

## 验证记录

| 检查 | 结果与证明范围 |
|---|---|
| `node test/extensions-navigation.mjs` | 26 条断言通过：移动、防环、解散、可见性、URL、常用标记与旧数据加载 |
| `npm run test:unit -- extension-navigation` | 20 项通过：既有文件夹/常用交互，新增默认折叠与无表头、退场不可交互、状态/草稿保留、开合保存、显式定位、快捷入口移除后焦点、快速反向开合 |
| `npm run typecheck` | web/node/test 三套通过 |
| `node scripts/verify-extension-sidebar-study.mjs --allow-fallback-font` | 真实 Chromium 鼠标/键盘 18 组场景通过：整体折叠与会话空间恢复、网格宽度稳定、保存/定位，以及常用添加/移除/恢复、原生拖拽、分组/子项保持、移动菜单、解散与撤销、切换草稿和刷新恢复 |
| 截图审阅 | 已查看 18 种状态：浅色 832px、深色 1440px 与浅色 390px 的整体展开/折叠，另含浅/深 1440px、深色 780px、浅色 390px、常用菜单与新增磁贴、拖动、移动菜单与弹窗；浮层四边界断言通过 |
| `node scripts/verify-extension-sidebar-study.mjs --allow-fallback-font --layout-only` | 7 组通过：832/1440/390px 整体开合、恢复会话位置且无残余高度，文件夹溢出切换几何稳定，以及刷新保持收起/显式定位；保留真实滚动条 |

本地截图、几何清单与审阅记录在 `.tmp/ui-captures/extension-sidebar-study/`。首次默认字体检查因 `net::ERR_NETWORK_ACCESS_DENIED` 失败，保留 `manifest-font-blocked.json`；后续显式允许回退字体，仅验布局/行为，未确认 OPPO 字体可读性。没有页面脚本错误。

开合边距修复证据在 `.tmp/ui-captures/extension-sidebar-layout/`，保留滚动条修复前的 `246 !== 256` 失败清单；当前清单与 `library-*.png` 验证整段列表开合和文件夹宽度稳定。当前内置浏览器已刷新并实际开合，保留用户分组与常用数据，最终停在紧凑收起态。React 18 的布尔 inert 写法在新增用例下失败，改用项目既有空字符串属性约定后通过；测试脚本括号笔误修正后完成浏览器验证。

未运行全量测试或正式 Electron/安装版验收；网页并未实际加载，扩展后台、Agent、真实工作区存储和第三方登录尚不属于这个原型。
