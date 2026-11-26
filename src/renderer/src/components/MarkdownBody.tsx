import React, { isValidElement, memo } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import {
  WORKSPACE_FILE_LINK_SCHEME,
  parseWorkspaceFileHref
} from '../../../shared/linkifyWorkspacePaths';
import {
  remarkStripCjkEmphasisZwsp,
  softenCjkMarkdownEmphasis
} from '../../../shared/cjkMarkdownEmphasis';
import { guardInlineMathCurrency } from '../../../shared/markdownMathGuard';
import { isLocalhostHttpUrl } from '../../../shared/terminalSelectionText';
import { isMermaidFenceClass, mermaidSourceFromCodeChildren } from '../../../shared/mermaidFence';
import { matchUiArtifactLink } from '../../../shared/uiArtifactLink';
import { UiWidgetCard } from '../chatSurface/UiWidgetCard';
import { UiArtifactSuppressionContext } from '../chatSurface/UiArtifactContext';
import { remarkUiArtifacts } from '../../../shared/uiArtifactMarkdown';
import { MermaidBlock } from './MermaidBlock';
import { FileTypeIcon } from './FileTypeIcon';
import { IconCopy } from './icons';
import { ImageLightbox } from './ImageLightbox';
import { localMarkdownImageUrl } from '../chatSurface/localMarkdownImage';

interface Props {
  text: string;
  /** Untrusted mail: presentation only, no navigation, media, widgets or diagram execution. */
  displayOnly?: boolean;
  className?: string;
  /** 工作区文件链接（muster-file: 协议）点击回调；不传则按外链处理 */
  onFileLink?: (href: string) => void;
  /** Enable local image resolution for chat messages, relative to the session cwd. */
  localImages?: boolean;
  imageCwd?: string;
}

/** 插件与组件映射都提为模块常量：避免每次渲染新引用，让 memo 浅比较生效。
 *  remark-math 识别 $…$ / $$…$$（GFM 之后剥掉 CJK 强调预处理插入的 ZWSP，
 *  见 shared/cjkMarkdownEmphasis；公式内容存在 math 节点 value 里，不被 ZWSP 剥离触碰）。
 *  KaTeX 只输出 HTML span（默认 htmlAndMathml 双份 DOM，流式正文翻倍不划算）；
 *  strict 关 + 不抛错：小错/半截公式按源码红字呈现，不炸整条消息。 */
const REMARK_PLUGINS = [remarkMath, remarkGfm, remarkStripCjkEmphasisZwsp];

const REHYPE_PLUGINS: Parameters<typeof ReactMarkdown>[0]['rehypePlugins'] = [
  [rehypeKatex, { output: 'html', strict: false, throwOnError: false }]
];

/**
 * react-markdown 默认 urlTransform 只放行 http(s)/mailto 等白名单协议，
 * `muster-file:`、`file://`、`E:\...` 盘符路径都会被清成 href=""——
 * 渲染层拿到空 href 既进不了文件链接分支，target=_blank 又会把应用自身 URL
 * 丢给 shell 在浏览器打开（即「点了在网页打开还报错」的根因）。这里放行三类本地形态。
 */
