# 本机产物生命周期与清理

## 职责

`.tmp/`、`test-results/run-*` 和 `release/` 安装包都是本机产物。Playwright 命令通过时自动删除本次默认输出目录。手动清理入口 `npm run clean:tmp` 按保留策略筛选三类产物，默认预览，`--apply` 把候选移动到同盘隔离区。

dry-run 默认只报条目数、不递归测体积：面对历史堆积（`.tmp` 约 100 万文件）逐个 `stat` 要几分钟，实测会超时。要精确数字显式加 `--measure`；`--apply` 默认测量并写入清单。

## 产物来源

1. `playwright.config.ts` 为每次 E2E 使用独立的 `test-results/run-<UUID>` 目录，避免旧夹具或被锁定的 trace 阻塞下一次运行。失败、中断和超时的产物留在该目录，供排查和后续手动清理。验收取证可用 `--output .tmp/ui-captures/<验收名>` 显式保留本次产物。
2. `.tmp/` 没有任何 TTL 或退出清理。一次性验证脚本把下载的 msi、安装包、node_modules 副本、性能采集日志直接落在这里且从不回收，盘点时 1991 个顶层条目、约 100 万文件、30.9 GB；其中 `.tmp/builtin-mcp-tools/node_modules` 单目录 13.9 万文件 / 2.6 GB。
3. `release/` 每次出包留一份 exe + blockmap + `win-unpacked`，无版本保留策略，7 个版本占 2.0 GB。

三者都在 `.gitignore` 里，所以 `git status` 永远看不见，只能靠主动盘点发现。

## 手动清理的保留策略

| 来源 | 策略 | 默认 |
|---|---|---|
| `.tmp/<顶层条目>` | 按最后修改时间淘汰 | 超过 14 天 |
| `test-results/run-*` | 保留最近 N 次。超过此数量且超过 TTL 的目录可移入隔离区 | 20 次，14 天 |
| `release/*-Setup.exe`、`.dmg`、`.AppImage`、`.deb`、`.rpm` | 按时间排序保留最近 N 个版本，连带同名 `.blockmap` | 2 个版本 |

另外三条硬保护：

- **白名单**：`.tmp/desktop-driver`（`electron-builder.yml:51` 构建期读 `.tmp/desktop-driver/${os}-${arch}/contents`，删了 `build:win` 直接缺文件）、`.tmp/i18n-mt-model`、`.tmp/hermes-mcp-venv`（重建成本高）、`.tmp/ui-captures`（`docs/features/`、`docs/plans/` 几十处把它当验收证据路径）。
- **活跃保护**：60 分钟内有写入的条目跳过，避免撞上正在跑的编译/测试。
- **路径保护**：候选只能是上述三个来源的顶层条目，不跟随符号链接，不触碰源码、`output/`、`out/`、`.codegraph/`、`node_modules/`、`refs/`、`sites/`、`.metaAgent/`、`.workbuddy/`、`.muster/`。

`output/`（视觉自测截图）与 `.tmp/ui-captures/` 不自动清：删了会让 `docs/audits/`、`docs/features/` 里的证据链接失效，属于需要人判断的事。`out/` 是 `package.json` 的 `main` 指向的运行时构建产物，今天可能正在用，也不自动清。

## 用法

```bash
npm run clean:tmp                       # dry-run：列出候选条目，不做任何改动
npm run clean:tmp -- --measure          # dry-run + 精确体积（历史大树上很慢）
npm run clean:tmp -- --apply            # 移到隔离区（可恢复，默认测量体积）
npm run clean:tmp -- --apply --no-measure --older-than 7 --keep-runs 10
node scripts/clean-tmp.mjs --apply --trash <自定义同盘目录>
```

参数：`--older-than <天>`（默认 14）、`--keep-runs <次>`（默认 20）、`--keep-releases <个>`（默认 2）、`--trash <路径>`（默认 `<仓库>/../_metaagent-cleanup-trash/<日期>`）、`--apply`（默认 dry-run）、`--measure`（dry-run 也递归测体积）、`--no-measure`（`--apply` 时跳过测量，适合大批量快速搬运）。

`--apply` 按每批 10 个条目执行并逐批验证，生成 `<隔离区>/cleanup-<时间戳>.json`，记录每个条目的原路径、大小、目标位置与状态；失败项会打印并让进程以非零码退出，不静默跳过。

## 恢复与彻底释放

恢复：把 `隔离区/<rel>` 重命名回 `仓库根/<rel>`，清单里的 `items[].rel` / `items[].dest` 可直接用来批量反向操作。彻底释放空间由人在确认后手动删除隔离区目录——脚本不做永久删除。

## 关键文件

- `scripts/clean-tmp.mjs` — 策略、白名单、dry-run / apply、清单生成
- `package.json` — `clean:tmp` 入口
- `playwright.config.ts` 和 `test/helpers/e2e-artifacts.ts` 管理每次运行的输出目录和成功退出后的清理。
- `.gitignore` — `out/`、`release/`、`test-results/`、`output/`、`.tmp/`、`.codegraph/` 等忽略规则
- `docs/features/testing.md` — 测试产物与三层测试约定

## 已知边界

- 只做「按时间/保留数淘汰 + 可恢复移动」，不做内容识别。白名单靠人工维护，新增长期驻留的 `.tmp` 子目录要同步加进 `TMP_KEEP`。
- dry-run 的体积一栏默认为 `?`；这是刻意的性能取舍，不是统计失败。`--measure` 会在大树上有明显耗时，别挂到高频调度里。
- 隔离区在仓库外同盘，靠 `rename` 保证瞬时且可恢复；若 `--trash` 指向跨卷路径，`renameSync` 会失败并如实报错，不会退化成复制或强删。
- 不自动挂定时任务。要「及时」清理，需外部调度（系统计划任务 / CI / 自动化）周期性跑 `npm run clean:tmp -- --apply`，并定期清空隔离区。
- 跨平台：全部使用 Node `fs` API 与 `path`，无平台专有命令，Windows / macOS / Linux 逻辑一致；Linux 无桌面依赖。**代码验证（Windows 真机）**：默认 dry-run 在 2654 个候选上 2.2 秒完成、白名单 4 项全部生效，`--apply` 分支用 0 候选冒烟通过，等价的批量移动逻辑由一次性脚本在同一批数据上实跑 180 项 / 10854 MB、0 失败。**macOS / Linux 未真机验证**，不能把 Windows 结果当跨平台验收。

## 历史记录

2026-11-09 首次盘点并手工清理：180 个条目 / 10854 MB 移入 `E:/Projects/_metaagent-cleanup-trash/2026-11-09/`（含 5 个 `.tmp` 大目录、6 个旧安装包 + blockmap、`release/win-unpacked`、`.codegraph`、161 个旧 E2E run 批次），白名单与未提交改动全部保留。
