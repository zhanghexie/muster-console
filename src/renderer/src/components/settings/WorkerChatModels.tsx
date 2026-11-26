import React, { useState } from 'react';
import type { AppConfig, AgentRuntimeEntry } from '../../../../shared/types';
import { HarnessModelSelectionPanel, type HarnessSettingsModel } from './HarnessModelSelectionPanel';
import { ModelParametersPanel } from './ModelParametersPanel';

/** Filtering and parameter scopes share the same engine catalog, including the ACP preset identity. */
export function WorkerChatModels({ cfg, set, runtime, agentId, active }: { cfg: AppConfig; set: (patch: Partial<AppConfig>) => void;
  runtime: AgentRuntimeEntry; agentId?: string; active: boolean }): React.JSX.Element {
  const [models, setModels] = useState<HarnessSettingsModel[]>([]);
  return <div className="worker-chat-models">
    <HarnessModelSelectionPanel cfg={cfg} runtimeId={runtime.id} agentId={agentId} active={active} compact onCatalogChange={setModels}/>
    <ModelParametersPanel cfg={cfg} set={set} runtimes={[runtime]} focused={{ runtimeId: runtime.id, agentId, models }}/>
  </div>;
}
