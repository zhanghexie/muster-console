import React from 'react';
import { t } from '../../../shared/i18n';
import { PRODUCT_NAME_ZH } from '../../../shared/productIdentity';
import '../styles/brand-loading.css';

/** Monochrome orbit mark, used only while an operation is awaiting completion. */
export function BrandLoader({ size = 24 }: { size?: number }): React.JSX.Element {
  return <svg className="brand-loader" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
    <circle cx="512" cy="512" r="296" fill="none" stroke="currentColor" strokeOpacity=".28" strokeWidth="46" />
    <circle className="brand-loader-core" cx="512" cy="512" r="120" fill="currentColor" />
    <g className="brand-loader-orbit" fill="currentColor">
      <circle cx="682" cy="270" r="80" />
      <circle cx="221" cy="563" r="80" />
      <circle cx="584" cy="799" r="80" />
    </g>
  </svg>;
}

/** Inline label: one per operation/panel, never one per placeholder row. */
export function BrandLoading({ children, size = 20 }: { children?: React.ReactNode; size?: number }): React.JSX.Element {
  return <span className="brand-loading" role="status"><BrandLoader size={size} />{children}</span>;
}

export function BrandBootLoader(): React.JSX.Element {
  // F-01（brand-loading）：启动标记读屏文案走 t()（模块单例 i18n 同步可用，
  // 避开 react-i18next 初始化顺序）；index.html 静态期同 key 双语。
  return <div className="boot-skel" role="status" aria-label={t(`${PRODUCT_NAME_ZH} 正在启动`)}>
    <BrandLoader size={88} />
    <div className="brand-boot-name">{t(PRODUCT_NAME_ZH)}</div>
  </div>;
}
