# 共享任务系统（已删除）

宿主工具精简已移除独立任务池、任务 CRUD/认领/依赖/优先级/任务路径锁/CAS、强制互验、任务执行历史/归档及退出对账。taskStore、agentTasks 和对应 IPC/看板挂接已删除，不提供轻量任务表替代。

创建和首次派活统一 sessions.create({task?,asSubagent?})；已有会话的补充指令用 sessions.message，进展用 sessions.observe。会话审阅、文件改动碰撞保护、worktree 所有权及合入审批仍独立存在。详见 [Worker 创建](worker-inject.md)、[会话邮箱](session-mailbox.md) 和 [工具发现](tool-discovery.md)。

workflow、automations、bgtasks、扩展后台任务和外部 CLI runs 有各自运行记录，不属于被删除的共享任务池。工作流恢复及 CLI 归属检查使用宿主保存到普通会话 meta.creationKey 的运行关联。用户旧 tasks.json/tasks-archive.json 不自动删除，也不继续装载或维护。
