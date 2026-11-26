/**
 * GUI Worker 代码执行工具：node_repl.js（每会话持久 NodeReplSession）。
 * 真正执行在 main/nodeRepl/；这里只做参数校验与结果文案。
 * 权限类 'shell'：完整 Node 权限（可 require/读写文件/起进程），与 Bash 同审批语义。
 * label/description 用用户语言（shared/nodeRepl.ts 单源），禁 js/node_repl 实现术语进 title。
 */
import type { AppContext } from '../../context';
import type { GuiHostTool, GuiToolExecContext } from '../types';
import { NodeReplManager } from '../../nodeRepl/manager';
import {
  NODE_REPL_TOOL_ARGS_HINT,
  NODE_REPL_TOOL_DESCRIPTION,
  NODE_REPL_TOOL_ID,
  NODE_REPL_TOOL_LABEL,
  resolveNodeReplTimeoutMs
} from '../../../shared/nodeRepl';

export { NODE_REPL_TOOL_ID };

/** 主进程单例注册表（会话以 sessionId 键入；生命周期随进程） */
const nodeReplManager = new NodeReplManager();

export function getNodeReplManager(): NodeReplManager {
  return nodeReplManager;
}

/** 会话关闭（lifecycle.closeSession）/应用退出（before-quit）时释放全部执行内核 */
export function disposeNodeReplSession(sessionId: string): Promise<void> {
  return nodeReplManager.dispose(sessionId);
}

export function disposeAllNodeRepl(): Promise<void> {
  return nodeReplManager.disposeAll();
}

export function buildNodeReplTools(ctx: AppContext): GuiHostTool[] {
  void ctx;
  return [
    {
      id: NODE_REPL_TOOL_ID,
      label: NODE_REPL_TOOL_LABEL,
      description: NODE_REPL_TOOL_DESCRIPTION,
      argsHint: NODE_REPL_TOOL_ARGS_HINT,
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: '要执行的 JavaScript 源码。同一会话内多次调用共享全局状态（globalThis / var / function 声明保留）。'
          },
          timeoutMs: {
            type: 'number',
            description:
              '本次执行超时毫秒（缺省 60000，上限 120000）。超时会重建执行上下文并清除全部既有绑定——结果会明示「上下文已重建」，此时须重新初始化状态再继续。'
          }
        },
        required: ['code']
      },
      permissionClass: 'shell',
      async execute(args, exec: GuiToolExecContext) {
        const code = String(args.code ?? '');
        if (!code.trim()) throw new Error('失败：code 不能为空');
        const timeoutMs = resolveNodeReplTimeoutMs(args.timeoutMs);
        const mgr = getNodeReplManager();
        const session = mgr.getOrCreate(exec.sessionId);
        const result = await session.run(code, { timeoutMs, signal: exec.signal });
        // header 两支输出原本相同（ok 与 kernelReset:false 同串，F-03 化简）：
        // 非成功且 kernel 被重置时才追加「上下文已重建」提示。
        const header =
          result.status === 'ok' || !result.kernelReset
            ? `（generation ${result.generation}）`
            : `（generation ${result.generation}，上下文已重建）`;
        // 求值为空字符串（hasValue 有值但正文为空）与 undefined 区分展示，
        // 不再让模型把 '' 误读成 undefined（node-repl F-01）。
        const body =
          result.status === 'ok' && result.hasValue !== false && result.text.length === 0
            ? '（空字符串）'
            : result.text;
        if (result.status !== 'ok') throw new Error(`${header}\n${body}`);
        return `${header}\n${body}`;
      }
    }
  ];
}
