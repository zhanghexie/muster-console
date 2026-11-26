import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePresenceValue } from '../../../src/renderer/src/components/motion';
import './skills-manager.css';

type Target = 'claude' | 'codex' | 'cursor' | 'pi';
type Scope = 'global' | 'project';
type Page = 'skills' | 'mcp' | 'review';
type Asset = {
  id: string; name: string; description: string; kind: 'skill' | 'mcp';
  scope: 'global' | 'workbench' | 'playground'; path: string; origin: string;
  targets: Target[]; body: string; files: string[]; pending?: boolean;
  conflict?: boolean; preferred?: boolean; connection?: 'unverified' | 'connected' | 'auth';
};
const TARGETS: { id: Target; name: string; mark: string; mode: string }[] = [
  { id: 'claude', name: 'Claude Code', mark: 'C', mode: 'CLI' },
  { id: 'codex', name: 'Codex', mark: 'O', mode: 'CLI' },
  { id: 'cursor', name: 'Cursor', mark: '↗', mode: 'GUI' },
  { id: 'pi', name: 'Pi', mark: 'π', mode: 'SDK' }
];
const PROJECTS = { workbench: 'metaagent-workbench', playground: 'playground' };
const INITIAL: Asset[] = [
  { id: 'journal', name: 'journal', description: '记录工作日志，让项目进展有迹可循。', kind: 'skill', scope: 'workbench',
    path: 'E:/Projects/metaagent-workbench/.agents/skills/journal', origin: '项目原目录', targets: ['claude', 'codex', 'pi'],
    body: '---\nname: journal\ndescription: 记录项目工作日志\n---\n\n# 工作日志\n\n任务结束后，将问题、结论与验证结果记入 docs/journal/。\n保持项目已有格式，按需读取参考文件。', files: ['SKILL.md', 'references/format.md'] },
  { id: 'review', name: 'code-review', description: '审查变更，给出有证据的改进建议。', kind: 'skill', scope: 'global',
    path: 'C:/Users/demo/.agents/skills/code-review', origin: '用户原目录', targets: ['claude', 'codex', 'cursor'],
    body: '---\nname: code-review\ndescription: 审查代码变更\n---\n\n# 代码审查\n\n先理解变更目的，再检查行为、边界和回归证据。', files: ['SKILL.md'] },
  { id: 'frontend', name: 'frontend-design', description: '把界面想法变成清晰、可用的交互。', kind: 'skill', scope: 'global',
    path: 'C:/Users/demo/skills/frontend-design', origin: '本地技能库', targets: ['claude', 'cursor'],
    body: '---\nname: frontend-design\ndescription: 设计简洁的产品界面\n---\n\n# 界面设计\n\n内容优先，减少不必要的操作，先做可交互原型。', files: ['SKILL.md', 'assets/layout.svg'] },
  { id: 'perf', name: 'perf-trace', description: '采集性能线索，定位卡顿与长任务。', kind: 'skill', scope: 'workbench',
    path: 'E:/Projects/metaagent-workbench/.agents/skills/perf-trace', origin: '项目原目录', targets: ['claude', 'cursor'], conflict: true,
    body: '---\nname: perf-trace\ndescription: 性能采集与归因\n---\n\n# 性能排查\n\n先采集真实帧间隙与 CPU profile，再定位原因。', files: ['SKILL.md', 'scripts/capture.mjs'] },
  { id: 'perf-copy', name: 'perf-trace', description: '另一份本地版本，内容与项目技能不同。', kind: 'skill', scope: 'workbench',
    path: 'E:/Projects/metaagent-workbench/.claude/skills/perf-trace', origin: '外部副本', targets: [], conflict: true,
    body: '---\nname: perf-trace\ndescription: 旧版性能排查\n---\n\n# 性能排查\n\n运行旧采集脚本，输出文本摘要。', files: ['SKILL.md', 'scripts/legacy.mjs'] },
  { id: 'api', name: 'api-smoke', description: '验证接口的输入、输出与失败路径。', kind: 'skill', scope: 'playground',
    path: 'E:/Projects/playground/.agents/skills/api-smoke', origin: '项目原目录', targets: ['codex'],
    body: '---\nname: api-smoke\ndescription: 接口冒烟验证\n---\n\n# 接口验证\n\n检查响应结构和错误路径。', files: ['SKILL.md'] },
  { id: 'filesystem', name: 'filesystem', description: '在允许的目录里读写项目文件。', kind: 'mcp', scope: 'global',
    path: 'stdio · npx @modelcontextprotocol/server-filesystem', origin: '本地进程', targets: ['claude', 'codex', 'pi'],
    body: '{\n  "command": "npx",\n  "args": ["@modelcontextprotocol/server-filesystem", "E:/Projects"]\n}', files: [], connection: 'unverified' },
  { id: 'browser', name: 'browser-tools', description: '连接浏览器，查看页面和操作元素。', kind: 'mcp', scope: 'workbench',
    path: 'stdio · node browser-tools/server.mjs', origin: '项目配置', targets: ['cursor', 'pi'],
    body: '{\n  "command": "node",\n  "args": ["browser-tools/server.mjs"]\n}', files: [], connection: 'unverified' },
  { id: 'feishu', name: 'feishu', description: '读取授权范围内的消息与文档。', kind: 'mcp', scope: 'global',
    path: 'Streamable HTTP · https://example.invalid/feishu/mcp', origin: '远程服务', targets: ['claude', 'pi'],
    body: '{\n  "url": "https://example.invalid/feishu/mcp",\n  "auth": "oauth"\n}', files: [], connection: 'auth' }
];

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    skill: <><path d="M8 4H5v16h14V4h-3M9 3h6v4H9z"/><path d="m9 12 2 2 4-4M9 17h6"/></>,
    mcp: <><path d="M8 3v5m8-5v5M5 8h14v4a7 7 0 0 1-7 7v3M8 12h8"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    folder: <path d="M3 6h6l2 2h10v12H3z"/>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/></>,
    link: <><path d="m10 7 3-3a5 5 0 0 1 7 7l-3 3m-3 3-3 3a5 5 0 0 1-7-7l3-3m2 5 6-6"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
    arrow: <path d="m9 5 7 7-7 7"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    alert: <><path d="m12 3 10 18H2zM12 9v5"/><path d="M12 17h.01"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    file: <><path d="M5 3h9l5 5v13H5zM14 3v6h5"/><path d="M8 13h8M8 17h6"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3"/></>,
    edit: <><path d="m14 4 6 6M4 20l5-1L21 7l-6-6L3 13z"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.file}</svg>;
}
function Mark({ target }: { target: Target }) {
  const t = TARGETS.find(t => t.id === target)!;
  return <span className="sm-target-mark" title={t.name}>{t.mark}</span>;
}
function Modal({ title, value, onClose, children }: { title: string; value: unknown | null; onClose: () => void; children: ReactNode }) {
  const { presence } = usePresenceValue(value);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!value || !presence.mounted) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.querySelector<HTMLElement>('textarea, button, input')?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key !== 'Tab') return;
      const fields = Array.from(node?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, input, select, [tabindex="0"]') ?? []);
      const first = fields[0], last = fields[fields.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    node?.addEventListener('keydown', trap);
    return () => { node?.removeEventListener('keydown', trap); previous?.focus(); };
  }, [!!value, presence.mounted]);
  if (!presence.mounted) return null;
  return <div className="sm-modal-shade mp-scrim" {...presence.spread} aria-hidden={presence.stage === 'out'} onClick={() => value && onClose()}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="sm-modal mp-panel" {...presence.spread} onClick={e => e.stopPropagation()}>
      <div className="sm-modal-head"><h2>{title}</h2><button className="sm-icon-button" aria-label={`关闭${title}`} onClick={onClose}><Icon name="close"/></button></div>
      {children}
    </div>
  </div>;
}

