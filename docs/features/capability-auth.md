# 共享任务授权（已删除）

原 collab-tasks 是授权框架的唯一 scope。随共享任务系统删除，sessions.requestCapability、授予/回收 IPC、会话菜单、角标、grantedScopes 的活动消费者及按授权态注入的任务表教学一并退出，不保留空框架。

工具权限、用户审批、可信会话令牌和事件审核继续由原边界执行。events.review 仍不对 Worker 开放；message({interrupt:true}) 只允许可信直接父对子。按需发现不会扩大权限，见 [工具发现](tool-discovery.md)。
