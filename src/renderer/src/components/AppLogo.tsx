import React from 'react';
import { useTranslation } from 'react-i18next';
import { PRODUCT_NAME_ZH } from '../../../shared/productIdentity';

/**
 * 应用品牌图标（环轨）：核心 + 三颗并行 agent 卫星，薄荷色一颗 = 活跃。
 * 底板固定品牌黑 #101010；卫星点色跟随主题 --green（默认即品牌薄荷绿）。
 */
export function AppLogo({ size = 18 }: { size?: number }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <svg
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      role="img"
      aria-label={t(PRODUCT_NAME_ZH)}
      style={{ display: 'block' }}
    >
      <rect x="32" y="32" width="960" height="960" rx="216" fill="#101010" />
      <circle
        cx="512"
        cy="512"
        r="296"
        fill="none"
        stroke="#E4E4E4"
        strokeOpacity="0.4"
        strokeWidth="46"
      />
      <circle cx="512" cy="512" r="120" fill="#E4E4E4" />
      <circle cx="682" cy="270" r="80" fill="var(--green, #45d0a0)" />
      <circle cx="221" cy="563" r="80" fill="#E4E4E4" />
      <circle cx="584" cy="799" r="80" fill="#E4E4E4" />
    </svg>
  );
}
