import React from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkerRouteReason, WorkerRouteState } from '../../../shared/workerRouting';
import { AnimatedDetails } from '../components/AnimatedDetails';
import { workerTargetLabel } from '../components/workerRouting/workerTargetLabel';

export function BoardWorkerRouting({ routing }: { routing: WorkerRouteState }): React.JSX.Element {
  const { t } = useTranslation();
  const reasonLabels: Record<WorkerRouteReason, string> = {
    quota: t('额度耗尽'),
    'rate-limit': t('引擎限流'),
    'engine-unavailable': t('引擎不可用'),
    authentication: t('认证失败'),
    'temporary-service': t('引擎服务暂时异常'),
    'invalid-choice': t('配置失效'),
    'delivery-unknown': t('交付状态不确定'),
    'source-changed': t('源文件夹已变更')
  };
  const attemptLabels = {
    starting: t('正在启动'), running: t('运行中'), idle: t('空闲'), switching: t('正在切换候选'),
    blocked: t('已阻塞'), completed: t('已完成'), cancelled: t('已取消'), failed: t('失败')
  };
  const current = routing.attempts.at(-1);
  const reason = routing.reason ?? [...routing.attempts].reverse().find(attempt => !!attempt.reason)?.reason;
  const target = current ? workerTargetLabel(current.config, t('跟随引擎默认')) : '';
  const requested = 'tierId' in routing.plan.requested
    ? routing.plan.requestedTierName ? t('指定档位 {{name}}', { name: routing.plan.requestedTierName }) : t('指定档位')
    : t('指定模型配置');
  const reasonLabel = reason && (routing.attempts.length > 1 && routing.phase !== 'blocked'
    ? t('已切换候选（{{reason}}）', { reason: reasonLabels[reason] }) : reasonLabels[reason]);
  const summary = [target || requested, attemptLabels[routing.phase], reasonLabel].filter(Boolean).join(' · ');
  return <div className="board-worker-routing" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onPointerDown={event => event.stopPropagation()}>
    <AnimatedDetails summary={<span title={summary}>{summary}</span>}>
      <div className="board-worker-attempts">
        <p>{requested}</p>
        <ol>
          {routing.attempts.map(attempt => {
            const native = attempt.nativeConfirmed;
            const confirmed = [native?.providerId, native?.modelId, ...Object.values(native?.modelParameters ?? {})].filter(Boolean).join(' · ');
            return <li key={attempt.attempt}>
              <div>{t('第 {{number}} 次尝试', { number: attempt.attempt })} · {attemptLabels[attempt.state]}
                {attempt.reason ? ` · ${reasonLabels[attempt.reason]}` : ''}</div>
              <div>{t('宿主所选')} {attempt.tierName ? `${attempt.tierName} · ` : ''}{workerTargetLabel(attempt.config, t('跟随引擎默认'))}</div>
              <div>{confirmed ? t('引擎已确认 {{identity}}', { identity: confirmed }) : t('引擎尚未确认模型或参数')}</div>
            </li>;
          })}
        </ol>
      </div>
    </AnimatedDetails>
  </div>;
}
