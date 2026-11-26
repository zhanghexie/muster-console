import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MOTION, usePresence, usePresenceValue } from '../../../src/renderer/src/components/motion';
import { useInteractionPreferences, prefersReducedMotionPreference } from '../../../src/renderer/src/interactionPreferences';
import lumiaFrame from '../../../src/renderer/src/agentApps/assets/lumia-930-yellow.png';

type AppId = 'tasks' | 'messages' | 'rss' | 'home';
type Task = { id: string; title: string; note: string; when: string; done: boolean };
type Message = { text: string; mine?: boolean; time: string };
type Contact = { id: string; name: string; role: string; unread: number; messages: Message[] };
type Article = { id: string; source: string; title: string; summary: string; read: boolean; saved: boolean; date: string };
type Data = { tasks: Task[]; contacts: Contact[]; articles: Article[] };
type Route = { type: 'task'; id: string } | { type: 'newTask' } | { type: 'thread'; id: string } | { type: 'newMessage' } | { type: 'article'; id: string } | { type: 'sources' };
const KEY = 'metaagent.metro-prototype.v1';
export const initialData: Data = {
  tasks: [
    { id: 't1', title: '整理应用平台的第一版设计', note: '把能力分层与界面规范整理成一份可以讨论的草案。', when: '今天', done: false },
    { id: 't2', title: '回复林予安的设计反馈', note: '确认下午的评审时间，并带上三个应用的界面原型。', when: '今天', done: false },
    { id: 't3', title: '读完收藏的两篇文章', note: '记录值得留在下一版设计里的细节。', when: '今天', done: false },
    { id: 't4', title: '检查构建结果', note: '等待构建完成后，核对产物和回归结果。', when: '稍后', done: false },
    { id: 't5', title: '梳理外部消息的处理方式', note: '邮件与短信保持独立，统一消息提醒。', when: '今天', done: true },
  ],
  contacts: [
    { id: 'c1', name: '林予安', role: '产品设计', unread: 2, messages: [
      { text: '早上好，应用的第一版设计有进展了吗？', time: '09:12' },
      { text: '待办、短信和阅读器已经有了初稿。我正在统一它们的排版。', mine: true, time: '09:18' },
      { text: '太好了。先看最常用的页面就行，功能可以慢慢补。', time: '10:08' },
      { text: '下午三点一起看一下？我想重点看看短信的阅读体验。', time: '10:24' },
    ] },
    { id: 'c2', name: '陈默', role: '工程协作', unread: 1, messages: [
      { text: '新的构建已经完成，测试报告也放好了。你方便时看一下。', time: '09:56' },
    ] },
    { id: 'c3', name: '设计讨论组', role: '群聊 · 4 人', unread: 0, messages: [
      { text: '把标题放大一点，让内容自己说话。', time: '昨天' },
      { text: '收到，我会在原型里试两种信息密度。', mine: true, time: '昨天' },
    ] },
    { id: 'c4', name: '周宁', role: '研究伙伴', unread: 0, messages: [
      { text: '分享的那篇文章很有启发，尤其是关于注意力的部分。', time: '昨天' },
    ] },
  ],
  articles: [
    { id: 'a1', source: '界面手记', title: '让工具退后，\n让内容向前。', summary: '好的界面不需要不断解释自己。文字、留白和清楚的层级，已经能让阅读变得轻松。', read: false, saved: false, date: '10:16' },
    { id: 'a2', source: '技术观察', title: '当 AI 开始管理自己的时间', summary: '一次提醒，把尚未完成的工作连接到未来。', read: false, saved: false, date: '09:40' },
    { id: 'a3', source: '产品札记', title: '一个收件箱，不必装下所有事情', summary: '把信息和责任分开，是持续工作的开始。', read: false, saved: true, date: '08:32' },
    { id: 'a4', source: '界面手记', title: '重新发现列表的秩序', summary: '少一些容器，多一点清晰的排版。', read: true, saved: true, date: '昨天' },
  ],
};

