import React, { useEffect, useMemo, useState } from 'react';
import type { WorkspaceFileRef } from '../../../shared/types';
import { buildWorkspaceResourceUrl } from '../../../shared/mediaKinds';
import { injectPanelRelay } from '../../../shared/panelRelay';
import { isWebGateway } from '../webGatewayEnvironment';

export function htmlWithResourceBase(content: string, baseUrl?: string): string {
  if (!baseUrl) return injectPanelRelay(content);
  const document = new DOMParser().parseFromString(content, 'text/html');
  const base = document.querySelector('base[href]') ?? document.createElement('base');
  base.setAttribute('href', new URL(base.getAttribute('href') || '.', baseUrl).href);
  document.head.prepend(base);
  return injectPanelRelay(`<!doctype html>${document.documentElement.outerHTML}`);
}

/** 桌面允许脚本，手机显式禁用；不放开同源，Web 仅传源根只读预览能力。 */
export function HtmlFilePreview({ content, fileRef, rootsRevision, label, allowScripts = true, className = 'file-editor-preview file-editor-preview-html' }: {
  content: string; fileRef?: WorkspaceFileRef; rootsRevision: number; label: string; allowScripts?: boolean; className?: string;
}): React.JSX.Element {
  const scope = JSON.stringify([fileRef, rootsRevision]);
  const [webBase, setWebBase] = useState<{ scope: string; url?: string; error?: string }>();
  useEffect(() => {
    if (!isWebGateway() || !fileRef) return;
    let alive = true;
    let token: string | undefined;
    const release = (value: string): void => { void window.api.fs.releasePreview(value).catch(err => console.warn('[html-preview] release failed', err)); };
    void window.api.fs.createPreview(fileRef).then(result => {
      token = result.token;
      if (!alive) { if (token) release(token); return; }
      setWebBase({ scope, ...(result.ok && result.path ? { url: new URL(result.path, location.href).href } : { error: result.error ?? 'preview unavailable' }) });
    }).catch(err => { if (alive) setWebBase({ scope, error: err instanceof Error ? err.message : String(err) }); });
    return () => { alive = false; if (token) release(token); };
  }, [scope]);
  const base = isWebGateway() ? webBase?.scope === scope ? webBase.url : undefined : fileRef ? buildWorkspaceResourceUrl(fileRef) : undefined;
  const html = useMemo(() => htmlWithResourceBase(content, base), [content, base]);
  if (isWebGateway() && fileRef && !base) return <div role="status">{webBase?.scope === scope ? webBase.error : label}</div>;
  return <iframe className={className} aria-label={label} sandbox={allowScripts ? 'allow-scripts' : ''} srcDoc={html} />;
}
