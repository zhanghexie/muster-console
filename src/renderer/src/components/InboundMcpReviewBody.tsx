import React from 'react';
import { useTranslation } from 'react-i18next';
import type { InboundMcpReview } from '../../../shared/inboundMcp';

/** CLI 入站 MCP 写引擎配置的 TOFU 审查（确认门与设置页预览共用） */
export function InboundMcpReviewBody({ review }: { review: InboundMcpReview }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="inbound-mcp-review" data-testid="inbound-mcp-review">
      <p className="settings-hint">
        {t('将把 Muster 宿主工具（Worker 白名单）注册为各 CLI 的 stdio MCP server。确认后才会改本机引擎配置文件。')}
      </p>
      <p>
        <code>
          {review.command} {review.args.join(' ')}
        </code>
      </p>
      <ul>
        {review.files.map((f) => (
          <li key={f.path}>
            {f.label}（{f.action === 'create' ? t('新建') : t('改写已有文件')}）
            <br />
            <code>{f.path}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