const titles: Record<AppId, string> = { tasks: '待办', messages: '短信', rss: '阅读', home: '开始' };
const sourceNames = ['界面手记','技术观察','产品札记'];
export function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    plus: <path d="M12 4v16M4 12h16"/>, back: <path d="m14 5-7 7 7 7M7 12h14"/>,
    check: <path d="m5 12 4 4L19 6"/>, search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
    send: <path d="m3 4 18 8-18 8 3-8-3-8Zm3 8h15"/>,
    home: <><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/></>,
    messages: <path d="M3 4h18v13H10l-5 4v-4H3zM7 8h10M7 12h7"/>,
    tasks: <><path d="M9 5h12M9 12h12M9 19h12m-19-14 2 2 3-4m-5 9 2 2 3-4m-5 9 2 2 3-4"/></>,
    rss: <><circle cx="5" cy="19" r="1"/><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/></>,
    bookmark: <path d="M6 3h12v18l-6-4-6 4z"/>, refresh: <><path d="M20 8a9 9 0 1 0 0 8M20 3v5h-5"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>, mail: <><path d="M3 5h18v14H3zM3 5l9 8 9-8"/></>,
    more: <><circle cx="4" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="20" cy="12" r="1"/></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{paths[name] || paths.plus}</svg>;
}
function Command({ icon, label, onClick, disabled = false }: { icon: string; label: string; onClick: () => void; disabled?: boolean }) {
  return <button className="command" onClick={onClick} disabled={disabled}><span className="command-circle"><Icon name={icon}/></span><span>{label}</span></button>;
}
function Pivot({ value, values, onChange }: { value: string; values: string[]; onChange: (v: string) => void }) {
  return <nav className="pivot" aria-label="内容分类">{values.map(v => <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>{v}</button>)}</nav>;
}
function ScreenHeader({ title, eyebrow = 'METAAGENT', back }: { title: string; eyebrow?: string; back?: () => void }) {
  return <header className="app-heading">{back ? <button className="back-link" aria-label="返回列表" onClick={back}><Icon name="back"/>{eyebrow}</button> : <div className="app-eyebrow">{eyebrow}</div>}<h2>{title}</h2></header>;
}
function loadData(): Data {
  try { const raw = JSON.parse(localStorage.getItem(KEY) || 'null'); if (raw?.tasks?.length && raw.contacts?.length && raw.articles?.length) return raw; } catch { /* Local demo can start fresh. */ }
  return structuredClone(initialData);
}

export function MetroApps({ persist = true }: { persist?: boolean }) {
  const [data, setData] = useState<Data>(() => persist ? loadData() : structuredClone(initialData));
  const [theme, setTheme] = useState('dark');
  const [single, setSingle] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1000);
  const [selected, setSelected] = useState<AppId>('tasks');
  const [accent, setAccent] = useState('#00a4ef');
  const [error, setError] = useState('');
  useEffect(() => { if (persist) { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { setError('浏览器无法保存演示数据，本次修改仅在当前页面保留。'); } } }, [data, persist]);
  return <main className="metro-study" style={{ '--accent': accent } as React.CSSProperties}>
    <header className="study-header"><div><div className="study-kicker"><span className="brand-mark">m</span>METAAGENT <span className="kicker-rule"/> APP STUDIES / 01</div><h1>调度的随身应用<span>.</span></h1><p>三个应用，一种秩序。Windows Phone 风格探索。</p></div>
      <div className="study-controls"><div className="mode-controls"><button aria-pressed={!single} onClick={() => setSingle(false)}>三屏对照</button><button aria-pressed={single} onClick={() => setSingle(true)}>单屏体验</button></div><div className="appearance-controls"><button className="theme-control" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '◐ 浅色模式' : '◑ 深色模式'}</button><span className="swatches">{['#00a4ef', '#a4c400', '#d80073'].map((c, i) => <button key={c} aria-label={['蓝色强调色', '绿色强调色', '洋红强调色'][i]} aria-pressed={accent === c} style={{ background: c }} onClick={() => setAccent(c)}/>)}</span></div></div>
    </header>
    {single && <nav className="single-switch" aria-label="选择应用">{(['home','tasks','messages','rss'] as AppId[]).map(a => <button key={a} aria-pressed={selected === a} onClick={() => setSelected(a)}>{titles[a]}</button>)}</nav>}
    <section className={`phone-gallery ${single ? 'single' : ''}`} aria-label="手机应用原型">
      {(single ? [selected] : ['tasks', 'messages', 'rss'] as AppId[]).map((app, index) => <div className="phone-column" key={single ? 'single' : app}>
        <div className="column-caption"><span>0{single ? 1 : index + 1} / {titles[app]}</span><span>{app === 'tasks' ? '留住每一个承诺' : app === 'messages' ? '与真实世界对话' : app === 'home' ? '我的应用' : '让新知自然抵达'}</span></div>
        <Phone initialApp={app} data={data} setData={setData} theme={theme}/>
      </div>)}
      {single && <aside className="single-note"><span className="study-kicker">GLANCE & GO</span><h2>熟悉的黄色。<br/>新的随身应用。</h2><p>大标题、横向分类、平面列表，<br/>还有熟悉的 Windows Phone 飞入。</p><p>底部 Windows 键回到开始屏。<br/>返回键退回上一层，搜索键查找当前内容。</p><span className="note-line"/></aside>}
    </section>
    <footer className="study-footer"><span>可点击原型 · 人物、消息与文章均为演示内容 · 不发送真实消息</span><button onClick={() => { setData(structuredClone(initialData)); setError(''); }}>重置演示数据 ↺</button></footer>
    {error && <p className="storage-error" role="alert">{error}</p>}
  </main>;
}

