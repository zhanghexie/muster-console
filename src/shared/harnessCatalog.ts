/** Product catalogue, separate from runtime installation and authentication state. */
export type HarnessTransport = 'builtin' | 'claude' | 'codex' | 'acp' | 'pi-rpc' | 'msp' | 'zcode';

export interface HarnessCatalogEntry {
  /** Stable product identity; it is not necessarily a runtime or executable name. */
  id: string;
  name: string;
  transport: HarnessTransport;
  runtimeId?: string;
  /** Existing optional terminal runtime; independent from the GUI process. */
  cliRuntimeId?: string;
  acpPresetId?: string;
  commands: readonly string[];
  args: readonly string[];
  acpFallback?: { commands: readonly string[]; args: readonly string[] };
  installUrl?: string;
  kind: 'engine';
  /** Whether the adapter is included, not whether an installation can run. */
  integration: 'builtin' | 'planned';
}

/**
 * Agent engine catalogue. Service plans belong to model configuration, not engine entries.
 * Discovery and authentication are intentionally not inferred from this list.
 */
export const HARNESS_CATALOG: readonly HarnessCatalogEntry[] = [
  { id: 'muster-core', name: 'Muster Core', transport: 'builtin', runtimeId: 'pi', commands: [], args: [], kind: 'engine', integration: 'builtin' },
  { id: 'claude', name: 'Claude Code', transport: 'claude', runtimeId: 'claude', cliRuntimeId: 'claude-code', commands: ['claude'], args: [], installUrl: 'https://code.claude.com/docs/en/setup', kind: 'engine', integration: 'builtin' },
  { id: 'codex', name: 'Codex', transport: 'codex', runtimeId: 'codex-gui', cliRuntimeId: 'codex', commands: ['codex'], args: [], installUrl: 'https://developers.openai.com/codex/cli/', kind: 'engine', integration: 'builtin' },
  { id: 'cursor', name: 'Cursor', transport: 'acp', runtimeId: 'acp', cliRuntimeId: 'cursor-cli', acpPresetId: 'cursor', commands: ['cursor-agent'], args: ['acp'], installUrl: 'https://cursor.com/docs/cli/installation', kind: 'engine', integration: 'builtin' },
  { id: 'opencode', name: 'OpenCode', transport: 'acp', runtimeId: 'acp', cliRuntimeId: 'opencode', acpPresetId: 'opencode', commands: ['opencode'], args: ['acp'], installUrl: 'https://opencode.ai/docs/', kind: 'engine', integration: 'builtin' },
  { id: 'gemini', name: 'Gemini CLI', transport: 'acp', runtimeId: 'acp', cliRuntimeId: 'gemini', acpPresetId: 'gemini', commands: ['gemini'], args: ['--acp'], installUrl: 'https://github.com/google-gemini/gemini-cli', kind: 'engine', integration: 'builtin' },
  { id: 'kimi', name: 'Kimi Code', transport: 'acp', cliRuntimeId: 'kimi-cli', runtimeId: 'acp', acpPresetId: 'kimi', commands: ['kimi'], args: ['acp'], installUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/', kind: 'engine', integration: 'builtin' },
  { id: 'antigravity', name: 'Antigravity', transport: 'acp', runtimeId: 'acp', acpPresetId: 'antigravity', commands: ['agy'], args: ['acp'],
    acpFallback: { commands: ['agy_acp_server', 'agy_acp_server.par'], args: [] }, installUrl: 'https://antigravity.google/docs/ide/extensions/acp/', kind: 'engine', integration: 'builtin' },
  { id: 'grok', name: 'Grok Build', transport: 'acp', cliRuntimeId: 'grok-cli', runtimeId: 'acp', acpPresetId: 'grok', commands: ['grok'], args: ['--no-auto-update', '--permission-mode', 'default', 'agent', 'stdio'], installUrl: 'https://docs.x.ai/build/overview', kind: 'engine', integration: 'builtin' },
  { id: 'deepseek', name: 'DeepSeek', transport: 'acp', runtimeId: 'acp', acpPresetId: 'deepseek', commands: ['dsh'], args: ['--profile', 'acp'], installUrl: 'https://www.npmjs.com/package/%40deepseek-ai/dsh', kind: 'engine', integration: 'builtin' },
  { id: 'commandcode', name: 'Command Code', transport: 'acp', cliRuntimeId: 'commandcode-cli', runtimeId: 'acp', acpPresetId: 'commandcode', commands: ['command-code'], args: ['acp'], installUrl: 'https://commandcode.ai/docs/acp', kind: 'engine', integration: 'builtin' },
  { id: 'cline', name: 'Cline', transport: 'acp', cliRuntimeId: 'cline-cli', runtimeId: 'acp', acpPresetId: 'cline', commands: ['cline'], args: ['--acp', '--auto-approve', 'false'], installUrl: 'https://docs.cline.bot/usage/cli-overview', kind: 'engine', integration: 'builtin' },
  { id: 'kilo', name: 'Kilo Code', transport: 'acp', cliRuntimeId: 'kilo-cli', runtimeId: 'acp', acpPresetId: 'kilo', commands: ['kilo'], args: ['acp'], installUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli', kind: 'engine', integration: 'builtin' },
  { id: 'github-copilot', name: 'GitHub Copilot CLI', transport: 'acp', cliRuntimeId: 'github-copilot-cli', runtimeId: 'acp', acpPresetId: 'github-copilot', commands: ['copilot'], args: ['--no-auto-update', '--acp', '--stdio'], installUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli', kind: 'engine', integration: 'builtin' },
  { id: 'devin', name: 'Devin CLI', transport: 'acp', cliRuntimeId: 'devin-cli', runtimeId: 'acp', acpPresetId: 'devin', commands: ['devin'], args: ['acp'], installUrl: 'https://docs.devin.ai/cli', kind: 'engine', integration: 'builtin' },
  { id: 'hermes', name: 'Hermes Agent', transport: 'acp', cliRuntimeId: 'hermes-cli', runtimeId: 'acp', acpPresetId: 'hermes', commands: ['hermes'], args: ['acp'], installUrl: 'https://hermes-agent.org/', kind: 'engine', integration: 'builtin' },
  { id: 'pi', name: 'Pi', transport: 'pi-rpc', cliRuntimeId: 'pi-external-cli', runtimeId: 'pi-external', commands: ['pi'], args: ['--mode', 'rpc'], installUrl: 'https://github.com/earendil-works/pi', kind: 'engine', integration: 'builtin' },
  { id: 'omp', name: 'Oh My Pi', transport: 'pi-rpc', cliRuntimeId: 'omp-cli', runtimeId: 'omp', commands: ['omp'], args: ['--mode', 'rpc'], installUrl: 'https://github.com/can1357/oh-my-pi', kind: 'engine', integration: 'builtin' },
  { id: 'muse', name: 'Muse Code', transport: 'msp', cliRuntimeId: 'muse-cli', runtimeId: 'muse-gui', commands: ['muse'], args: ['serve'], installUrl: 'https://dev.meta.ai/docs/muse-code', kind: 'engine', integration: 'builtin' },
  { id: 'zcode', name: 'ZCode', transport: 'zcode', cliRuntimeId: 'zcode-cli', runtimeId: 'zcode-gui', commands: ['zcode'], args: ['app-server'], installUrl: 'https://github.com/zai-org/ZCode', kind: 'engine', integration: 'builtin' },
  { id: 'mimo-code', name: 'MiMo Code', transport: 'acp', cliRuntimeId: 'mimo-code-cli', runtimeId: 'acp', acpPresetId: 'mimo-code', commands: ['mimo'], args: ['acp'], installUrl: 'https://github.com/XiaomiMiMo/MiMo-Code', kind: 'engine', integration: 'builtin' },
  { id: 'qwen-code', name: 'Qwen Code', transport: 'acp', cliRuntimeId: 'qwen-cli', runtimeId: 'acp', acpPresetId: 'qwen', commands: ['qwen'], args: ['--acp'], installUrl: 'https://github.com/QwenLM/qwen-code', kind: 'engine', integration: 'builtin' }
];

export function findHarnessCatalogEntry(id: string): HarnessCatalogEntry | undefined {
  return HARNESS_CATALOG.find(entry => entry.id === id);
}
