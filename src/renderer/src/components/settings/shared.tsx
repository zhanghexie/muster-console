import React from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsJumpTitle } from './SettingsSectionJump';

/** 空格分词；支持简单双引号包裹 */
export function parseExtraArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'(\S*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out.filter(Boolean);
}

export function formatExtraArgs(args: string[] | undefined): string {
  if (!args?.length) return '';
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

export function kvToText(map?: Record<string, string>): string {
  if (!map) return '';
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function textToKv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/** 折叠组头部的右向箭头（展开时由 CSS 旋转 90°） */
export function Chevron(): React.JSX.Element {
  return (
    <svg className="settings-chev" width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** 设置页分区：标题和操作在外，所有设置内容共享一个边框。 */
export function SettingsSection({
  title,
  side,
  desc,
  item,
  children
}: {
  title: React.ReactNode;
  side?: React.ReactNode;
  desc?: React.ReactNode;
  item?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const headingId = React.useId();
  const descriptionId = React.useId();
  return (
    <section className="s-sec" data-settings-item={item} aria-labelledby={headingId} aria-describedby={desc ? descriptionId : undefined}>
      <div className="s-sec-h">
        <div className="s-sec-heading">
          <h2 id={headingId}><SettingsJumpTitle>{title}</SettingsJumpTitle></h2>
          {desc ? <p id={descriptionId} className="s-sec-desc">{desc}</p> : null}
        </div>
        {side ? <div className="s-sec-side">{side}</div> : null}
      </div>
      <div className="settings-group-body s-sec-body">{children}</div>
    </section>
  );
}

/** A named group inside a section; the parent section owns the surrounding frame. */
export function SettingsSubsection({ title, desc, item, children }: {
  title: React.ReactNode; desc?: React.ReactNode; item?: string; children: React.ReactNode;
}): React.JSX.Element {
  const headingId = React.useId();
  const descriptionId = React.useId();
  return <section className="settings-subgroup" data-settings-item={item} aria-labelledby={headingId} aria-describedby={desc ? descriptionId : undefined}>
    <div className="settings-subgroup-heading"><h3 id={headingId}>{title}</h3>{desc ? <p id={descriptionId} className="s-sec-desc">{desc}</p> : null}</div>
    {children}
  </section>;
}

/** 行组容器：包一组 SettingRow / FieldRow */
export function SettingsRows({
  item,
  testId,
  className,
  children
}: {
  item?: string;
  testId?: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={className ? `s-rows ${className}` : 's-rows'} data-settings-item={item} data-testid={testId}>
      {children}
    </div>
  );
}

/** 行卡：一组 SettingRow，行间 hairline 分隔（遗留样式，仅存量化内容使用） */
export function SettingsCard({
  children,
  item,
  className
}: {
  children: React.ReactNode;
  item?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={className ? `s-card ${className}` : 's-card'} data-settings-item={item}>
      {children}
    </div>
  );
}

/**
 * 设置行：左标题 + 一句说明，右控件（开关/分段/下拉等短控件）。
 * divided = 行顶加 hairline 分界（危险动作/操作结果行）。
 * stacked 时控件换到标题下方整行（长输入框、列表等放不进右侧的内容）。
 */
export function SettingRow({
  title,
  desc,
  tag,
  item,
  stacked,
  divided,
  children
}: {
  title: React.ReactNode;
  desc?: React.ReactNode;
  tag?: React.ReactNode;
  item?: string;
  stacked?: boolean;
  divided?: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={`s-row${stacked ? ' is-stacked' : ''}${divided ? ' is-divided' : ''}`}
      data-settings-item={item}
    >
      <div className="s-row-l">
        {title != null || tag != null ? <h3 className="s-row-t">
          {title}
          {tag}
        </h3> : null}
        {desc ? <div className="s-row-d">{desc}</div> : null}
      </div>
      {children !== undefined ? <div className="s-row-r">{children}</div> : null}
    </div>
  );
}

/**
 * 字段行：标签在上、控件整行。输入框（URL/路径/长文/带附加按钮）一律用字段行。
 */
export function FieldRow({
  label,
  tip,
  item,
  children
}: {
  label: React.ReactNode;
  tip?: React.ReactNode;
  item?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="s-frow" data-settings-item={item}>
      <div className="s-frow-label">
        <h3 className="s-frow-title">{label}</h3>
        {tip ? <span className="s-frow-tip">{tip}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** 开关：原生 checkbox（保留 checkbox 语义与键盘行为），CSS 画成拨动开关 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  title,
  testId
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
  testId?: string;
}): React.JSX.Element {
  return (
    <input
      type="checkbox"
      className="s-switch"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      title={title}
      data-testid={testId}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/** 分段选择（2–4 个互斥选项） */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
  label,
  disabled
}: {
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (v: V) => void;
  label: string;
  disabled?: boolean;
}): React.JSX.Element {
  const group = React.useRef<HTMLDivElement>(null);
  const optionShape = JSON.stringify(options);
  const positionSelection = React.useCallback((snap = false): void => {
    const host = group.current;
    if (!host) return;
    const selected = host.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    const plate = host.querySelector<HTMLElement>('.s-seg-selection');
    if (!selected || !plate) { delete host.dataset.segReady; return; }
    const width = selected.offsetWidth;
    // Kept settings pages can be hidden or temporarily have no layout. Never
    // replace the last valid geometry with zeros, or fly in from zero on reveal.
    if (width <= 0 || host.offsetWidth <= 0 || host.closest('[aria-hidden="true"], [hidden]')) {
      delete host.dataset.segReady;
      return;
    }
    const immediate = snap || !host.dataset.segReady;
    if (immediate) plate.style.transition = 'none';
    plate.style.width = `${width}px`;
    plate.style.transform = `translateX(${selected.offsetLeft}px)`;
    host.dataset.segReady = 'true';
    if (immediate) {
      // Commit the corrected position before restoring the transition. This is
      // bounded to first layout/resize/reveal, never an animation-frame loop.
      getComputedStyle(plate).transform;
      plate.style.removeProperty('transition');
    }
  }, []);
  React.useLayoutEffect(() => { positionSelection(); }, [value, optionShape, positionSelection]);
  React.useLayoutEffect(() => {
    const host = group.current;
    if (!host) return;
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => positionSelection(true));
    resize?.observe(host);
    // A kept xfade page changes visibility without changing its measured size.
    const pane = host.closest('.settings-tabpane');
    const visibility = pane ? new MutationObserver(() => positionSelection(true)) : undefined;
    if (pane) visibility?.observe(pane, { attributes: true, attributeFilter: ['aria-hidden', 'hidden'] });
    const fonts = document.fonts;
    const fontLoaded = (): void => positionSelection(true);
    let active = true;
    fonts?.addEventListener('loadingdone', fontLoaded);
    void fonts?.ready.then(() => { if (active) positionSelection(true); });
    return () => {
      active = false;
      resize?.disconnect();
      visibility?.disconnect();
      fonts?.removeEventListener('loadingdone', fontLoaded);
    };
  }, [positionSelection]);
  return (
    <div className="s-seg" role="group" aria-label={label} ref={group}>
      <span className="s-seg-selection" aria-hidden="true" />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? 'is-on' : undefined}
          aria-pressed={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 「高级」折叠：技术项收进来，默认收起 */
export function AdvancedDetails({
  summary,
  item,
  defaultOpen,
  children
}: {
  summary?: React.ReactNode;
  item?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <details className="s-adv" data-settings-item={item} open={defaultOpen}>
      <summary>
        <Chevron />
        <span>{summary ?? t('高级')}</span>
      </summary>
      <div className="s-adv-body">{children}</div>
    </details>
  );
}