// Delays are bounded even when a demo list grows. Keep this cap aligned with metro.css.
const FEATHER_STEPS = 7;
const FLIGHT_EXIT_MS = MOTION.exitMs + FEATHER_STEPS * MOTION.staggerMs / 2;
const FLIGHT_ENTER_MS = MOTION.menuMs + MOTION.moveMs + FEATHER_STEPS * MOTION.staggerMs;
type PhoneData = { data: Data; setData: React.Dispatch<React.SetStateAction<Data>> };
type SourceSelection = { sources: string[]; setSources: React.Dispatch<React.SetStateAction<string[]>> };
type AppControls = { back: () => boolean; search: () => void; reset: () => void };
type ControlsRef = React.MutableRefObject<Partial<Record<AppId, AppControls>>>;
type Navigation = { app: AppId; direction: 'forward' | 'back'; turn: number; returnTo: AppId };

function Phone({ initialApp, data, setData, theme }: PhoneData & { initialApp: AppId; theme: string }) {
  const [nav, setNav] = useState<Navigation>({ app: initialApp, direction: 'forward', turn: 0, returnTo: initialApp });
  const [sources, setSources] = useState(sourceNames);
  const controls = useRef<Partial<Record<AppId, AppControls>>>({});
  const changeApp = (next: AppId) => setNav(previous => next === previous.app ? previous : ({
    app: next, direction: next === 'home' ? 'back' : 'forward', turn: previous.turn + 1,
    returnTo: next === 'home' ? previous.app : next,
  }));
  const requestedApp = useRef(initialApp);
  useLayoutEffect(() => {
    if (requestedApp.current !== initialApp) { requestedApp.current = initialApp; changeApp(initialApp); }
  }, [initialApp]);
  function hardwareBack() {
    if (controls.current[nav.app]?.back()) return;
    if (nav.app !== 'home') changeApp('home');
    else if (nav.returnTo !== 'home') changeApp(nav.returnTo);
  }
  function hardwareHome() { controls.current[nav.app]?.reset(); changeApp('home'); }
  return <section className="phone" data-theme={theme} aria-label={titles[initialApp] + '应用'}>
    <div className="lumia-hardware" aria-hidden="true"><img src={lumiaFrame} alt="" className="lumia-frame" draggable={false}/></div>
    <div className="phone-display">
    <div className="phone-status"><span>我的应用</span><span className="phone-status-right"><span className="signal-bars" aria-hidden="true">▂▄▆</span><span className="battery"/>10:28</span></div>
    <div className="app-stage">
      {(['home', 'tasks', 'messages', 'rss'] as AppId[]).map(app => <AppScene key={app} app={app} nav={nav}>
        <AppScreen app={app} data={data} setData={setData} changeApp={changeApp} sources={sources} setSources={setSources} controlsRef={controls}/>
      </AppScene>)}
    </div>
    </div>
    <nav className="hardware-nav" aria-label="手机按键">
      <button aria-label="手机返回" title="返回" onClick={hardwareBack}/>
      <button aria-label="Home 开始屏" title="Home · 开始屏" onClick={hardwareHome}/>
      <button aria-label="手机搜索" title="搜索当前内容" onClick={() => controls.current[nav.app]?.search()}/>
    </nav>
  </section>;
}

