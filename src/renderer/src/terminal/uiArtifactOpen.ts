/**
 * ma-ui 部件链接「在网页区打开」（智能界面 M4 CLI 呈现层）：
 * 划词浮条菜单 / 「爆炸」浮层 / 终端胶囊识屏三处共用——
 * 命中判定（extractUiArtifactLinks，识别核心在 shared/uiArtifactLink）与
 * 打开动作（muster-ext 只读 URL 经 browser.open 进右侧网页区 tab）都收在这里，
 * 三处菜单共用同一判定与动作，避免各自维护漂移。
 */
import { t } from '../../../shared/i18n';
import {
  extractUiArtifactLinks,
  matchUiArtifactLink,
  type UiArtifactLinkMatch
} from '../../../shared/uiArtifactLink';
import { buildExternalFileUrl } from '../../../shared/filePreview';
import type { ChatLinkOwner } from '../chatSurface/chatLinkOwner';

/** 一次打开的部件数上限：超出只开前 N 个并 toast 提示截断 */
export const MAX_UI_ARTIFACT_OPEN = 3;

/** 划词/拼回文本里的部件链接清单（≥1 条时菜单出「在网页区打开」） */
export function uiArtifactLinksInText(text: string): UiArtifactLinkMatch[] {
  return extractUiArtifactLinks(text);
}

/**
 * 扫描命中（单实体）：实体文本优先；文本没配齐（回填/截断形态）时用
 * absPath（扫描阶段 stat 已确认存在）兜底——两处任一命中即出动作。
 * 普通路径（非 agent-sessions/<sid>/ui/*.inline|browser.html）返回空。
 */
export function uiArtifactLinksInScanHit(hit: {
  text: string;
  absPath?: string;
}): UiArtifactLinkMatch[] {
  const fromText = extractUiArtifactLinks(hit.text);
  if (fromText.length > 0 || !hit.absPath) return fromText;
  const m = matchUiArtifactLink(hit.absPath);
  return m ? [m] : [];
}

/**
 * 逐条在右侧网页区打开：browser.open({ url: muster-ext://f/<encoded path> })。
 * 超过上限只开前 MAX_UI_ARTIFACT_OPEN 条并 toast 截断；单条失败不中断其余，
 * 结束后 toast 提示（对齐 openSelectionUrl 的 tip 通道）。
 */
export async function openUiArtifactsInBrowser(
  links: UiArtifactLinkMatch[],
  tip: (s: string) => void,
  owner?: ChatLinkOwner
): Promise<void> {
  if (links.length === 0) return;
  const truncated = links.length > MAX_UI_ARTIFACT_OPEN;
  const targets = truncated ? links.slice(0, MAX_UI_ARTIFACT_OPEN) : links;
  let failed = 0;
  for (const link of targets) {
    try {
      await window.api.browser.open({ url: buildExternalFileUrl(link.path), ...owner });
    } catch {
      failed += 1;
    }
  }
  if (truncated) tip(t('部件较多，仅打开前 {{n}} 个', { n: String(MAX_UI_ARTIFACT_OPEN) }));
  if (failed > 0) tip(t('在网页区打开失败'));
}
