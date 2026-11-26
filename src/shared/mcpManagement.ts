import type { McpServerConfig } from './types';

export type McpManagementScope = 'global' | 'project';

export interface ManagedMcpEntry {
  id: string;
  scope: McpManagementScope;
  workspaceId?: string;
  /** Credentials are masked. Revision is an opaque token, not a credential hash. */
  server: McpServerConfig;
  revision: string;
  inherited?: boolean;
  overridden?: boolean;
  test?: McpConnectionTestResult;
}

export interface McpManagementInventory {
  enabled: boolean;
  workspaceId?: string;
  servers: ManagedMcpEntry[];
}

export interface McpSaveInput {
  id?: string;
  scope: McpManagementScope;
  workspaceId?: string;
  server: McpServerConfig;
  expectedRevision?: string;
}

export interface McpRemoveInput { id: string; expectedRevision: string; }
export interface McpImportInput {
  scope: McpManagementScope;
  workspaceId?: string;
  json: string;
  /** Required when replacing names already present; otherwise import is additive. */
  expectedRevisions?: Record<string, string>;
}

export interface McpConnectionTestResult {
  ok: boolean;
  /** relay-disabled：MCP 总开关（mcp.enabled）关闭，中转不可用，握手未执行 */
  status: 'connected' | 'auth-required' | 'timeout' | 'command-missing' | 'invalid' | 'connection-error' | 'relay-disabled';
  tools: Array<{ name: string; description: string }>;
  message: string;
  /** 清理（终止诊断子进程）失败的附加警告：不替换/中断诊断结论本身（mcp-settings F-01） */
  cleanupError?: string;
  checkedAt: string;
  durationMs: number;
}

export interface McpManagementApi {
  list(workspaceId?: string): Promise<McpManagementInventory>;
  get(id: string): Promise<ManagedMcpEntry>;
  save(input: McpSaveInput): Promise<ManagedMcpEntry>;
  remove(input: McpRemoveInput): Promise<void>;
  importJson(input: McpImportInput): Promise<ManagedMcpEntry[]>;
  test(id: string): Promise<McpConnectionTestResult>;
}
