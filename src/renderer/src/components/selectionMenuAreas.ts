import type { SelectionBarItem } from './SelectionBar';
import type { SelectionAreaContext } from './selectionMenuController';
import { openSelectionBang } from './selectionMenuController';
import { startTextToolRun } from './textToolRunner';
import type { TextToolFunction } from '../../../shared/types';
import { detectFirstUrl } from '../../../shared/terminalSelectionText';
import { requestChatNote } from '../agentChat/noteBridge';
import { openFileNoteEntry } from './fileNoteEntry';
import {
  copySelectionText,
  openSelectionUrl,
  previewSelectionPath,
  revealSelectionPath,
  searchSelectionText,
  selectionHasPath,
  selectionHasPreviewablePath
} from '../terminal/selectionActions';
import { openUiArtifactsInBrowser, uiArtifactLinksInText } from '../terminal/uiArtifactOpen';

export interface SelectionMenuServices {
  tip: (s: string) => void;
  insertComposer: (text: string) => void;
  openFile: (args: { path: string; line?: number; col?: number; scope?: 'workspace' | 'session'; ownerWorkspaceId?: string; ownerSessionId?: string }) => void;
}

export function selectionFileOwner(context?: SelectionAreaContext): { scope?: 'workspace' | 'session'; ownerWorkspaceId?: string; ownerSessionId?: string } {
  const owner = context?.rightOwner;
  return owner ? { scope: owner.scope, ownerWorkspaceId: owner.workspaceId, ownerSessionId: owner.sessionId } : {};
}

export interface SelectionItemBuildArgs {
  text: string;
  cwd?: string;
  context?: SelectionAreaContext;
  services: SelectionMenuServices;
  /** 设置里启用的「文本工具」（宿主传入快照）；每项渲染为浮条按钮 */
  textTools?: TextToolFunction[];
  /**
   * 当前活动会话（宿主按 sessions+runtimes 解析）：chat=GUI 会话（批注 token
   * 进输入框）；terminal=CLI 或 Shell 会话；缺省=不可批注。
   */
  activeSession?: { kind: 'chat' | 'terminal'; id: string; name: string } | null;
}

export type SelectionAreaBuilder = (args: SelectionItemBuildArgs) => SelectionBarItem[];

/**
 * 区域 → 菜单项注册表。新增区域只需在容器上标 data-sel-area="xxx"
 * 并在此 registerSelectionArea('xxx', builder)，即可改变该区域的菜单内容。
 */
const areas = new Map<string, SelectionAreaBuilder>();

export function registerSelectionArea(area: string, builder: SelectionAreaBuilder): void {
  areas.set(area, builder);
}

export function buildSelectionItems(area: string, args: SelectionItemBuildArgs): SelectionBarItem[] {
  const builder = areas.get(area) ?? areas.get('default');
  return builder ? builder(args) : [];
}

