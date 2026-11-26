import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeConfigIntent } from '../../../../shared/nativeSessionConfig';
import type { WorkerRoutingMember, WorkerRoutingScope } from '../../../../shared/workerRouting';
import { WORKER_CODEX_PERMISSION_PROFILES } from '../../../../shared/workerRouting';
import { AnimatedDetails } from '../AnimatedDetails';
import { IconShield } from '../icons';
import { NativeConfigLaunchFields } from '../NativeSessionConfig';

const allowedValues = { permissions: WORKER_CODEX_PERMISSION_PROFILES };

export function WorkerRoutingCrossHarness({ member, scope, active, disabled, onChange }: {
  member: WorkerRoutingMember;
  scope: WorkerRoutingScope;
  active: boolean;
  disabled: boolean;
  onChange: (authorization: WorkerRoutingMember['crossHarness']) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<NativeConfigIntent>();
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const open = active && expanded;
  const authorization = member.crossHarness;
  const selection = editing ?? authorization?.nativeConfig;
  const label = t('允许运行中跨 Harness，使用此候选选定的原生权限');
  return <AnimatedDetails className="worker-routing-cross-harness" open={open} onToggle={setExpanded}
    summary={<><IconShield size={14} /><span>{t('跨 Harness 权限')}</span></>}>
    <div className="worker-routing-cross-harness-body" aria-hidden={!open || undefined} ref={node => { if (node) node.inert = !open; }}>
      {active ? <>
      <p className="settings-hint">{t('切换将使用此候选的原生权限，审批方式和文件访问范围可能与当前 Harness 不同。')}</p>
      <p className="settings-hint">{t('授权仅适用于当前工作区和所选源文件夹。')}</p>
      <NativeConfigLaunchFields permissionsOnly allowedValues={allowedValues} menuEnabled={open}
        target={{ runtimeId: member.config.runtimeId, presetId: member.config.acpPresetId, source: scope }}
        selection={selection} disabled={disabled} onSelectionReady={setReady} onChange={next => {
          if (disabled || !open) return;
          setEditing(next);
          if (authorization) onChange(undefined);
        }} />
      <label className="worker-routing-cross-harness-option">
        <input type="checkbox" checked={!!authorization} disabled={disabled || (!authorization && (!ready || !selection))}
          onChange={event => {
            if (!event.target.checked) {
              setEditing(selection);
              onChange(undefined);
            } else if (ready && selection) {
              setEditing(undefined);
              onChange({ nativeConfig: selection });
            }
          }} />
        <span>{label}</span>
      </label>
      {!ready && !authorization ? <p className="settings-hint">{t('逐项选择此候选的原生权限后即可授权。')}</p> : null}
      </> : null}
    </div>
  </AnimatedDetails>;
}