function Detail({ asset, inherited, onClose, onGlobal, onUpdate, onEdit, onReview, onTest }: {
  asset: Asset; inherited: boolean; onClose: () => void; onGlobal: () => void;
  onUpdate: (asset: Asset) => void; onEdit: () => void; onReview: () => void; onTest: () => void;
}) {
  const [draft, setDraft] = useState(asset.targets);
  useEffect(() => setDraft(asset.targets), [asset.targets]);
  const dirty = TARGETS.some(t => draft.includes(t.id) !== asset.targets.includes(t.id));
  return <>
    <header className="sm-detail-head"><span className="sm-caption">{asset.kind === 'skill' ? '技能详情' : '服务器详情'}</span><button className="sm-icon-button" aria-label="关闭详情" onClick={onClose}><Icon name="close"/></button></header>
    <div className="sm-detail-title"><span className="sm-asset-icon"><Icon name={asset.kind === 'skill' ? 'skill' : 'mcp'} size={24}/></span><h2>{asset.name}</h2></div>
    <p className="sm-detail-description">{asset.description}</p>
    <div className={`sm-scope-note ${inherited ? 'is-inherited' : ''}`}>
      <Icon name={asset.scope === 'global' ? 'globe' : 'folder'} size={16}/>
      <div><strong>{inherited ? '来自全局' : asset.scope === 'global' ? '全局使用' : '仅当前项目'}</strong><span>{inherited ? '此处只读，关联设置由全局决定。' : asset.scope === 'global' ? '关联的 Agent 可在所有项目中发现它。' : '只关联到这个项目的 Agent 入口。'}</span></div>
      {inherited && <button className="sm-text-button" onClick={onGlobal}>在全局管理 <Icon name="arrow" size={12}/></button>}
    </div>
    <section className="sm-detail-section"><div className="sm-section-head"><h3>关联的 Agent</h3><span>{asset.targets.length} 个</span></div>
      <div className="sm-agent-options">{TARGETS.map(t => <label className={`sm-agent-option ${inherited ? 'is-readonly' : ''}`} key={t.id}>
        <input type="checkbox" aria-label={`关联 ${t.name}`} checked={draft.includes(t.id)} disabled={inherited} onChange={e => setDraft(prev => e.target.checked ? [...prev, t.id] : prev.filter(id => id !== t.id))}/>
        <Mark target={t.id}/><span className="sm-agent-name">{t.name}<small>{t.mode}</small></span><span className="sm-agent-state">{asset.targets.includes(t.id) ? asset.pending ? '待刷新' : '已关联' : '未关联'}</span>
      </label>)}</div>
      {!inherited && <button className="sm-button sm-button-solid sm-save-link" disabled={!dirty} onClick={() => onUpdate({ ...asset, targets: draft, pending: true })}>保存关联</button>}
      <p className="sm-fine">{asset.kind === 'skill' ? '关联到同一份技能内容，不创建重复副本。' : '关联表示已配置；是否能调用需在会话中验证。'}{asset.pending && ' 已更改，下一次启动或重连生效（示例）。'}</p>
    </section>
    <section className="sm-detail-section"><div className="sm-section-head"><h3>{asset.kind === 'skill' ? '内容来源' : '连接配置'}</h3><span>{asset.origin}</span></div>
      <div className="sm-source-path"><Icon name={asset.kind === 'skill' ? 'folder' : 'mcp'} size={16}/><code>{asset.path}</code></div>
      {asset.kind === 'skill' ? <>
        <div className="sm-file-list">{asset.files.map(file => <span key={file}><Icon name="file" size={14}/>{file}</span>)}</div>
        <button className="sm-button sm-edit-button" disabled={inherited} onClick={onEdit}><Icon name="edit" size={15}/>编辑 SKILL.md</button>
        <p className="sm-fine">编辑原文件，使用同一源的 Agent 都会读到修改。</p>
      </> : <><pre className="sm-config">{asset.body}</pre><button className="sm-button" onClick={onTest}><Icon name="refresh" size={15}/>模拟连接测试</button>
        <div className={`sm-connection ${asset.connection === 'connected' ? 'is-ok' : asset.connection === 'auth' ? 'is-warn' : ''}`} role="status">{asset.connection === 'connected' ? '示例握手成功 · 6 个工具可发现' : asset.connection === 'auth' ? '示例连接需要认证 · 尚未连接' : '尚未验证 · 配置存在不代表已连接'}</div></>}
    </section>
    {asset.conflict && <div className="sm-conflict-callout"><Icon name="alert"/><div><strong>发现同名的另一份内容</strong><p>{asset.preferred ? '已保存使用偏好，外部目录中的另一份内容仍需处理。' : '保留两份文件，先比较再决定使用哪份。'}</p><button className="sm-text-button" onClick={onReview}>查看内容差异 <Icon name="arrow" size={12}/></button></div></div>}
  </>;
}