/** 内容区通用菜单：与终端一致（少一个「粘贴」）；复制/搜索后浮条保留，与终端旧行为对齐 */
function contentItems({ text, cwd, context, services, textTools }: SelectionItemBuildArgs): SelectionBarItem[] {
  const items: SelectionBarItem[] = [
    {
      id: 'copy',
      label: '复制',
      run: () => {
        void copySelectionText(text, services.tip);
      }
    },
    {
      id: 'search',
      label: '搜索',
      run: () => {
        void searchSelectionText(text, services.tip);
      }
    },
    {
      id: 'send-agent',
      label: '发给 Agent',
      run: (ctx) => {
        services.insertComposer(text);
        ctx.clearSelection();
        ctx.dismiss();
      }
    },
    {
      id: 'bang',
      label: '爆炸',
      primary: true,
      run: (ctx) => {
        openSelectionBang({ text, cwd, originTop: ctx.barRect?.top, context });
      }
    }
  ];
  if (detectFirstUrl(text)) {
    items.push({
      id: 'open-url',
      label: '打开链接',
      run: () => {
        void openSelectionUrl(text, services.tip);
      }
    });
  }
  // ma-ui 部件链接（agent-sessions/<sid>/ui/*.inline|browser.html）：在右侧网页区打开
  // （智能界面 M4 CLI 呈现层；普通 .html 不出此项。多条全部打开，超限截断在动作内提示）
  const uiArtifactLinks = uiArtifactLinksInText(text);
  if (uiArtifactLinks.length > 0) {
    items.push({
      id: 'open-ui-artifact',
      label: '在网页区打开',
      run: () => {
        void openUiArtifactsInBrowser(uiArtifactLinks, services.tip, context?.rightOwner);
      }
    });
  }
  if (selectionHasPath(text, cwd)) {
    items.push({
      id: 'reveal',
      label: '资源管理器',
      run: () => {
        void revealSelectionPath(text, cwd, services.tip);
      }
    });
  }
  if (selectionHasPreviewablePath(text, cwd)) {
    items.push({
      id: 'preview',
      label: '在文件区预览',
      run: () => {
        previewSelectionPath(
          text,
          cwd,
          (absPath, line, col) => services.openFile({ path: absPath, line, col, ...selectionFileOwner(context) }),
          services.tip
        );
      }
    });
  }
  // 文本工具（翻译/自定义提示词功能）：收浮条、开结果卡
  for (const tool of textTools ?? []) {
    items.push({
      id: `text-tool:${tool.id}`,
      label: tool.name,
      run: (ctx) => {
        startTextToolRun(tool, text, ctx.barRect);
        ctx.clearSelection();
        ctx.dismiss();
      }
    });
  }
  return items;
}

/** 终端：内容区菜单 + 「粘贴进终端输入」（经 context 回调进 TerminalView） */
function terminalItems(args: SelectionItemBuildArgs): SelectionBarItem[] {
  const items = contentItems(args);
  const annotate = args.context?.annotate;
  if (annotate) items.splice(1, 0, {
    id: 'annotate', label: '批注',
    run: (ctx) => { annotate(args.text); ctx.clearSelection(); ctx.dismiss(); }
  });
  const paste = args.context?.paste;
  if (!paste) return items;
  const copyIdx = items.findIndex((i) => i.id === 'copy');
  items.splice(copyIdx + 1, 0, {
    id: 'paste',
    label: '粘贴',
    run: () => {
      paste(args.text);
    }
  });
  return items;
}

registerSelectionArea('terminal', terminalItems);
registerSelectionArea('default', contentItems);
// 同构内容区：菜单相同，单独注册便于将来按区域差异化
registerSelectionArea('agent-chat', contentItems);
registerSelectionArea('diff', contentItems);
// 文件预览/编辑区：通用菜单 + 「批注」——贴浮条弹出批注录入框（路径:行号+所选内容）。
// GUI/CLI Agent 会话目标：token 带批注文字进工作台输入框；普通 Shell 回退粘贴终端。
registerSelectionArea('file-editor', (args) => {
  const items = contentItems(args);
  const idx = items.findIndex((i) => i.id === 'send-agent');
  items.splice(idx >= 0 ? idx + 1 : items.length, 0, {
    id: 'annotate',
    label: '批注',
    run: (ctx) => {
      const target = args.activeSession;
      if (!target) {
        args.services.tip('批注需要先在左侧选中会话');
        return;
      }
      const r = openFileNoteEntry({ target, barRect: ctx.barRect });
      if (r === 'ok') {
        ctx.dismiss(); // 选区保留高亮上下文；录入框自己管取消/完成
      } else {
        args.services.tip('当前没有可批注的文件内容');
      }
    }
  });
  return items;
});
// GUI 会话转写：通用菜单 + 「批注」（对 AI 回复划词批注；路由见 agentChat/noteBridge）
registerSelectionArea('gui-chat', (args) => {
  const items = contentItems(args);
  const idx = items.findIndex((i) => i.id === 'send-agent');
  items.splice(idx >= 0 ? idx + 1 : items.length, 0, {
    id: 'annotate',
    label: '批注',
    run: (ctx) => {
      requestChatNote();
      ctx.clearSelection();
      ctx.dismiss();
    }
  });
  return items;
});
