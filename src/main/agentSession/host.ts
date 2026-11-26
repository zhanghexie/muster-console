/**
 * AgentSessionHost 入口垫片：实现按「生命周期 / 工具执行 / 事件泵」等
 * 关注点拆分在同目录 host/ 下（agentSessionHost.ts 为组装壳）。
 * 对外 import 路径保持本模块（src/main/index.ts、src/main/context.ts、test/*）。
 */
export { AgentSessionHost } from './host/agentSessionHost';
