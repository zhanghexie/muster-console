<!-- x-muster-readme: extensions -->

# MetaAgent 扩展创作

使用 host.extensions.run({ action, params }) 管理扩展草稿、审核和运行。宿主绑定当前工作区、项目、源码根和草稿所有者，扩展不能伪造这些身份。

## 当前扩展清单

扩展清单使用当前合同。全局包位于应用 profile 的 extensions/global/<id>，只保留一份源码；项目包位于当前项目的 .muster/extensions/<id>。

示例清单包含 id、name、version、scope、surface、domain、agent、data 和 permissions。sidebar 扩展必须声明 domain 和 agent。toolbar 扩展声明 commandEntry，不挂载 AI 侧边栏。

扩展面板通过 ../__sdk__/sdk.js 和 ../__sdk__/theme.css 接入宿主。

## 人和 AI 共用领域

domain.mjs 导出 createDomainRuntime()，提供 getSnapshot、query、execute、subscribe 和可选的 close。主界面和 Pi Agent 使用同一个实例，人的点击不会自动转成模型消息。Agent 在需要时通过 state.snapshot、query 工具读取当前状态，再通过声明的 command 改变状态。

DomainRuntime 和 toolbar command 在宿主拥有的独立进程中执行。代码使用可取消的异步操作，避免同步大 IO 和无限计算。宿主负责进程回收、版本检查、实例级串行化和危险命令确认。

## 草稿、审核和运行

依次调用 inspect、create、多次 write、submit。更新已有包时传入当前批准 fingerprint。list 查看启用状态、作用域、指纹和同步状态。run 执行已批准的 toolbar command，tools 和 invokeTool 管理动态工具。审核通过后才能运行。

面板底栏统一提供 AI 开关。关闭 AI 只释放 Pi 连接并保留历史，再次打开恢复同一会话。Skill、system prompt 和 MCP descriptor 由 manifest 声明并按扩展实例挂载。

## 可见终端和平台

清单可声明 host.terminal.create 和 host.terminal.write。前者创建绑定当前工作区和源根的普通 Shell，后者必须传同一工作区的 sessionId，写入成功只表示输入已送达。terminal.capture 不向扩展开放。

DomainRuntime 和 native 入口具有本机权限，worker 进程隔离不是操作系统沙箱。Windows、macOS、Linux 使用同一套扩展合同，平台差异由宿主适配层处理；平台能力缺失时必须明确报错。

参考 ~/.muster/skills/extensions/SKILL.md 和 ~/.muster/skills/dynamicTools/SKILL.md。
