/**
 * 工具调用的可视化辅助：按工具名/入参分类出人话动词与主显示（文件路径 / 命令），
 * 并把 old/new 文本对合成 unified diff（Pi edit 的 details.patch 直接可用，其余走合成）。
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Diff, Hunk, parseDiff } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import { t } from '../../../shared/i18n';
import { buildWorkspaceFileHref } from '../../../shared/linkifyWorkspacePaths';
import { FileTypeIcon } from './FileTypeIcon';

/** 工具卡的「人话」描述 */
export interface ToolVisual {
  /** 摘要动词（读取/写入/编辑/执行命令/搜索/列目录/调用） */
  verb: string;
  /** 主显示：文件路径（可链接）或命令文本 */
  path?: string;
  /** path 实为命令（非文件路径，不做链接） */
  isCommand?: boolean;
  /** 用命令区呈现的原始参数名 */
  commandParam?: string;
  /** 摘要中的搜索词或 MCP 服务名 */
  detail?: string;
  /** old/new 替换对（编辑类合成 diff 用） */
  edits?: Array<{ oldText: string; newText: string }>;
  /** 写入类工具的全文内容 */
  content?: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** 从入参里挖文件路径（各家命名都认） */
function extractPath(input: Record<string, unknown>): string | undefined {
  return (
    asString(input.path) ??
    asString(input.file_path) ??
    asString(input.filePath) ??
    asString(input.filename) ??
    asString(input.notebook_path) ??
    asString(input.abs_path) ??
    asString(input.target)
  );
}

const COMMAND_PARAMS = ['command', 'cmd', 'script', 'code'] as const;

/** 普通工具名归一：取命名空间后的名称并转小写 */
function baseName(name: string): string {
  const parts = name.split(/[.:]/).filter(Boolean);
  return (parts.length > 0 ? parts[parts.length - 1] : name).toLowerCase();
}

export function classifyTool(
  name: string,
  input: Record<string, unknown>
): ToolVisual {
  const path = extractPath(input);
  const commandParam = COMMAND_PARAMS.find(param => asString(input[param]) !== undefined);
  const command = commandParam ? asString(input[commandParam]) : undefined;

  // 后台任务工具（点号名；Cursor 自定义工具是下划线）
  if (name.startsWith('bgtasks.') || name.startsWith('bgtasks_')) {
    const sub = name.replace(/^bgtasks[._]/, '');
    if (sub === 'shell') {
      return { verb: '后台执行', path: command ?? asString(input.name), isCommand: true };
    }
    if (sub === 'wait') {
      const when =
        typeof input.delaySec === 'number'
          ? Math.round(input.delaySec / 60) >= 1
            ? t('{{n}} 分钟后', { n: Math.round(input.delaySec / 60) })
            : t('{{n}} 秒后', { n: Math.round(input.delaySec) })
          : asString(input.at);
      return { verb: '定时唤醒', path: [when, asString(input.reason)].filter(Boolean).join('：') || undefined, isCommand: true };
    }
    if (sub === 'list') return { verb: '查后台任务' };
    if (sub === 'kill') return { verb: '终止后台任务', path: asString(input.taskId), isCommand: true };
  }

  const mcp = /^mcp__([\w.-]+?)__([\w.-]+)$/.exec(name);
  if (mcp) return { verb: mcp[2], path, detail: path ? undefined : mcp[1] };

  // 点号名是宿主 Catalog 工具（调度面板的 sessions.observe 等）：不做动词归类，原名展示
  if (name.includes('.')) {
    return { verb: name, path, isCommand: command !== undefined && !path };
  }
  const base = baseName(name);

  // 编辑类：old/new 替换对（Pi edits[] 或 Claude 风格单对）
  const edits: Array<{ oldText: string; newText: string }> = [];
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      const o = (e as { oldText?: unknown }).oldText;
      const n = (e as { newText?: unknown }).newText;
      if (typeof o === 'string' && typeof n === 'string') edits.push({ oldText: o, newText: n });
    }
  }
  const oldOne = asString(input.old_string) ?? asString(input.oldString) ?? asString(input.oldText);
  const newOne = asString(input.new_string) ?? asString(input.newString) ?? asString(input.newText);
  if (oldOne !== undefined && newOne !== undefined) edits.push({ oldText: oldOne, newText: newOne });

  if (/^(edit|str_replace(_based|_editor)?$|apply_patch|replace(_all)?|multiedit)$/.test(base) || edits.length > 0) {
    return { verb: '编辑', path, edits: edits.length ? edits : undefined };
  }
  if (/^(write|create(_file)?$|save|set_file_contents)$/.test(base) || (base.includes('write') && path)) {
    return {
      verb: '写入',
      path,
      content: asString(input.content) ?? asString(input.text) ?? asString(input.file_text)
    };
  }
  if (/^(read|read_file|view|cat|get_file_contents?)$/.test(base) || (base.includes('read') && path)) {
    return { verb: '读取', path };
  }
  if (/^(bash|shell|sh|zsh|pwsh|powershell|exec|execute(_command)?|run_(shell_)?command|terminal)$/.test(base) || command !== undefined) {
    return { verb: '执行命令', path: command ?? path, isCommand: true, commandParam };
  }
  if (/^(grep(_search)?|find|search|glob|rg|fuzzy_search|tool_search)$/.test(base)) {
    return { verb: '搜索', path, detail: asString(input.pattern) ?? asString(input.query) };
  }
  if (/^(ls|list|list_files|listdir|tree)$/.test(base)) {
    return { verb: '列目录', path };
  }
  if (/^(askquestion|ask_user_question)$/.test(base)) {
    return { verb: '提问', path: asString(input.title), isCommand: true };
  }
  return { verb: name, path, isCommand: command !== undefined && !path };
}

