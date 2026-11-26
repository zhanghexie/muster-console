import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PermissionGateOptions,
  PermissionPreview,
  PermissionScope
} from '../../../shared/permissionOption';
import {
  FILE_PATHS_MAX,
  FREE_TEXT_MAX,
  PERMISSION_SCOPES
} from '../../../shared/permissionOption';

function previewTitle(p: PermissionPreview, t: (k: string) => string): string {
  if (p.scope === 'file') return t('文件变更');
  if (p.scope === 'command') return t('命令');
  return t('说明');
}

function scopeLabel(scope: PermissionScope, t: (k: string) => string): string {
  if (scope === 'project') return t('本项目');
  if (scope === 'session') return t('本会话');
  return t('全局');
}

/** 结构化预览：command | file（路径≤6 + add/update）| generic */
function PermissionPreviewBlock({ preview }: { preview: PermissionPreview }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="perm-preview" data-testid="permission-preview" data-preview-scope={preview.scope}>
      <p className="perm-preview-title">{previewTitle(preview, t)}</p>
      {preview.scope === 'command' && preview.command ? (
        <pre className="confirm-summary perm-preview-command">{preview.command}</pre>
      ) : null}
      {preview.scope === 'file' ? (
        <ul className="perm-preview-files">
          {(preview.filePaths ?? []).slice(0, FILE_PATHS_MAX).map((p) => (
            <li key={p} className="perm-preview-file">
              <span className="perm-preview-path">{p}</span>
              <span
                className={`perm-preview-change perm-change-${preview.fileChange ?? 'update'}`}
                data-testid="permission-file-change"
              >
                {preview.fileChange === 'add' ? t('新增') : t('更新')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {preview.scope === 'generic' && preview.label ? (
        <p className="perm-preview-label">{preview.label}</p>
      ) : null}
    </div>
  );
}

/**
 * 权限选项门内容：结构化预览 + always 作用域 + freeText 回灌输入。
 * 四态按钮在 ConfirmDialog 的 modal-actions（本组件只管预览/作用域/自由文本）。
 */
export function PermissionOptionBody({
  options,
  freeText,
  onFreeTextChange,
  scope,
  onScopeChange
}: {
  options: PermissionGateOptions;
  freeText: string;
  onFreeTextChange: (v: string) => void;
  scope: PermissionScope;
  onScopeChange: (s: PermissionScope) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const kinds = options.kinds ?? ['allowOnce', 'allowAlways', 'deny', 'custom'];
  const scopes = (options.scopes ?? ['project', 'session']).filter((s) =>
    PERMISSION_SCOPES.includes(s)
  );
  return (
    <>
      {options.preview ? <PermissionPreviewBlock preview={options.preview} /> : null}
      {kinds.includes('allowAlways') ? (
        <div className="perm-scope" data-testid="permission-scope">
          <span className="perm-scope-label">{t('总是允许作用域')}</span>
          {scopes.map((s) => (
            <button
              key={s}
              type="button"
              className={`btn perm-scope-btn${s === scope ? ' perm-scope-on' : ''}`}
              data-testid={`permission-scope-${s}`}
              aria-pressed={s === scope}
              onClick={() => onScopeChange(s)}
            >
              {scopeLabel(s, t)}
            </button>
          ))}
        </div>
      ) : null}
      <label className="perm-freetext">
        <span className="perm-freetext-label">{t('补充说明（可选）')}</span>
        <textarea
          className="perm-freetext-input"
          data-testid="permission-freetext"
          maxLength={FREE_TEXT_MAX}
          rows={3}
          value={freeText}
          placeholder={t('自定义说明：告诉 Agent 该怎么改（随应答回灌）')}
          onChange={(e) => onFreeTextChange(e.target.value.slice(0, FREE_TEXT_MAX))}
        />
      </label>
    </>
  );
}

/** 请求切换时把 freeText 回灌进输入框（草稿/上次输入预填） */
export function useFreeTextFill(
  requestId: string | undefined,
  initial: string | undefined
): [string, (v: string) => void] {
  const [freeText, setFreeText] = useState(initial ?? '');
  useEffect(() => {
    setFreeText(initial ?? '');
  }, [requestId, initial]);
  return [freeText, setFreeText];
}