const URL_TRANSFORM = (url: string): string => {
  // ma-ui 部件产物链接原样放行（ui.render 绝对路径，交 UiWidgetCard 渲染）
  if (matchUiArtifactLink(url)) return url;
  if (url.startsWith(WORKSPACE_FILE_LINK_SCHEME)) return url;
  if (/^file:\/\//i.test(url)) return url;
  if (/^[A-Za-z]:[\\/]/.test(url)) return url;
  return defaultUrlTransform(url);
};

function isHttpLink(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function isNonFileProtocol(href: string): boolean {
  return /^(mailto|tel|callto|sms):/i.test(href);
}

/** 从文件链接 href 取基名：带扩展名才返回（无扩展名的目标可能是目录/路由，不配图标） */
function fileBaseForIcon(href: string): string | null {
  let candidate: string | null = null;
  const meta = parseWorkspaceFileHref(href);
  if (meta) {
    candidate = meta.path;
  } else if (isLocalhostHttpUrl(href) || /^file:\/\//i.test(href)) {
    try {
      candidate = decodeURIComponent(new URL(href).pathname);
    } catch {
      candidate = null;
    }
  } else if (href && !isHttpLink(href) && !isNonFileProtocol(href)) {
    candidate = href;
  }
  if (!candidate) return null;
  const base = candidate.replace(/\\/g, '/').split('/').pop() ?? '';
  return /\.[A-Za-z0-9]{1,12}$/.test(base) ? base : null;
}

/** 文件链接统一渲染：类型图标 + 原标签，点击交 onFileLink（文件面板打开） */
function FileLink({
  href,
  onFileLink,
  children
}: {
  href: string;
  onFileLink: (href: string) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const base = fileBaseForIcon(href);
  const original = parseWorkspaceFileHref(href);
  let title = original
    ? `${original.path}${original.line ? `:${original.line}${original.col ? `:${original.col}` : ''}` : ''}`
    : href;
  if (!original) {
    try { title = decodeURI(href); } catch { /* 非法编码保留地址原样 */ }
  }
  return (
    <a
      href="#"
      title={title}
      className="ws-file-link"
      data-chat-link-target={href}
      onClick={(e) => {
        e.preventDefault();
        onFileLink(href);
      }}
    >
      {base ? <FileTypeIcon name={base} /> : null}
      <span className="ws-file-link-label">{children}</span>
    </a>
  );
}

/**
 * 链接路由：
 * - http(s)：新窗口外链；
 * - mailto/tel 等：原生锚点（不外链、不进文件面板）；
 * - muster-file: / file:// / 相对与绝对路径：模型常把工作区文件写成 markdown 链接
 *   （[文件](src/foo.ts)），统一交 onFileLink 在右侧文件面板打开；
 *   没有 onFileLink 时退回外链；被上游清空的 href 渲染成纯文本（不留死链接）。
 */
function mermaidFromPre(children: React.ReactNode): string | null {
  const nodes = React.Children.toArray(children);
  for (const node of nodes) {
    if (!isValidElement(node)) continue;
    const props = node.props as { className?: string; children?: unknown };
    if (!isMermaidFenceClass(props.className)) continue;
    return mermaidSourceFromCodeChildren(props.children);
  }
  return null;
}

/** 代码块壳：右上角复制钮悬浮代码块才现身（按钮在滚动容器外，横滚时钉在角上）；
 * 文本点击时从 pre DOM 取 textContent——高亮/多子节点结构变化都不影响 */
function CodeBlock({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation();
  const preRef = React.useRef<HTMLPreElement>(null);
  const [copyStatus, setCopyStatus] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const copyLife = React.useRef({ mounted: true, request: 0, timer: null as number | null });
  React.useEffect(() => {
    const life = copyLife.current;
    life.mounted = true;
    return () => {
      life.mounted = false;
      life.request++;
      if (life.timer != null) window.clearTimeout(life.timer);
      life.timer = null;
    };
  }, []);
  const copy = async (): Promise<void> => {
    const text = preRef.current?.textContent ?? '';
    if (!text) return;
    const life = copyLife.current;
    const request = ++life.request;
    if (life.timer != null) window.clearTimeout(life.timer);
    life.timer = null;
    setCopyStatus('idle');
    try {
      await navigator.clipboard.writeText(text);
      if (!life.mounted || life.request !== request) return;
      setCopyStatus('copied');
      // Business feedback lifetime, independent of the animation token duration.
      life.timer = window.setTimeout(() => {
        if (!life.mounted || life.request !== request) return;
        life.timer = null;
        setCopyStatus('idle');
      }, 1500);
    } catch {
      if (life.mounted && life.request === request) setCopyStatus('failed');
    }
  };
  const copied = copyStatus === 'copied';
  const label = copied ? t('已复制') : t('复制代码');
  return (
    <div className="md-code-block">
      <button
        type="button"
        className={`md-code-copy${copied ? ' is-done' : ''}`}
        title={copyStatus === 'failed' ? t('复制失败') : label}
        aria-label={label}
        onClick={() => void copy()}
      >
        <span className="copy-feedback" data-copied={copied ? 'true' : undefined} aria-hidden="true">
          <IconCopy size={12} />
        </span>
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

const SCROLLABLE_TABLE: Components['table'] = ({ node: _node, ...props }) => {
  const { t } = useTranslation();
  return (
    <div className="md-table-scroll" role="region" aria-label={t('表格')} tabIndex={0}>
      <table {...props} />
    </div>
  );
};
const TABLE_COLUMN_HEADER: Components['th'] = ({ node: _node, ...props }) => <th {...props} scope="col" />;

// Mail is external data. Do not reuse interactive anchors, media fetches,
// UI artifact expansion or Mermaid; keep code as inert source (also no copy action).
const DISPLAY_COMPONENTS: Components = {
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <span>{alt ?? ''}</span>,
  pre: ({ children }) => <pre>{children}</pre>,
  th: TABLE_COLUMN_HEADER
};

const PRE_MERMAID: Components['pre'] = ({ children }) => {
  const source = mermaidFromPre(children);
  if (source !== null) return <MermaidBlock source={source} />;
  return <CodeBlock>{children}</CodeBlock>;
};

/** ma-ui 部件产物链接（ui.render 返回的 …agent-sessions/<sid>/ui/<n>-<slug>.(inline|browser).html）
 *  → 部件卡（inline iframe / browser 链接卡）；非部件返回 null 走原路由。 */
function uiWidgetFromHref(
  target: string,
  children: React.ReactNode
): React.JSX.Element | null {
  const hit = target ? matchUiArtifactLink(target) : null;
  return hit ? <UiWidgetCard match={hit}>{children}</UiWidgetCard> : null;
}

function ChatImage({ src, alt, title, cwd }: { src?: string; alt?: string; title?: string; cwd?: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [failed, setFailed] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const isRemote = /^(?:https?:)?\/\//i.test(src ?? '');
  const resolved = localMarkdownImageUrl(src ?? '', cwd);
  const imageSrc = resolved ?? (isRemote ? src : undefined);
  if (failed || !imageSrc) return <span role="status">{t('图片不存在或无法读取')}{alt ? `：${alt}` : ''}</span>;
  const caption = title?.trim() || alt?.trim();
  return <>
    <button type="button" className="chat-markdown-image" data-chat-link-target={isRemote && !/^https?:\/\//i.test(src ?? '') ? undefined : src} aria-label={caption ? `${t('点击查看大图')}：${caption}` : t('点击查看大图')}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(true); }}>
      <img src={imageSrc} alt={alt ?? ''} title={title} onError={() => setFailed(true)} />
      {caption ? <span className="chat-markdown-image-caption">{caption}</span> : null}
    </button>
    <ImageLightbox src={open ? imageSrc : null} alt={alt} onClose={() => setOpen(false)} />
  </>;
}

function buildComponents(onFileLink?: (href: string) => void, localImages?: boolean, imageCwd?: string): Components {
  const span: Components['span'] = ({ node: _node, children, ...props }) => {
    const attributes = props as Record<string, unknown>;
    const path = attributes['data-ma-ui-path'];
    const match = typeof path === 'string' ? matchUiArtifactLink(path) : null;
    if (match) return <UiWidgetCard match={match}>{String(attributes['data-ma-ui-title'] ?? '')}</UiWidgetCard>;
    return <span {...props}>{children}</span>;
  };
  const img: Components['img'] | undefined = localImages ? ({ node: _node, src, alt, title }) =>
    <ChatImage key={`${src ?? ''}\0${imageCwd ?? ''}`} src={src} alt={alt} title={title} cwd={imageCwd} /> : undefined;
  if (!onFileLink) {
    return {
      span,
      ...(img ? { img } : {}),
      pre: PRE_MERMAID,
      table: SCROLLABLE_TABLE,
      th: TABLE_COLUMN_HEADER,
      a: ({ href, children }) => {
        const target = typeof href === 'string' ? href : '';
        const uiCard = uiWidgetFromHref(target, children);
        if (uiCard) return uiCard;
        // 无文件处理器的视图（调度悬浮卡/文本工具结果卡等）：相对 href 渲染成纯文本——
        // 裸 <a target=_blank> 会按应用页面源解析成 http://localhost:…/相对路径 的坏链
        if (!target || target.startsWith('#') || !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
          return <span className="ws-link-plain">{children}</span>;
        }
        return (
          <a href={href} target="_blank" rel="noreferrer noopener" data-chat-link-target={isHttpLink(target) ? target : undefined}>
            {children}
          </a>
        );
      }
    };
  }
  return {
    span,
    ...(img ? { img } : {}),
    pre: PRE_MERMAID,
    table: SCROLLABLE_TABLE,
    th: TABLE_COLUMN_HEADER,
    a: ({ href, children }) => {
      const target = typeof href === 'string' ? href : '';
      const uiCard = uiWidgetFromHref(target, children);
      if (uiCard) return uiCard;
      if (target.startsWith(WORKSPACE_FILE_LINK_SCHEME)) {
        return <FileLink href={target} onFileLink={onFileLink}>{children}</FileLink>;
      }
      if (target && isHttpLink(target) && isLocalhostHttpUrl(target) && !localImages) {
        // 文件预览保留现有 localhost 本地文件映射；会话中的 URL 走浏览器。
        return <FileLink href={target} onFileLink={onFileLink}>{children}</FileLink>;
      }
      if (target && !isHttpLink(target) && !isNonFileProtocol(target)) {
        // 相对/绝对路径或 file://：当工作区文件打开（打不开时 onFileLink 内部 toast）
        return <FileLink href={target} onFileLink={onFileLink}>{children}</FileLink>;
      }
      if (!target || target.startsWith('#')) {
        // 被清空/页内锚点：不留可点的死链接
        return <span className="ws-link-plain">{children}</span>;
      }
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" data-chat-link-target={isHttpLink(target) ? target : undefined}>
          {children}
        </a>
      );
    }
  };
}

/**
 * Agent / 文件预览 Markdown 渲染（GFM：表格 / 任务列表 / 删除线；```mermaid 渲成图；
 * $…$ / $$…$$ 经 remark-math + rehype-katex 渲成公式，见 docs/features/markdown-math.md）。
 * CJK 强调兼容（** / * / ~~ 贴中文标点）在传入前 soften、解析后剥 ZWSP，见
 * docs/features/markdown-cjk-emphasis.md。
 * memo：流式时最后一条消息 text 每拍不同必然重渲，已完成消息引用稳定即可跳过。
 */
// Keep parser work independent of the outer message's styling/layout updates.
const MarkdownContent = memo(function MarkdownContent({ text, onFileLink, localImages, imageCwd, displayOnly, suppressedPaths }: Omit<Props, 'className'> & { suppressedPaths: readonly string[] }): React.JSX.Element {
  const plugins = React.useMemo(() => displayOnly ? REMARK_PLUGINS : [...REMARK_PLUGINS, [remarkUiArtifacts, { suppressedPaths }]] as Parameters<typeof ReactMarkdown>[0]['remarkPlugins'], [displayOnly, suppressedPaths]);
  const components = React.useMemo(() => displayOnly ? DISPLAY_COMPONENTS : buildComponents(onFileLink, localImages, imageCwd), [displayOnly, onFileLink, localImages, imageCwd]);
  const display = React.useMemo(() => guardInlineMathCurrency(softenCjkMarkdownEmphasis(text)), [text]);
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      rehypePlugins={REHYPE_PLUGINS}
      urlTransform={displayOnly ? defaultUrlTransform : URL_TRANSFORM}
      skipHtml={displayOnly}
      components={components}
    >
      {display}
    </ReactMarkdown>
  );
});

function MarkdownBodyInner({ className, ...content }: Props): React.JSX.Element {
  const suppressedPaths = React.useContext(UiArtifactSuppressionContext);
  return (
    <div className={className ? `md-body ${className}` : 'md-body'}>
      <MarkdownContent {...content} suppressedPaths={suppressedPaths} />
    </div>
  );
}

export const MarkdownBody = memo(MarkdownBodyInner);

/**
 * P2-3②：markdown 解析链预热——boot 后空闲时用样本正文跑一遍真实渲染链
 * （react-markdown/remark-gfm/micromark 首次初始化与 JIT 移出首帧，一次性）。
 * 渲染进游离节点：不进文档、不拉 IPC、不挂可见 UI；提交后即卸载。
 */
export function warmMarkdownParser(): void {
  const host = document.createElement('div');
  const root = createRoot(host);
  const sample = [
    '# warmup',
    '',
    'sample **markdown** 正文预热：`code`。',
    '',
    '行内公式 $E = mc^2$ 与块级公式：',
    '',
    '$$\\oint_S \\mathbf{B} \\cdot d\\mathbf{S} = \\mu_0 I_c$$',
    '',
    '- a',
    '- b',
    ''
  ].join('\n');
  root.render(<MarkdownBody text={sample} />);
  window.setTimeout(() => root.unmount(), 300);
}