/**
 * old/new 文本对 → unified diff 文本（无文件内容可对照，行号占位、无上下文行；
 * 仅作可视化：删行全 -、增行全 +）。
 */
export function buildReplaceDiffText(
  path: string,
  edits: Array<{ oldText: string; newText: string }>
): string {
  const lines: string[] = [`--- a/${path || 'file'}`, `+++ b/${path || 'file'}`];
  for (const { oldText, newText } of edits) {
    const oldLines = oldText.length ? oldText.split('\n') : [];
    const newLines = newText.length ? newText.split('\n') : [];
    lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
    for (const l of oldLines) lines.push(`-${l}`);
    for (const l of newLines) lines.push(`+${l}`);
  }
  return lines.join('\n');
}

/** 迷你 diff 视图：react-diff-view 无 tokenize（轻量），行数超限截断 */
export function MiniDiffView({
  diffText,
  maxRows = 400
}: {
  diffText: string;
  maxRows?: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  const parsed = useMemo(() => {
    try {
      return parseDiff(diffText);
    } catch {
      return [];
    }
  }, [diffText]);
  if (parsed.length === 0) {
    return <pre className="tool-diff-raw">{diffText}</pre>;
  }
  let rows = 0;
  let truncated = false;
  return (
    <div className="tool-diff">
      {parsed.map((file, i) => {
        if (truncated) return null;
        const hunks = file.hunks ?? [];
        const kept: typeof hunks = [];
        for (const h of hunks) {
          if (rows + h.changes.length > maxRows) {
            truncated = true;
            break;
          }
          kept.push(h);
          rows += h.changes.length;
        }
        if (!kept.length) return null;
        return (
          <Diff
            key={`${file.oldRevision ?? ''}:${file.newRevision ?? ''}:${i}`}
            viewType="unified"
            diffType={file.type}
            hunks={kept}
          >
            {(hs) => hs.map((hunk, hi) => <Hunk key={hunk.content || `h-${hi}`} hunk={hunk} />)}
          </Diff>
        );
      })}
      {truncated ? <div className="tool-diff-more">{t('…diff 过长已截断')}</div> : null}
    </div>
  );
}

/** 工具卡标题里的路径（可点击走文件链接回调；命令文本走 code 展示） */
export function ToolTitleTarget({
  visual,
  label = visual.path,
  onFileLink
}: {
  visual: ToolVisual;
  label?: string;
  onFileLink?: (href: string) => void;
}): React.JSX.Element | null {
  if (!visual.path) return null;
  if (visual.isCommand || !onFileLink) {
    return (
      <span className={visual.isCommand ? 'tool-target tool-target-cmd' : 'tool-target'} title={visual.path}>
        {label}
      </span>
    );
  }
  // 图标按纯路径分类；path:line[:col] 形态先剥掉行号再取扩展名
  const purePath = visual.path.replace(/:\d+(?::\d+)?$/, '');
  const location = /:(\d+)(?::(\d+))?$/.exec(visual.path);
  const href = buildWorkspaceFileHref(purePath, location ? Number(location[1]) : undefined, location?.[2] ? Number(location[2]) : undefined);
  return (
    <a
      href="#"
      className="tool-target ws-file-link"
      title={visual.path}
      data-chat-link-target={href}
      onClick={(e) => {
        e.preventDefault();
        onFileLink(href);
      }}
    >
      <FileTypeIcon name={purePath} />
      <span className="ws-file-link-label">{label}</span>
    </a>
  );
}
