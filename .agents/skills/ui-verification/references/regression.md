# 回归测试与范围选择

## 先找项目已有入口

- 测试分工与门禁：`docs/features/testing.md`。
- 组件样板：`test/unit/confirm-dialog.spec.tsx`、`test/unit/helpers/api-mock.ts`。
- 真实原生输入与发送：`test/composer-newlines-visual.mjs`、`test/unit/composer-live-markdown.spec.tsx`。
- 拖动快照与实用功能选中态：`test/left-selection-resize-visual.mjs`（CSS 最小夹具，不是整 app）。
- 动画生命周期：`test/unit/motion-presence.spec.tsx`；不要新增独立动画体系。
- 完整应用：`test/e2e/fixtures/electron.ts` 和对应 spec。

这些文件是实现样板，不是所有任务都要执行的清单。先确认当前版本的 API/selector，避免复制过期断言。

## 断言真正会坏的结果

| 症状 | 有价值的断言 | 不足以证明修复 |
|---|---|---|
| 输入换行发送后消失 | 按键输入后断言 `onSend`/IPC 收到的完整原文和换行 | 只断言输入框 `textContent` |
| 标题/列表输入内不预览 | 发送前检查真实编辑器行样式、列表标记并查看截图 | 只检查发送后的消息气泡 |
| 多行/胶囊重编辑错误 | 从队列取回 → 改文本 → 再发，断言完整正文、批注 id 和图片 | 只断言按钮存在或源码包含某函数名 |
| 首字导致面板跳高 | 同一状态空→首字→继续打字→清空的实测边界、壳层渲染计数 | 把自然多行增高也判成跳动 |
| 覆盖层模糊/重影 | 改变下面内容后比较覆盖区域实际像素，再查看图 | 只检查较大的 z-index |
| 选中不明显 | 实际状态切换、相邻闲置行对照，读取合成后颜色并查看图 | `class=active` 存在 |
| 边距不一致 | 比较实际可见项到同一框边的距离，考虑内外 padding、滚动条和 transform | 所有 CSS padding 字面量都等于 8px |

原子批注/文件/技能胶囊的装饰文字与序列化源不同；`textContent` 包含 label/×，块元素的换行也不一定进入 `textContent`。发送契约用输入核 `getText`、序列化函数或最终回调参数判断。

## 真实事件与模拟事件

- 用 Playwright `locator.pressSequentially`/`press` 复现原生编辑；`fill` 会绕过逐键触发、自动续写等路径。
- 用 locator 点生产组件，不在页面中直接调用内部处理函数代替用户动作。
- 构造 DIV/BR、合成 ClipboardEvent 或 composition 事件可做确定性回归，但它们不等于真实系统剪贴板/中文输入法。标明该边界；关键问题按需补真 app 人工验证。
- 拖动用真实 mouse down/move/up，动作期间的截图也要包含实际覆盖层；只修改 state 的截图属于稳定态验证。
- 不把 `window.api` 全部设成返回成功。初始化读接口用合法形状；关键写接口明确记录调用与参数，必要时推送事件模拟主进程回执。真实 IPC/原生视图需 Electron 验证。
- 测外部写入/清空/快捷短语时，通过消费者入口或 imperative handle；避免用 React value 重渲代替实际 uncontrolled 热路径。
- IME、焦点恢复、选择替换、撤销重做、删除原子 token 只在本次触及编辑核时纳入；普通颜色改动不必跑这一整组。

## 只跑本次影响面

指定组件文件：

```powershell
npx vitest run test/unit/composer-live-markdown.spec.tsx test/unit/composer-note-tokens.spec.tsx
```

并发工作区不要无差别 `npm test` 纳入其他人的修改。把本次实际改动清单存到 `.tmp/<任务>-changed-files.txt`（每行仓库相对路径）再执行：

```powershell
node test/run.mjs --changed-files .tmp/my-ui-changed-files.txt
```

TS/接口变化时检查涉及的配置；提交门禁还会检查三套：

```powershell
npx tsc --noEmit -p tsconfig.web.json
npx tsc --noEmit -p tsconfig.test.json
```

仅 CSS/文案可先运行对应 CSS/字体守卫和必要截图。不要主动使用 `--full`/`TEST_FULL=1`。改到测试基建/构建配置时允许 runner 自动升全量，解释原因即可。

## 回归用例是否能拦住旧 bug

优先保存修复前的失败证据：同一用例在旧行为转红、修复后转绿。若确需做负向验证，使用隔离暂存快照/临时 worktree 或内存编译旧模块；不要在并发工作区 `git checkout`/`git restore` 覆盖别人的修改。限定相关用例并保留失败原因，不能靠任意编译错误充当复现成功。

## 提交与异常

- 提交前检查 `git diff --cached --stat` 与 `--name-only`；仅暂存自己负责的文件/块，不 `git add .`、不 stash 其他工作。
- 共用 journal 或文档使用分块暂存；不能把未审阅的并发条目顺带提交。
- 提交门禁测暂存快照，所以未加进索引的新文件也可能使门禁失败。核对文件清单，不通过时修复并正常重试，不 `--no-verify`/`SKIP_TESTS=1`。
- 测试/字体/脚本/构建失败及时说明实际错误，保留日志，不把脚本继续跑到末尾当成功。
- 索引锁先查活跃 Git 进程和创建时间；有进程时等待。只有确认无持有者、路径正确且是残留锁时才清理；不要看到锁就删除。
- 成功提交后读最新 SHA，并确认本次文件没有未提交修改；不要声称其他未提交文件已提交。