export function SkillsManagerPrototype() {
  const [assets, setAssets] = useState<Asset[]>(() => structuredClone(INITIAL));
  const [scope, setScope] = useState<Scope>('project');
  const [project, setProject] = useState<'workbench' | 'playground'>('workbench');
  const [page, setPage] = useState<Page>('skills');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Target | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(() => typeof window !== 'undefined' && window.innerWidth >= 980 ? 'journal' : null);
  const [notice, setNotice] = useState('');
  const [demoOpen, setDemoOpen] = useState(false);
  const [theme, setTheme] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark');
  const [editor, setEditor] = useState<{ id: string; body: string } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewChoice, setReviewChoice] = useState('perf');
  const [narrow, setNarrow] = useState(() => window.innerWidth < 980);
  const detailRef = useRef<HTMLElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const selected = assets.find(a => a.id === selectedId) ?? null;
  const detail = usePresenceValue(selected);
  const editorPresence = usePresenceValue(editor);
  const demoPresence = usePresenceValue(demoOpen ? 'demo' : null);
  const inScope = assets.filter(a => scope === 'global' ? a.scope === 'global' : a.scope === 'global' || a.scope === project);
  const conflicts = inScope.filter(a => a.conflict);
  const listed = inScope.filter(a => (page === 'review' ? a.conflict : a.kind === (page === 'skills' ? 'skill' : 'mcp'))
    && (filter === 'all' || a.targets.includes(filter))
    && `${a.name} ${a.description} ${a.origin} ${a.path}`.toLowerCase().includes(query.toLowerCase()));
  const local = listed.filter(a => a.scope !== 'global');
  const inherited = listed.filter(a => a.scope === 'global');
  const title = page === 'skills' ? 'Skills' : page === 'mcp' ? 'MCP 服务器' : '待处理差异';
  const demoAsset = assets.find(a => a.id === 'release-notes');
  const perfA = assets.find(a => a.id === 'perf')!;
  const perfB = assets.find(a => a.id === 'perf-copy')!;

  const closeDetail = () => setSelectedId(null);
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth < 980);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!narrow || !selectedId || !detail.presence.mounted) return;
    const node = detailRef.current;
    node?.querySelector<HTMLButtonElement>('button')?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const fields = Array.from(node?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, textarea, [tabindex="0"]') ?? []);
      const first = fields[0], last = fields[fields.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    node?.addEventListener('keydown', trap);
    return () => {
      node?.removeEventListener('keydown', trap);
      if (detailTrigger.current?.isConnected) detailTrigger.current.focus();
      else document.querySelector<HTMLButtonElement>('button[aria-pressed="true"].sm-asset-row')?.focus();
    };
  }, [narrow, selectedId, detail.presence.mounted]);
  const changeContext = (s: Scope, p = page) => { setScope(s); setPage(p); setSelectedId(null); setQuery(''); setFilter('all'); setDemoOpen(false); };
  const update = (a: Asset) => { setAssets(prev => prev.map(item => item.id === a.id ? a : item)); setNotice(`已保存 ${a.name} 的关联 · 新会话生效（示例）`); };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (demoOpen) { setDemoOpen(false); return; }
      if (editor || reviewOpen) return;
      closeDetail();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [demoOpen, editor, reviewOpen]);
  const simulate = () => {
    detailTrigger.current = null;
    const demoScope = scope === 'global' ? 'global' : project;
    if (!demoAsset) setAssets(prev => [...prev, {
      id: 'release-notes', name: 'release-notes', description: '根据项目变更整理发布说明。', kind: 'skill', scope: demoScope,
      path: demoScope === 'global' ? 'C:/Users/demo/.claude/skills/release-notes' : `E:/Projects/${PROJECTS[project]}/.claude/skills/release-notes`,
      origin: demoScope === 'global' ? '用户原目录' : '项目原目录', targets: ['claude'],
      body: '---\nname: release-notes\ndescription: 整理项目发布说明\n---\n\n# 发布说明\n\n读取本次变更，整理用户可见的改进与修复。', files: ['SKILL.md'], pending: true
    }]);
    else setScope(demoAsset.scope === 'global' ? 'global' : 'project');
    if (demoAsset && demoAsset.scope !== 'global') setProject(demoAsset.scope);
    setPage('skills'); setFilter('all'); setQuery(''); setSelectedId('release-notes'); setDemoOpen(false);
    setNotice('已发现 release-notes · 原地引用，保留原作用范围（模拟）');
  };
  const reset = () => { setAssets(structuredClone(INITIAL)); changeContext('project', 'skills'); setProject('workbench'); setNotice('示例数据已重置'); };
  const switchTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next);
    (window as Window & { setSkillsPrototypeTheme?: (t: string) => void }).setSkillsPrototypeTheme?.(next);
  };
  const row = (a: Asset) => <button key={a.id} className={`sm-asset-row ${a.id === selectedId ? 'is-selected' : ''}`} aria-label={`查看 ${a.name}${a.id === 'perf-copy' ? ' 外部副本' : ''}`} aria-pressed={a.id === selectedId} onClick={e => { detailTrigger.current = e.currentTarget; setSelectedId(a.id); setDemoOpen(false); }}>
    <span className="sm-row-icon"><Icon name={a.kind === 'skill' ? 'skill' : 'mcp'} size={20}/></span>
    <span className="sm-row-content"><span className="sm-row-name">{a.name}{a.conflict && <span className="sm-badge is-warn">内容不同</span>}{a.preferred && <span className="sm-badge">优先内容</span>}{a.id === 'release-notes' && <span className="sm-badge is-ok">新发现</span>}</span><span className="sm-row-description">{a.description}</span><span className="sm-row-meta">{a.origin}{a.kind === 'skill' ? ' · 原地引用' : ` · ${a.path.startsWith('stdio') ? 'stdio' : 'HTTP'}`}</span></span>
    <span className="sm-row-targets" aria-label={`${a.targets.length} 个 Agent 关联`}>{a.targets.length ? a.targets.map(t => <Mark key={t} target={t}/>) : <span className="sm-no-target">未关联</span>}</span>
    <Icon name="arrow" size={14}/>
  </button>;

  return <div className="sm-prototype" data-theme={theme}>
    <header className="sm-window-bar"><div className="sm-brand"><span className="sm-brand-mark">M</span><span>MetaAgent</span><span className="sm-window-divider">/</span><span className="sm-window-label">能力管理</span></div><div className="sm-window-actions"><span className="sm-prototype-badge">交互原型 · 示例数据</span><button className="sm-icon-button" aria-label="切换主题" title="切换深浅主题" onClick={switchTheme}><Icon name="sun" size={17}/></button></div></header>
    <div className="sm-workbench">
      <aside className="sm-navigation"><div className="sm-nav-caption">管理</div><nav aria-label="管理分类">{([
        ['skills', 'skill', 'Skills'], ['mcp', 'mcp', 'MCP'], ['review', 'alert', '待处理差异']
      ] as const).map(([id, icon, label]) => <button key={id} aria-current={page === id ? 'page' : undefined} onClick={() => changeContext(scope, id)} className={`sm-nav-item ${page === id ? 'is-active' : ''}`}><Icon name={icon}/><span>{label}</span><span className={id === 'review' && conflicts.length ? 'sm-nav-count is-warn' : 'sm-nav-count'}>{id === 'review' ? conflicts.length ? '1' : '0' : inScope.filter(a => a.kind === (id === 'skills' ? 'skill' : 'mcp')).length}</span></button>)}</nav>
        <div className="sm-nav-foot"><Icon name="link" size={17}/><strong>一份内容，多处使用</strong><p>已登记目录里的 CLI 技能，会自动出现在这里。</p><span>原型操作仅改变示例数据</span></div>
      </aside>
      <main className="sm-sheet">
        <div className="sm-page-top"><div><div className="sm-eyebrow">能力库 <span>/</span> {scope === 'global' ? '全局' : PROJECTS[project]}</div><h1>{title}</h1><p>{page === 'skills' ? '把技能放在合适的范围，让每个 Agent 都能找到它。' : page === 'mcp' ? '统一查看服务器配置，以及各 Agent 的关联情况。' : '同名技能有不同内容，先比较，再选择使用的版本。'}</p></div>
          <div className="sm-demo-wrap"><button className="sm-button" aria-expanded={demoOpen} aria-controls="sm-demo-menu" onClick={() => setDemoOpen(!demoOpen)}><Icon name="plus" size={15}/>试一下</button>
            {demoPresence.presence.mounted && <div id="sm-demo-menu" className="sm-demo-menu mp-pop" {...demoPresence.presence.spread}>
              <span className="sm-caption">演示外部变化</span><button onClick={simulate}>模拟 CLI 新建技能 <small>在 Claude {scope === 'global' ? '用户' : '项目'}目录创建</small></button><button onClick={reset}>重置示例数据</button>
            </div>}
          </div>
        </div>
        <div className="sm-scope-bar"><div className="sm-scope-switch" role="group" aria-label="作用范围"><button aria-pressed={scope === 'global'} onClick={() => changeContext('global')}><Icon name="globe" size={16}/>全局</button><button aria-pressed={scope === 'project'} onClick={() => changeContext('project')}><Icon name="folder" size={16}/>当前项目</button></div>
          {scope === 'project' && <select aria-label="选择项目" value={project} onChange={e => { setProject(e.target.value as typeof project); changeContext('project'); }}><option value="workbench">metaagent-workbench</option><option value="playground">playground</option></select>}
          <span className="sm-scope-hint">{scope === 'global' ? '所有项目可用' : '包含从全局继承的内容'}</span>
        </div>
        <div className="sm-manager-grid">
          <div className="sm-inventory"><div className="sm-list-tools"><label className="sm-search"><Icon name="search" size={17}/><input aria-label="搜索能力" placeholder={page === 'mcp' ? '搜索服务器…' : '搜索技能…'} value={query} onChange={e => setQuery(e.target.value)}/>{query && <button aria-label="清空搜索" onClick={() => setQuery('')}><Icon name="close" size={13}/></button>}</label><select aria-label="按 Agent 筛选" value={filter} onChange={e => setFilter(e.target.value as typeof filter)}><option value="all">所有 Agent</option>{TARGETS.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
            {listed.length === 0 ? <div className="sm-empty"><Icon name="search" size={28}/><h3>没有匹配的{page === 'mcp' ? '服务器' : '技能'}</h3><p>试试其他关键词，或切换作用范围。</p></div> : <>
              {scope === 'project' && local.length > 0 && <section aria-label="项目能力"><div className="sm-list-heading"><span>{page === 'review' ? '同名不同内容' : '仅当前项目'} <small>{local.length}</small></span><span>关联的 Agent</span></div>{local.map(row)}</section>}
              {inherited.length > 0 && <section aria-label="全局能力"><div className="sm-list-heading"><span>{scope === 'project' ? '来自全局' : '全局使用'} <small>{inherited.length}</small></span><span>{scope === 'project' ? '全局继承' : '关联的 Agent'}</span></div>{inherited.map(row)}</section>}
            </>}
            <div className="sm-list-bottom"><Icon name="link" size={14}/><span>{listed.length} 项内容 · 关联指向原文件</span><span>示例发现目录</span></div>
          </div>
          {detail.presence.mounted && detail.value ? <aside ref={detailRef} className="sm-detail mp-panel" {...detail.presence.spread} aria-label="能力详情" aria-hidden={detail.presence.stage === 'out'} role={narrow ? 'dialog' : undefined} aria-modal={narrow ? true : undefined}><Detail key={detail.value.id} asset={detail.value} inherited={scope === 'project' && detail.value.scope === 'global'} onClose={closeDetail} onGlobal={() => { setScope('global'); setQuery(''); setFilter('all'); }} onUpdate={update} onEdit={() => setEditor({ id: detail.value!.id, body: detail.value!.body })} onReview={() => { setReviewChoice(detail.value!.id); setReviewOpen(true); }} onTest={() => {
            const a = detail.value!; if (a.connection === 'auth') { setNotice('模拟结果：feishu 需要登录认证，尚未连接'); return; }
            setAssets(prev => prev.map(item => item.id === a.id ? { ...item, connection: 'connected' } : item)); setNotice(`模拟结果：${a.name} 握手成功，6 个工具可发现`);
          }}/></aside> : <aside className="sm-detail-empty"><span className="sm-empty-orbit"><Icon name="link" size={25}/></span><h3>从一份内容开始</h3><p>选择一项，查看它的来源<br/>和各 Agent 的使用关系。</p></aside>}
          {detail.presence.mounted && <button className="sm-mobile-scrim mp-scrim" {...detail.presence.spread} aria-label="收起详情" aria-hidden={detail.presence.stage === 'out'} tabIndex={-1} onClick={closeDetail}/>}
        </div>
        <footer className="sm-status-bar"><span className="sm-status-dot"/><span role="status">{notice || '目录发现、关联与连接状态均为原型示例'}</span></footer>
      </main>
    </div>
    <Modal title="编辑技能" value={editor} onClose={() => setEditor(null)}>
      <div className="sm-editor-meta"><Icon name="file" size={17}/><span>{assets.find(a => a.id === editorPresence.value?.id)?.name}/SKILL.md</span><span className="sm-badge">原地编辑</span></div>
      <p className="sm-modal-description">修改同一份内容，所有关联的 Agent 在刷新后读取新版本。</p>
      <textarea aria-label="技能正文" className="sm-editor" spellCheck={false} value={editorPresence.value?.body ?? ''} onChange={e => setEditor(prev => prev && { ...prev, body: e.target.value })}/>
      <div className="sm-modal-footer"><span>示例编辑，不写入本机文件</span><button className="sm-button" onClick={() => setEditor(null)}>取消</button><button className="sm-button sm-button-solid" disabled={!editor?.body.trim()} onClick={() => {
        if (!editor) return; setAssets(prev => prev.map(a => a.id === editor.id ? { ...a, body: editor.body, pending: true } : a)); setNotice('技能内容已保存 · 关联的 Agent 刷新后读取（示例）'); setEditor(null);
      }}>保存内容</button></div>
    </Modal>
    <Modal title="比较同名技能" value={reviewOpen ? 'review' : null} onClose={() => setReviewOpen(false)}>
      <p className="sm-modal-description">两份 perf-trace 内容不同。先保存当前项目的使用偏好，CLI 原目录中的重复内容仍需处理。</p>
      <div className="sm-compare-grid">{[perfA, perfB].map(a => <label className={`sm-compare-card ${reviewChoice === a.id ? 'is-selected' : ''}`} key={a.id}><span><input type="radio" name="version" aria-label={`选用${a.id === 'perf' ? '项目原目录' : '外部副本'}`} checked={reviewChoice === a.id} onChange={() => setReviewChoice(a.id)}/><strong>{a.origin}</strong></span><code>{a.path}</code><pre>{a.body}</pre></label>)}</div>
      <div className="sm-modal-footer"><span>不移动或删除原文件</span><button className="sm-button" onClick={() => setReviewOpen(false)}>稍后处理</button><button className="sm-button sm-button-solid" onClick={() => {
        setAssets(prev => prev.map(a => ['perf', 'perf-copy'].includes(a.id) ? { ...a, preferred: a.id === reviewChoice } : a)); setSelectedId(reviewChoice); setReviewOpen(false); setPage('skills'); setQuery(''); setFilter('all'); setNotice('已保存使用偏好 · 外部目录中的重复内容仍需处理（示例）');
      }}>保存使用偏好</button></div>
    </Modal>
  </div>;
}
