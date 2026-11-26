import React, { useEffect, useRef, useState } from 'react';
import { builtinTheme } from '../../../src/shared/theme';
import {
  IconBoard, IconBranch, IconChat, IconCheckSquare, IconClock, IconClose,
  IconFile, IconFolder, IconLayers, IconMinus, IconMore, IconPlan,
  IconPuzzle, IconSearch, IconSliders, IconTerminal
} from '../../../src/renderer/src/components/icons';

export type Material = 'acrylic' | 'mica' | 'solid';
export type Theme = 'dark' | 'light';
export interface State {
  material: Material;
  theme: Theme;
  tint: number;
  reference: boolean;
  platform: string;
  supportedMaterials: string[];
  nativeAvailable: boolean;
  electronVersion: string;
  osVersion: string;
}
export type Options = Partial<Pick<State, 'material' | 'theme' | 'tint' | 'reference'>>;
export interface MaterialDemoBridge {
  getState(): Promise<State>;
  setOptions(options: Options): Promise<State>;
  minimize(): void;
  maximize(): void;
  close(): void;
}

declare global {
  interface Window { materialDemo?: MaterialDemoBridge }
}

const INITIAL: State = {
  material: 'solid', theme: 'dark', tint: 12, reference: true,
  platform: 'unknown', supportedMaterials: ['solid'], nativeAvailable: false,
  electronVersion: '', osVersion: ''
};
const MATERIALS: { id: Material; label: string }[] = [
  { id: 'acrylic', label: 'Acrylic' }, { id: 'mica', label: 'Mica' }, { id: 'solid', label: '实色' }
];
const TOOLS = [
  { name: '看板', Icon: IconBoard }, { name: '触发任务', Icon: IconClock },
  { name: '记忆', Icon: IconLayers }, { name: '扩展', Icon: IconPuzzle },
  { name: '计划', Icon: IconPlan }, { name: '设置', Icon: IconSliders }
];
const SESSIONS = [
  { id: 'material', title: '侧栏材质实验', state: '等验收', tone: 'waiting' },
  { id: 'layout', title: '工作区布局', state: '进行中', tone: 'working' },
  { id: 'files', title: '文件预览', state: '已完成', tone: 'done' },
  { id: 'tools', title: '工具接入', state: '待开始', tone: 'idle' }
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function MaterialDemo(): React.JSX.Element {
  const [state, setState] = useState<State>(INITIAL);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('material');
  const sequence = useRef(0);
  const current = useRef<State>(INITIAL);
  const acknowledged = useRef<State>(INITIAL);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const request = ++sequence.current;
    const bridge = window.materialDemo;
    if (!bridge) {
      setError('未连接 Electron 窗口。请用启动脚本打开这个小样。');
      return () => { alive.current = false; sequence.current++; };
    }
    bridge.getState().then((next) => {
      if (!alive.current || request !== sequence.current) return;
      current.current = acknowledged.current = next;
      setState(next);
      setReady(true);
    }).catch((reason) => {
      if (alive.current && request === sequence.current) {
        setError(`读取材质状态失败：${errorMessage(reason)}`);
      }
    });
    return () => { alive.current = false; sequence.current++; };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const beforeTheme = root.dataset.theme;
    const beforeScheme = root.style.colorScheme;
    const theme = builtinTheme(state.theme)!;
    const previous = Object.keys(theme.colors).map((key) => [key, root.style.getPropertyValue(`--${key}`)]);
    root.dataset.theme = state.theme;
    root.style.colorScheme = state.theme;
    for (const [key, value] of Object.entries(theme.colors)) root.style.setProperty(`--${key}`, value);
    return () => {
      if (beforeTheme === undefined) delete root.dataset.theme;
      else root.dataset.theme = beforeTheme;
      root.style.colorScheme = beforeScheme;
      for (const [key, value] of previous) {
        if (value) root.style.setProperty(`--${key}`, value);
        else root.style.removeProperty(`--${key}`);
      }
    };
  }, [state.theme]);

  async function change(options: Options): Promise<void> {
    if (!ready || !window.materialDemo) return;
    const request = ++sequence.current;
    const optimistic = { ...current.current, ...options };
    current.current = optimistic;
    setState(optimistic);
    setPending(true);
    setError('');
    try {
      const next = await window.materialDemo.setOptions(options);
      if (!alive.current || request !== sequence.current) return;
      current.current = acknowledged.current = next;
      setState(next);
    } catch (reason) {
      if (!alive.current || request !== sequence.current) return;
      current.current = acknowledged.current;
      setState(acknowledged.current);
      setError(`切换材质失败：${errorMessage(reason)}`);
    } finally {
      if (alive.current && request === sequence.current) setPending(false);
    }
  }

  const active = SESSIONS.find((session) => session.id === selected)!;
  const native = state.material !== 'solid';
  const nativeName = state.platform === 'darwin' && state.material === 'acrylic' ? 'Sidebar Vibrancy' : state.material === 'mica' ? 'Mica' : 'Acrylic';
  const style = { '--demo-tint': `${state.tint}%` } as React.CSSProperties;

  return (
    <div className="material-demo" data-theme={state.theme} data-material={state.material} style={style}>
      <aside className="demo-sidebar sidebar" aria-label="示例侧栏">
        <div className="demo-brand demo-drag-region"><IconLayers size={17} /><span>MetaAgent</span><small>小样</small></div>
        <div className="left-panel">
          <div className="left-panel-scroll">
            <div className="demo-nav"><IconSearch size={14} /><span>工作区</span><IconMore size={15} /></div>
            <div className="panel-header">实用工具</div>
            <div className="utility-feature-list">
              {TOOLS.map(({ name, Icon }) => (
                <div key={name} className="utility-feature-item demo-static-tile">
                  <span className="utility-feature-icon"><Icon size={16} /></span>
                  <span className="session-name">{name}</span>
                </div>
              ))}
            </div>
            <div className="panel-header sub demo-section-header"><span>工作会话</span><span>示例</span></div>
            <div className="demo-session-list">
              {SESSIONS.map((session) => (
                <button key={session.id} type="button" aria-pressed={selected === session.id}
                  className={`session-item demo-session ${selected === session.id ? 'active' : ''}`}
                  onClick={() => setSelected(session.id)}>
                  <span className={`demo-status-dot is-${session.tone}`} />
                  <span className="demo-session-name">{session.title}</span>
                  <span className="demo-session-status">{session.state}</span>
                </button>
              ))}
            </div>
            <div className="panel-header sub">终端</div>
            <div className="demo-terminal-row"><IconTerminal size={14} /><span>开发终端</span><span className="demo-terminal-label">示例</span></div>
          </div>
          <div className="demo-workspace">
            <div className="demo-workspace-avatar">M</div>
            <div className="demo-workspace-text"><span>材质实验室</span><small>独立小样 · 示例数据</small></div>
            <IconMore size={14} />
          </div>
        </div>
      </aside>

      <main className="demo-sheet">
        <header className="demo-topbar demo-drag-region">
          <span className="demo-topbar-title">原生窗口材质</span>
          <span className="demo-topbar-meta">独立预览</span>
          <div className="demo-window-buttons">
            <button type="button" aria-label="最小化" onClick={() => window.materialDemo?.minimize()}><IconMinus size={14} /></button>
            <button type="button" aria-label="最大化或还原" onClick={() => window.materialDemo?.maximize()}><span className="demo-maximize-icon" /></button>
            <button type="button" aria-label="关闭小样" className="demo-close" onClick={() => window.materialDemo?.close()}><IconClose size={14} /></button>
          </div>
        </header>

        <section className="demo-controls" aria-label="材质对比控制">
          <div className="demo-control-row">
            <div className="demo-segmented" aria-label="窗口材质">
              {MATERIALS.map(({ id, label }) => (
                <button key={id} type="button" aria-pressed={state.material === id}
                  disabled={!ready || !state.supportedMaterials.includes(id)}
                  title={ready && !state.supportedMaterials.includes(id) ? '当前系统不支持这个材质' : undefined}
                  onClick={() => void change({ material: id })}>{label}</button>
              ))}
            </div>
            <div className="demo-segmented demo-theme-control" aria-label="颜色主题">
              <button type="button" aria-pressed={state.theme === 'dark'} disabled={!ready} onClick={() => void change({ theme: 'dark' })}>深色</button>
              <button type="button" aria-pressed={state.theme === 'light'} disabled={!ready} onClick={() => void change({ theme: 'light' })}>浅色</button>
            </div>
            <label className="demo-reference"><input type="checkbox" checked={state.reference} disabled={!ready} onChange={(event) => void change({ reference: event.target.checked })} />对照背景</label>
          </div>
          <div className="demo-control-row demo-tint-row">
            <label htmlFor="demo-tint">侧栏叠层</label>
            <input id="demo-tint" aria-label="侧栏叠层浓度" type="range" min="0" max="45" step="1" value={state.tint} disabled={!ready || !native}
              onChange={(event) => void change({ tint: Number(event.target.value) })} />
            <output htmlFor="demo-tint">{state.tint}%</output>
            <span className="demo-tint-hint">{native ? '低浓度更透，高浓度更稳' : '实色对照'}</span>
          </div>
          <p className="demo-material-status" role="status" aria-label="材质状态">
            {pending ? '正在切换…' : !ready ? '等待窗口连接' : native && state.nativeAvailable ? `已请求系统 ${nativeName} 材质；系统透明效果、节能等设置可能使它降级。` : native ? '原生材质不可用，系统可能显示实色背景。' : '实色对照：左栏使用当前主题的框色。'}
          </p>
          {error && <p className="demo-error" role="alert">{error}</p>}
        </section>

        <div className="demo-content">
          <section className="demo-conversation" aria-label="示例聊天">
            <div className="demo-conversation-heading"><IconChat size={15} /><span>{active.title}</span><span className="demo-sample-label">示例内容</span></div>
            <div className="demo-message demo-user-message"><div className="demo-message-meta">你</div><p>先看看最左侧侧栏换成系统材质后的效果。</p></div>
            <div className="demo-message demo-assistant-message">
              <div className="demo-message-meta"><span className="demo-agent-mark"><IconLayers size={13} /></span>MetaAgent</div>
              <p>材质只从左栏透出，聊天和文件仍使用实色工作面。</p>
              <p>可以切换深浅主题，再拖动窗口到不同背景上比较。</p>
              <div className="demo-content-note"><IconCheckSquare size={14} /><span>关闭「对照背景」可直接观察桌面与后方窗口。</span></div>
            </div>
            <div className="demo-composer"><span>这是材质小样，聊天内容为静态示例</span><span className="demo-composer-model">预览</span></div>
          </section>
          <aside className="demo-files" aria-label="示例文件">
            <div className="demo-file-heading"><span>文件</span><span className="demo-sample-label">示例</span></div>
            <div className="demo-file-row"><IconFolder size={14} /><span>native-material-demo</span></div>
            <div className="demo-file-row is-child"><IconFile size={14} /><span>App.tsx</span></div>
            <div className="demo-file-row is-child"><IconFile size={14} /><span>styles.css</span></div>
            <div className="demo-file-row is-child"><IconFile size={14} /><span>main.cjs</span></div>
            <div className="demo-runtime-info"><IconBranch size={13} /><span>独立实验</span></div>
            <div className="demo-runtime-detail"><span>{state.platform === 'win32' ? 'Windows' : state.platform === 'darwin' ? 'macOS' : state.platform === 'linux' ? 'Linux' : '连接中'}</span><span>Electron {state.electronVersion || '—'}</span><span className="demo-os-version">{state.osVersion}</span></div>
          </aside>
        </div>
      </main>
    </div>
  );
}
