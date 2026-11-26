import React, { useEffect, useState } from 'react';
import { NavigationIcon } from '../../../src/renderer/src/components/ExtensionNavigationTree';
import { UtilityNavigationSection } from '../../../src/renderer/src/components/UtilityNavigationSection';
import { navigationChildren, navigationPath, parseNavigation, type ExtensionNavigationNode as NavNode } from '../../../src/shared/extensionNavigation';
import { builtinTheme } from '../../../src/shared/theme';
import { applyTheme } from '../../../src/renderer/src/theme';
import { IconClock, IconFolder, IconLayers, IconPlus, IconPuzzle, IconSparkle } from '../../../src/renderer/src/components/icons';

const BUILTIN_UTILITIES = [
  { id: 'builtin:tasks', title: '定时任务', icon: IconClock, description: '按计划运行提示词与工作流。' },
  { id: 'builtin:usage', title: '使用统计', icon: IconLayers, description: '查看会话和工具的使用情况。' },
  { id: 'builtin:memory', title: '记忆整理', icon: IconSparkle, description: '管理条目、用户画像和待审阅记忆。' },
  { id: 'builtin:extensions', title: '扩展管理', icon: IconPuzzle, description: '管理已安装的扩展。' }
];

export const INITIAL_NAVIGATION: NavNode[] = [
  { id: 'studio', kind: 'folder', parentId: null, title: '创作工具', expanded: true },
  { id: 'assets', kind: 'extension', parentId: 'studio', title: '素材库', favorite: true, extensionId: 'studio', viewId: 'assets', description: '收集素材，整理创作所需。' },
  { id: 'queue', kind: 'extension', parentId: 'studio', title: '任务队列', extensionId: 'studio', viewId: 'queue', description: '长任务在后台持续运行。' },
  { id: 'research', kind: 'folder', parentId: 'studio', title: '灵感参考', expanded: true },
  { id: 'design', kind: 'web', parentId: 'research', title: '设计灵感', url: 'https://www.behance.net/' },
  { id: 'docs', kind: 'web', parentId: 'research', title: '项目文档', favorite: true, url: 'https://example.com/project' },
  { id: 'daily', kind: 'folder', parentId: null, title: '日常工具', expanded: true },
  { id: 'notes', kind: 'extension', parentId: 'daily', title: '工作笔记', extensionId: 'notes', viewId: 'main', description: '随手写下，切换后继续。' },
  { id: 'translate', kind: 'web', parentId: 'daily', title: '翻译', url: 'https://www.deepl.com/' },
  { id: 'gallery', kind: 'web', parentId: null, title: '参考图库', url: 'https://unsplash.com/' }
];
const STORAGE_KEY = 'metaagent.extension-sidebar-prototype.v1';
const LIBRARY_KEY = `${STORAGE_KEY}.library-expanded`;
const clone = (): NavNode[] => INITIAL_NAVIGATION.map(node => ({ ...node }));
function readInitial(): NavNode[] {
  try { return parseNavigation(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')) ?? clone(); }
  catch { return clone(); }
}

export function ExtensionSidebarStudy(): React.JSX.Element {
  const [nodes, setNodes] = useState<NavNode[]>(readInitial);
  const [selected, setSelected] = useState<string | null>('studio');
  const [history, setHistory] = useState<NavNode[][]>([]);
  const [message, setMessage] = useState('点网格末尾的“展开”查看全部工具，列表的 ··· 菜单可以添加常用。');
  const [libraryExpanded, setLibraryExpanded] = useState(() => {
    try { return localStorage.getItem(LIBRARY_KEY) === 'true'; } catch { return false; }
  });
  const [theme, setTheme] = useState<'light' | 'dark'>(() => new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light');
  const [note, setNote] = useState('把项目文档和常用网页放进同一个文件夹。\n\n切换到其他面板，再回来试试。');
  const [focus, setFocus] = useState(false);
  const active = nodes.find(node => node.id === selected);
  const builtin = BUILTIN_UTILITIES.find(item => item.id === selected);
  useEffect(() => { applyTheme(builtinTheme(theme)!); }, [theme]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes)); }
    catch { setMessage('浏览器未允许本地保存，本次操作仍可继续。'); }
  }, [nodes]);
  useEffect(() => {
    try { localStorage.setItem(LIBRARY_KEY, String(libraryExpanded)); }
    catch { setMessage('浏览器未允许本地保存，本次操作仍可继续。'); }
  }, [libraryExpanded]);
  function change(next: NavNode[], announcement: string): void {
    if (announcement) setHistory(previous => [...previous.slice(-19), nodes]);
    setNodes(next);
    if (announcement) setMessage(announcement);
  }
  const shownChildren = navigationChildren(nodes, active?.kind === 'folder' ? active.id : null);
  return <div className={`ext-study${focus ? ' is-focused' : ''}`}>
    <header className="ext-study-chrome">
      <div className="ext-study-brand"><span className="ext-study-logo">m</span><strong>MetaAgent</strong><span className="ext-study-project">创作空间</span></div>
      <span className="ext-study-prototype">实用工具交互原型 · 示例数据</span>
      <div className="ext-study-controls"><button className="ui-btn ghost tiny" onClick={() => { change(clone(), '已恢复示例，可撤销'); setSelected('studio'); }}>恢复示例</button><button className="ui-btn ghost tiny" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '深色' : '浅色'}</button></div>
    </header>
    <div className="ext-study-layout">
      <aside className="ext-study-sidebar">
        <div className="ext-study-workspace"><span className="ext-study-workspace-mark"><IconFolder size={17} /></span><div><strong>我的工作台</strong><span>网页与扩展，随手可达</span></div></div>
        <div className="ext-study-nav-scroll"><UtilityNavigationSection nodes={nodes} selectedId={selected} onChange={change} onSelect={setSelected}
          libraryExpanded={libraryExpanded} onLibraryExpandedChange={setLibraryExpanded}
          builtinTiles={BUILTIN_UTILITIES.map(item => <button key={item.id} type="button" className={`utility-feature-item${selected === item.id ? ' active' : ''}`} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>
            <span className="utility-feature-icon"><item.icon size={16} /></span><span className="session-name"><span className="session-name-text">{item.title}</span></span>
          </button>)} />
          <div className="ext-study-sessions"><span>会话</span><div><i />整理项目资料<small>刚刚</small></div><div><i />新想法<small>今天</small></div></div>
        </div>
        <div className="ext-study-sidebar-footer"><span className="ext-study-avatar">M</span><div><strong>创作空间</strong><span>当前工作区</span></div><span>⌄</span></div>
      </aside>
      <main className="ext-study-page">
        <header className="ext-study-page-header"><div className="ext-study-breadcrumb"><button onClick={() => setSelected(null)}>实用工具</button>{builtin && <><span>/</span><span>{builtin.title}</span></>}{navigationPath(nodes, selected).map(node => <React.Fragment key={node.id}><span>/</span><button onClick={() => setSelected(node.id)}>{node.title}</button></React.Fragment>)}</div><button className="ui-btn ghost tiny" onClick={() => setFocus(!focus)}>{focus ? '退出专注' : '专注'}</button></header>
        <div className="ext-study-page-body">
          {builtin ? <div className="ext-study-web-preview"><builtin.icon size={40} /><h1>{builtin.title}</h1><p>{builtin.description}</p><small>现有工具入口 · 本页仅预览布局</small></div> : !active || active.kind === 'folder' ? <>
            <div className="ext-study-intro"><div className="ext-study-large-icon"><NavigationIcon kind="folder" open size={30} /></div><p className="ext-study-eyebrow">常用的放上面，其他的归好类</p><h1>{active?.title ?? '实用工具'}</h1><p>{shownChildren.length} 个入口 · 网页和扩展可以放在同一个文件夹</p></div>
            <div className="ext-study-cards">{shownChildren.map(node => <button key={node.id} className="ext-study-card" onClick={() => setSelected(node.id)}><span className="ext-study-card-icon"><NavigationIcon kind={node.kind} size={22} /></span><span><strong>{node.title}</strong><small>{node.kind === 'folder' ? `${navigationChildren(nodes, node.id).length} 个入口` : node.kind === 'web' ? new URL(node.url).hostname : node.description ?? '自定义扩展面板'}</small></span><span className="ext-study-card-arrow">↗</span></button>)}</div>
            {!shownChildren.length && <div className="ext-study-blank"><IconPlus size={24} /><p>把相关的入口拖进来</p><span>或右键文件夹，创建子文件夹</span></div>}
            <div className="ext-study-tips"><div><b>01</b><span><strong>常用的，一点就开</strong><small>列表入口的 ··· 菜单 → 添加到常用，出现在上方网格。</small></span></div><div><b>02</b><span><strong>网页和扩展，分组整理</strong><small>拖到文件夹中间入组，拖到边缘排序；支持子文件夹。</small></span></div><div><b>03</b><span><strong>同一个入口，两种找法</strong><small>添加常用后，原分组保留；改名同步，移除常用只收起快捷入口。</small></span></div></div>
          </> : active.kind === 'web' ? <>
            <div className="ext-study-address"><NavigationIcon kind="web" /><span>{active.url}</span><span>固定网页</span></div>
            <div className="ext-study-web-preview"><NavigationIcon kind="web" size={40} /><h1>{active.title}</h1><p>网页入口已固定</p><span>在侧栏移动或重命名，入口地址保持不变。</span><small>原型仅演示入口组织，未加载外部网站。</small></div>
          </> : <>
            <div className="ext-study-extension-heading"><span className="ext-study-large-icon"><NavigationIcon kind="extension" size={25} /></span><div><h1>{active.title}</h1><p>{active.description ?? '扩展工作面板'}</p></div><span className="ext-study-badge">扩展</span></div>
            {active.viewId === 'main' ? <label className="ext-study-note">工作笔记<textarea value={note} onChange={event => setNote(event.target.value)} /></label> : active.viewId === 'queue' ? <div className="ext-study-queue"><span>任务记录</span>{['整理素材索引', '生成文档预览', '同步工作目录'].map((name, index) => <div key={name}><span>{name}</span><small>{index === 0 ? '已完成' : '等待处理'}</small></div>)}<p>示例任务用于展示工作面板，不会执行本机命令。</p></div> : <div className="ext-study-assets"><div><strong>最近使用</strong><span>示例素材</span></div>{['项目封面.png', '片头-v03.mp4', '设计参考.pdf', '采访记录.md'].map((name, index) => <article key={name}><span className="ext-study-asset-symbol">{['▧', '▷', '▤', '≡'][index]}</span><div><strong>{name}</strong><small>创作空间 / 素材</small></div><small>{['图片', '视频', '文档', '笔记'][index]}</small></article>)}</div>}
          </>}
        </div>
        <footer className="ext-study-feedback"><span>{message}</span><button className="ui-btn ghost tiny" disabled={!history.length} onClick={() => { const previous = history.at(-1); if (!previous) return; setNodes(previous); setHistory(history.slice(0, -1)); setMessage('已撤销上一步'); if (selected && !previous.some(node => node.id === selected)) setSelected(null); }}>撤销</button></footer>
      </main>
      <aside className="ext-study-agent"><header><span className="ext-study-agent-dot" />Agent</header><div><span className="ext-study-eyebrow">保持在同一个工作空间</span><h2>工具在手边，<br />对话也在。</h2><p>打开网页或扩展面板时，这里依然可以与 Agent 协作。</p></div><div className="ext-study-agent-example">“把这几个网页放进一个文件夹，叫项目参考。”<span>界面示意 · 未连接模型</span></div></aside>
    </div>
  </div>;
}