function AppScene({ app, nav, children }: { app: AppId; nav: Navigation; children: React.ReactNode }) {
  const active = app === nav.app;
  const presence = usePresence(active, FLIGHT_EXIT_MS);
  useInteractionPreferences();
  const reduced = prefersReducedMotionPreference();
  const [settledTurn, setSettledTurn] = useState(nav.turn);
  const sceneRef = useRef<HTMLDivElement>(null);
  const moving = !reduced && nav.turn !== settledTurn;
  useEffect(() => {
    if (reduced) { setSettledTurn(nav.turn); return; }
    if (!moving || !active) return;
    const timer = window.setTimeout(() => setSettledTurn(nav.turn), FLIGHT_ENTER_MS);
    return () => window.clearTimeout(timer);
  }, [moving, active, nav.turn, reduced]);
  useLayoutEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.inert = !active;
    if (active && nav.turn > 0) {
      const entry = app === 'home' ? scene.querySelector<HTMLElement>(`[data-open-app="${nav.returnTo}"]`) : null;
      (entry || scene.querySelector<HTMLElement>('.detail-page[data-mp-stage="in"]') || scene.querySelector<HTMLElement>('.app-page') || scene).focus({ preventScroll: true });
    }
  }, [active, presence.mounted, nav.turn, app, nav.returnTo]);
  if (!presence.mounted) return null;
  return <div className="metro-scene mp-panel" ref={sceneRef} tabIndex={-1} {...presence.spread}
    data-app={app} data-active={active} data-direction={nav.direction} data-flight={moving ? 'moving' : 'idle'}
    aria-hidden={active ? undefined : true}>
    {children}
  </div>;
}

