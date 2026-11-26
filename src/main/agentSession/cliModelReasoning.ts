import { app } from 'electron';
import { claudeModelReasoningLevels, normalizeCliLaunchOptions, type CliLaunchOptions } from '../../shared/cliLaunchOptions';
import { codexModelReasoningLevels } from '../../shared/codexModels';
import type { RuntimeManifest } from '../../shared/runtimeManifest';
import { listCodexModels } from './drivers/codex/models';
import { listClaudeModels } from './drivers/claude/models';
import { listAcpModels } from './drivers/acp/models';

/** CLI launch validation uses the saved native catalog when it identifies this exact model. */
export async function validateCliModelReasoning(
  runtime: string, options: CliLaunchOptions | undefined, cwd: string, manifest?: RuntimeManifest
): Promise<void> {
  if (!options?.model || !options.reasoning) return;
  let levels: readonly string[] | undefined;
  if (runtime === 'codex') {
    const catalog = await listCodexModels(cwd);
    if (catalog.ok) levels = codexModelReasoningLevels(catalog.items, options.model);
  } else if (runtime === 'claude-code') {
    const catalog = await listClaudeModels({ cwd, userDataDir: app.getPath('userData'), isolateConfig: false });
    if (catalog.ok) levels = claudeModelReasoningLevels(catalog.items, options.model);
  } else if (runtime === 'kimi-cli') {
    const catalog = await listAcpModels({ cwd, userDataDir: app.getPath('userData'), agentId: 'kimi', modelId: options.model });
    if (!catalog.ok || catalog.parametersUnknown) throw new Error('Kimi model reasoning is unknown. Refresh the Kimi model catalog.');
    if (!catalog.reasoning?.options.some(option => option.value === options.reasoning)) throw new Error('Kimi does not advertise that reasoning value for the selected model.');
  }
  if (levels !== undefined) normalizeCliLaunchOptions(runtime, options, manifest, levels);
}
