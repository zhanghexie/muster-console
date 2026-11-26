# 运行监视器

## 职责

运行监视器是桌面端的只读进程诊断入口，用于在多个 AI 会话和后台任务同时运行时快速定位 Electron 进程。面板从顶栏入口或 `Ctrl+Shift+R` 打开，采用与全局看板相同的主题表面和飞入飞出节拍。内容面板使用 `mp-panel-fly`，保持实底滑过顶缘，独立的全窗磨砂遮罩在其后淡入淡出。Vibrancy 窗口在遮罩在场期间把滤镜采样限制在应用内容内，以同步淡出的衬底保持透明侧栏上的模糊效果。收起即释放命中，退场中重开会沿当前位移返回。动效合同见 [动画系统](animation-system.md)，材质行为见 [窗口背景](frame-backdrop.md)。

当前版本提供轻量实时采样：主进程以 Electron `app.getAppMetrics()` 为展示范围，并把 `process/owner.ts` 登记的受管外部进程补进来；Windows CIM 或 macOS/Linux `ps` 只用于补父 PID、外部进程工作集和 CPU 信息，不把整台机器的无关进程铺进面板。内存中只保留最近 45 次采样，达到上限后覆盖旧记录，不写入持久化存储。

## 关键文件与数据流

| 文件 | 职责 |
|---|---|
| `src/main/processMonitor.ts` | 采集 Electron/Chromium 与受管外部进程、父 PID 和 WebContents 标识，维护有界轻量历史，注册自动采样、CPU profile 和堆快照 IPC |
| `src/shared/processMonitor.ts` | 主进程、预加载和渲染层共用的快照与进程树类型 |
| `src/preload/index.ts` | 暴露 `snapshot()`、CPU 开始/停止采集、`heapSnapshot()` 与诊断文件定位 |
| `src/renderer/src/panels/ProcessMonitorPanel.tsx` | 悬浮面板、进程树、详情区和 2 秒轮询 |
| `src/renderer/src/styles/process-monitor.css` | 看板同源 surface、悬浮定位、父子树和窄布局 |
| `src/renderer/src/components/ChromeBar.tsx` | 顶栏运行监视器图标入口与快捷键提示 |
| `src/shared/keybindings.ts` | `processMonitor.toggle`，默认 `Ctrl+Shift+R`，可在设置中改绑 |

自动采集只在面板打开时轮询，系统进程表有 3 秒缓存，采样调用集中在主进程 IPC。选中可附加的 Electron 进程后，可以点击开始 CPU 采集，再次点击停止，最长 10 分钟并显示倒计时；堆快照仍是一次性手动操作。CPU profile/堆快照写入用户数据目录，并限制为最近 8 个文件且总大小不超过 128 MiB，结果可直接定位到资源管理器。父 PID 查询按平台实现：Windows 使用 CIM 进程表，macOS/Linux 使用 `ps`；读取失败时仍返回 Electron 指标，并把无法建立的关系显示为根节点。

## 交互与边界

- 顶栏按钮和快捷键互斥打开运行监视器与全局看板；关闭按钮已移除，点击面板外的磨砂空白或按 `Esc` 关闭当前悬浮层。
- 点击进程行查看 PID、类型、CPU、工作集、父 PID、URL 或服务名。
- 进程列表采用一行一个进程的紧凑布局；详情区显示选中进程的 CPU 历史条形图。
- PID、工作区和会话在列表中各占独立列，优先直接显示会话名，避免业务上下文挤在进程名称后面；没有名称时回退到会话 ID。
- 受管 AI/扩展进程带有业务角色，并显示工作区、会话和任务 ID/名称；Electron 内置进程按页面标题、服务类型映射为可读名称。
- 指标是采样窗口平均值，不等同于瞬时 CPU；PID 与创建时间组成稳定进程键，避免 PID 复用误认。
- CPU profile 和堆快照只支持当前 Electron 主进程及可附加的 Chromium `WebContents`；普通 OS 外部进程仍只能显示系统指标，不能被 Electron 直接注入 V8/DevTools 采集。
- `process/owner.ts` 的受管外部 CLI 根进程会以 External 节点加入 Electron 进程树，并携带 owner 登记时的 workspace/session/task 归属。