function AppScreen({ app, data, setData, changeApp, sources, setSources, controlsRef }: PhoneData & SourceSelection & { app: AppId; changeApp: (app: AppId) => void; controlsRef: ControlsRef }) {
  const [tab, setTab] = useState('');
  const [route, setRoute] = useState<Route | null>(null);
  const layer = usePresenceValue(route);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const mainRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  function open(r: Route) { lastFocus.current = document.activeElement as HTMLElement; setRoute(r); }
  function close() { setRoute(null); }
  useLayoutEffect(() => {
    const actions: AppControls = {
      back: () => {
        if (route) { close(); return true; }
        if (searching) { setSearching(false); setQuery(''); return true; }
        return false;
      },
      search: () => { close(); setQuery(''); setSearching(true); mainRef.current?.querySelector<HTMLInputElement>('.search-field input')?.focus(); },
      reset: () => { close(); setSearching(false); setQuery(''); },
    };
    controlsRef.current[app] = actions;
    return () => { if (controlsRef.current[app] === actions) delete controlsRef.current[app]; };
  }, [app, route, searching, controlsRef]);
  useEffect(() => { const el = mainRef.current; if (el) el.inert = !!route;
    if (route) detailRef.current?.focus();
    else if (searching) el?.querySelector<HTMLInputElement>('.search-field input')?.focus();
    else if (lastFocus.current) { (lastFocus.current.isConnected ? lastFocus.current : el)?.focus(); lastFocus.current = null; }
    return () => { if (el) el.inert = false; };
  }, [route, searching]);
  const toggleTask = (id: string) => setData(d => ({ ...d, tasks: d.tasks.map(t => t.id === id ? { ...t, done: !t.done } : t) }));
  const saveArticle = (id: string) => setData(d => ({ ...d, articles: d.articles.map(a => a.id === id ? { ...a, saved: !a.saved } : a) }));
  function addArticleTask(a: Article) { setData(d => d.tasks.some(t => t.id === 'article-' + a.id) ? d : ({ ...d, tasks: [...d.tasks, { id: 'article-' + a.id, title: '阅读：' + a.title.replace('\n',''), note: a.summary, when: '稍后', done: false }] })); setNotice('已加入待办 · 稍后'); }
  const activeTab = tab || (app === 'tasks' ? '今天' : app === 'messages' ? '全部' : '未读');
  const matchesApp = (name: string) => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const taskList = data.tasks.filter(t => (activeTab === '已完成' ? t.done : !t.done && t.when === activeTab) && (t.title + t.note).includes(query));
  const contacts = data.contacts.filter(c => (activeTab !== '未读' || c.unread > 0) && (c.name + c.messages.map(m => m.text).join('')).includes(query));
  const articles = data.articles.filter(a => sources.includes(a.source) && (activeTab === '全部' || activeTab === '收藏' && a.saved || activeTab === '未读' && !a.read) && (a.title + a.summary + a.source).includes(query));
  const visibleRoute = layer.value;
  const task = visibleRoute?.type === 'task' ? data.tasks.find(t => t.id === visibleRoute.id) : undefined;
  const contact = visibleRoute?.type === 'thread' ? data.contacts.find(c => c.id === visibleRoute.id) : undefined;
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, [contact?.id, contact?.messages.length]);
  const article = visibleRoute?.type === 'article' ? data.articles.find(a => a.id === visibleRoute.id) : undefined;
  const openThread = (c: Contact) => { setData(d => ({ ...d, contacts: d.contacts.map(x => x.id === c.id ? { ...x, unread: 0 } : x) })); open({ type: 'thread', id: c.id }); };
  return <div className="app-surface" onKeyDown={e => { if (e.key === 'Escape') { if (route) close(); else if (searching) {setSearching(false); setQuery('');} else changeApp('home'); } }}>
    <div className="app-page" ref={mainRef} tabIndex={-1} aria-hidden={route ? true : undefined}>
      <ScreenHeader title={titles[app]} eyebrow={app === 'messages' ? '消息 · 飞书' : app === 'rss' ? 'RSS READER' : app === 'home' ? 'MY SPACE' : 'MY TASKS'}/>
      {app !== 'home' && <Pivot value={activeTab} values={app === 'tasks' ? ['今天','稍后','已完成'] : app === 'messages' ? ['全部','未读'] : ['未读','收藏','全部']} onChange={setTab}/>}
      {searching && <div className="search-field"><Icon name="search"/><input aria-label="搜索内容" placeholder="搜索" value={query} onChange={e => setQuery(e.target.value)} autoFocus/></div>}
      <div className="app-scroll">
        {app === 'home' ? <div className="tiles">
          <button className="tile tile-wide" hidden={!matchesApp('待办 任务 todo')} data-open-app="tasks" onClick={() => changeApp('tasks')}><Icon name="tasks"/><strong>{data.tasks.filter(t => !t.done).length}</strong><span>待办</span><p>整理应用平台的第一版设计</p></button>
          <button className="tile" hidden={!matchesApp('短信 消息 飞书 message')} data-open-app="messages" onClick={() => changeApp('messages')}><Icon name="messages"/><strong>{data.contacts.reduce((n,c) => n + c.unread, 0)}</strong><span>短信</span></button>
          <button className="tile" hidden={!matchesApp('阅读 订阅 rss')} data-open-app="rss" onClick={() => changeApp('rss')}><Icon name="rss"/><strong>{data.articles.filter(a => !a.read).length}</strong><span>阅读</span></button>
          <button className="tile tile-future" hidden={!matchesApp('闹钟 提醒 alarm')} disabled><Icon name="clock"/><span>闹钟<small>下一版</small></span></button>
          <button className="tile tile-future" hidden={!matchesApp('邮箱 邮件 mail')} disabled><Icon name="mail"/><span>邮箱<small>下一版</small></span></button>
        </div> : app === 'tasks' ? <><div className="section-intro"><span>10 月 23 日，星期五</span><span>{taskList.length} 项</span></div><div className="task-list">{taskList.map(t => <div className="task-row" key={t.id}><button className={`task-check ${t.done ? 'checked' : ''}`} role="checkbox" aria-checked={t.done} aria-label={(t.done ? '恢复' : '完成') + t.title} onClick={() => toggleTask(t.id)}>{t.done && <Icon name="check"/>}</button><button className="task-copy" onClick={() => open({ type: 'task', id: t.id })}><strong>{t.title}</strong><span>{t.note}</span>{t.id === 't1' && <em>优先处理</em>}</button></div>)}</div>{!taskList.length && <Empty text="这一页，暂时留白。" sub="完成的事情会留在「已完成」里。"/>}<p className="quiet-line">一步一步，把想法变成结果。</p></> : app === 'messages' ? <><div className="section-intro"><span>最近对话</span><span>{data.contacts.reduce((n,c) => n + c.unread,0)} 条未读</span></div><div className="conversation-list">{contacts.map(c => <button className="conversation" key={c.id} onClick={() => openThread(c)}><span className={`contact-glyph ${c.unread ? 'unread' : ''}`}>{c.name[0]}</span><span className="conversation-copy"><span className="conversation-title"><strong>{c.name}</strong><time>{c.messages.at(-1)?.time}</time></span><span className="last-message">{c.messages.at(-1)?.text}</span><span className="contact-role">{c.role}{c.unread > 0 && <b>{c.unread} 条新消息</b>}</span></span></button>)}</div>{!contacts.length && <Empty text="没有新消息。" sub="有新的对话时，会出现在这里。"/>}</> : <><div className="section-intro"><span>{activeTab === '收藏' ? '留给以后再读' : '今天的新发现'}</span><span>{articles.length} 篇</span></div>{articles.map((a, i) => <button className={`article-row ${i === 0 && !query ? 'featured' : ''}`} key={a.id} onClick={() => {setData(d => ({...d, articles: d.articles.map(x => x.id === a.id ? {...x, read: true} : x)})); open({type: 'article', id: a.id});}}><span className="article-meta"><span className="source-square"/>{a.source}<time>{a.date}</time>{a.saved && <Icon name="bookmark"/>}</span><strong>{a.title}</strong><p>{a.summary}</p>{i === 0 && <span className="read-link">继续阅读 <span>→</span></span>}</button>)}{!articles.length && <Empty text="已经读到这里了。" sub="去「全部」看看，或调整订阅。"/>}</>}
      </div>
      <div className="app-bar">{app === 'tasks' ? <><Command icon="plus" label="新建" onClick={() => open({type: 'newTask'})}/><Command icon="check" label="已完成" onClick={() => setTab('已完成')}/></> : app === 'messages' ? <><Command icon="plus" label="新消息" onClick={() => open({type: 'newMessage'})}/><Command icon="search" label="搜索" onClick={() => {setSearching(!searching); setQuery('');}}/></> : app === 'rss' ? <><Command icon="rss" label="订阅" onClick={() => open({type: 'sources'})}/><Command icon="search" label="搜索" onClick={() => {setSearching(!searching); setQuery('');}}/></> : <span className="home-bar-label">一切从这里开始。</span>}</div>
    </div>
    {layer.presence.mounted && visibleRoute && <div className="detail-page mp-panel" {...layer.presence.spread} ref={detailRef} tabIndex={-1} role="region" aria-label="应用详情" style={{pointerEvents: route ? undefined : 'none'}}>
      {task ? <><ScreenHeader title="这件事" eyebrow="待办" back={close}/><div className="detail-scroll"><span className="detail-overline">{task.done ? '已完成' : task.when + ' · 待处理'}</span><h3 className="task-detail-title">{task.title}</h3><p className="body-text">{task.note}</p><div className="detail-rule"/><span className="detail-overline">下一步</span><p className="body-text">{task.done ? '已完成，结果已保留。' : '继续处理这件事，并记录结果。'}</p></div><div className="app-bar"><Command icon="back" label="返回" onClick={close}/><Command icon="check" label={task.done ? '恢复待办' : '标为完成'} onClick={() => {toggleTask(task.id); close();}}/></div></> : visibleRoute.type === 'newTask' ? <><ScreenHeader title="新待办" eyebrow="待办" back={close}/><form className="editor-form" onSubmit={e => {e.preventDefault(); const f = new FormData(e.currentTarget); const title = String(f.get('title') || '').trim(); if (!title) return; setData(d => ({...d,tasks: [...d.tasks,{id: crypto.randomUUID(),title,note:String(f.get('note') || '').trim() || '从下一步开始。',when:'今天',done:false}]})); setTab('今天'); close();}}><label>要完成什么<input name="title" aria-label="待办标题" placeholder="记下一件要做的事" required maxLength={100}/></label><label>补充说明<textarea name="note" placeholder="下一步，或者想留住的细节" rows={4}/></label><p className="field-hint">加入「今天」</p><button className="solid-action" type="submit">保存待办 <Icon name="check"/></button></form></> : contact ? <><ScreenHeader title={contact.name} eyebrow="短信" back={close}/><div className="thread-body" ref={threadRef}><div className="thread-date">今天 · 10 月 23 日</div>{contact.messages.map((m,i) => <div className={`message ${m.mine ? 'mine' : ''}`} key={i}><p>{m.text}</p><time>{m.time}{m.mine ? ' · 已发送' : ''}</time></div>)}</div><form className="reply-form" onSubmit={e => {e.preventDefault(); const f = e.currentTarget; const text = String(new FormData(f).get('reply') || '').trim(); if (!text) return; setData(d => ({...d,contacts: d.contacts.map(c => c.id === contact.id ? {...c,messages: [...c.messages,{text,mine:true,time:'10:28'}]} : c)})); f.reset();}}><input name="reply" aria-label="回复消息" placeholder="输入消息" autoComplete="off" required maxLength={2000}/><button aria-label="发送演示消息" type="submit"><Icon name="send"/></button></form></> : visibleRoute.type === 'newMessage' ? <><ScreenHeader title="新消息" eyebrow="短信" back={close}/><form className="editor-form" onSubmit={e => {e.preventDefault(); const f = new FormData(e.currentTarget); const name = String(f.get('name') || '').trim(); const text = String(f.get('text') || '').trim(); if (!name || !text) return; const existing = data.contacts.find(c => c.name === name); const id = existing?.id || crypto.randomUUID(); setData(d => ({...d,contacts: existing ? d.contacts.map(c => c.id === id ? {...c,messages:[...c.messages,{text,mine:true,time:'10:28'}]} : c) : [{id,name,role:'新对话',unread:0,messages:[{text,mine:true,time:'10:28'}]},...d.contacts]})); setRoute({type:'thread',id});}}><label>收件人<input name="name" aria-label="收件人" placeholder="姓名" required/></label><label>消息<textarea name="text" aria-label="新消息正文" placeholder="想说点什么？" rows={5} required/></label><button className="solid-action" type="submit">发送 <Icon name="send"/></button><p className="field-hint">仅在原型中演示，不发送到飞书。</p></form></> : article ? <><ScreenHeader title="阅读" eyebrow={article.source} back={close}/><article className="detail-scroll article-detail"><div className="detail-overline">{article.source} / 10 月 23 日</div><h3>{article.title}</h3><p className="article-lead">{article.summary}</p><p>我们常常在界面里增加一个按钮、一层容器、一条分隔线，却忘了问：这些东西真的帮助了阅读吗？</p><p>当界面只留下必要的部分，内容之间的关系反而更清楚。一个标题告诉你现在在哪里，一段留白让你知道下一件事从哪里开始。</p><blockquote>让信息有自己的秩序，<br/>让注意力回到事情本身。</blockquote><p>对一个拥有自己工具的 AI 来说，也是如此。应用保存工作，界面呈现状态，重要的变化在需要时抵达。</p><span className="article-end">— 演示文章 · 全文完 —</span></article><div className="app-bar"><Command icon="back" label="返回" onClick={close}/><Command icon="bookmark" label={article.saved ? '取消收藏' : '收藏'} onClick={() => saveArticle(article.id)}/><Command icon="plus" label="加入待办" onClick={() => addArticleTask(article)}/></div></> : visibleRoute.type === 'sources' ? <><ScreenHeader title="订阅" eyebrow="阅读" back={close}/><div className="detail-scroll"><p className="body-text">为自己留一扇看世界的窗。</p>{sourceNames.map(s => <label className="source-row" key={s}><span><strong>{s}</strong><small>演示订阅源</small></span><input type="checkbox" aria-label={'订阅' + s} checked={sources.includes(s)} onChange={e => setSources(v => e.target.checked ? [...v,s] : v.filter(x => x !== s))}/></label>)}<p className="field-hint">切换订阅会更新阅读列表。</p></div><div className="app-bar"><Command icon="back" label="返回" onClick={close}/></div></> : null}
    </div>}
    {notice && <button className="phone-notice" role="status" onClick={() => setNotice('')}>{notice}<span>×</span></button>}
  </div>;
}
function Empty({text,sub}: {text:string;sub:string}) { return <div className="empty-state"><span>—</span><h3>{text}</h3><p>{sub}</p></div>; }
