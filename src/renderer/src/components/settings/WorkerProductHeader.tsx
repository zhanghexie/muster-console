import { SettingsResourceStatus } from './SettingsResource';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkerProduct } from './workerCatalog';
import { HarnessIcon } from '../HarnessIcon';
import { SettingsDetailHeader } from './SettingsDetailHeader';
import { preflightBadgeOf } from '../../../../shared/runtimePreflight';

export function productStatus(product: WorkerProduct): { text: string; cls: string } {
  if (!product.runtime && !product.terminal) return { text: '未注册', cls: '' };
  if (!product.enabled && (product.mine || product.check?.status === 'available')) return { text: '已停用', cls: '' };
  if (product.check?.status === 'available') return { text: '已发现', cls: 'on' };
  if (product.check) { const badge = preflightBadgeOf(product.check); return { text: badge.label, cls: badge.cls }; }
  return { text: '待检测', cls: '' };
}

export function WorkerProductHeader({ product }: { product: WorkerProduct }): React.JSX.Element {
  const { t } = useTranslation();
  const status = productStatus(product);
  return <SettingsDetailHeader title={product.name}
    icon={<HarnessIcon harnessId={product.entry?.id ?? product.key} size={28}/>}
    meta={<span className="worker-product-status" title={product.check?.status === 'available' ? t('程序或配置已找到') : undefined}><SettingsResourceStatus state={status.cls === 'on' ? 'success' : status.cls === 'warn' ? 'warning' : 'neutral'}>{t(status.text)}</SettingsResourceStatus></span>}
    description={<>{product.group === 'builtin' ? t('工作台内置 · 基于 Pi 构建') : product.runtime && product.terminal ? t('工作台聊天与原生终端分别设置') : t(product.runtime ? '在工作台内使用此引擎' : '在原生终端中使用此引擎')}
      {product.entry?.id === 'zcode' && <><br/>{t('当前使用 ZCode 兼容协议；原生 MCP 配置不会自动合并，请在工作台登记第三方 MCP。每轮会重新启动引擎。')}</>}
    </>}/>;
}
