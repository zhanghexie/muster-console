/** Interactive design study only. Rebuild: node scripts/build-composer-queue-study.mjs */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MOTION, usePresence, usePresenceValue } from '../../../src/renderer/src/components/motion';
import { StudyAnnotationEditor, StudyQuestionCard, StudyQuickPhrases, type StudyNote, type StudyQuestionKind, type StudyQuickPhrasesHandle } from '../composer-related-study/composer-related-study';
import { expandNoteToken } from '../../../src/shared/noteAnnotations';

type Lane = 'auto' | 'manual';
type Item = { id: string; text: string; lane: Lane; image?: boolean; annotation?: StudyNote; editText?: string };
const examples: Item[] = [
  { id: 'a1', text: '再检查一下浅色模式下的文字对比度。', lane: 'auto' },
  { id: 'a2', text: '调整完成后，给我看一张完整界面的截图。', lane: 'auto' },
  { id: 'm1', text: '确认效果后，再把这轮改动提交。', lane: 'manual' }
];
const paths: Record<string, React.ReactNode> = {
  queue: <><path d="M7 4h10M7 10h10M7 16h6"/><path d="M3 4h.01M3 10h.01M3 16h.01"/></>,
  up: <path d="M10 16V4m-5 5 5-5 5 5"/>,
  down: <path d="m5 8 5 5 5-5"/>,
  expand: <path d="m5 12 5-5 5 5"/>,
  more: <><circle cx="4" cy="10" r=".8"/><circle cx="10" cy="10" r=".8"/><circle cx="16" cy="10" r=".8"/></>,
  plus: <path d="M10 4v12M4 10h12"/>,
  drag: <><path d="M7 4h.01M13 4h.01M7 10h.01M13 10h.01M7 16h.01M13 16h.01" strokeWidth="3"/></>,
  edit: <><path d="m12 4 4 4M3 17l4-1L17 6l-4-4L3 12v5Z"/></>,
  close: <path d="m5 5 10 10M15 5 5 15"/>,
  stop: <rect x="5" y="5" width="10" height="10" rx="1" fill="currentColor" stroke="none"/>,
  hold: <><path d="M3 10v6h14v-6M3 10h4l1 3h4l1-3h4M8 3v4M12 3v4"/></>,
  image: <><rect x="3" y="3" width="14" height="14" rx="3"/><path d="m3 14 4-4 3 3 3-5 4 6"/><circle cx="7" cy="7" r="1"/></>,
  mode: <path d="M10 2 4 11h5l-1 7 8-10h-6l1-6Z"/>,
  context: <><circle cx="10" cy="10" r="7"/><path d="M10 3v7l5 5"/></>
};
function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function ComposerQueueStudy({ compactStudy = false }: { compactStudy?: boolean } = {}) {
  const [light, setLight] = useState(compactStudy);
  const [compactActions, setCompactActions] = useState(true);
  const [showSessionActions, setShowSessionActions] = useState(false);
  const sessionActions = usePresence(showSessionActions);
  const [questionKind, setQuestionKind] = useState<StudyQuestionKind | 'none'>(compactStudy ? 'single' : 'none');
  const question = usePresenceValue(questionKind === 'none' ? null : questionKind);
  const [quickOpen, setQuickOpen] = useState(false);
  const [annotation, setAnnotation] = useState<StudyNote | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const quickRef = useRef<StudyQuickPhrasesHandle | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [items, setItems] = useState<Item[]>(compactStudy ? examples.filter(i => i.lane === 'manual') : examples);
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState(compactStudy ? '先检查一下这版输入区。' : '');
  const [image, setImage] = useState(false);
  const [busy, setBusy] = useState(!compactStudy);
  const [scenario, setScenario] = useState(compactStudy ? 'manual' : 'both');
  const [notice, setNotice] = useState('可输入文字，试试收起、展开和每条消息右侧的更多操作。');
  const [menu, setMenu] = useState<{ item: Item; x: number; y: number } | null>(null);
  const { presence: menuPresence, value: menuValue } = usePresenceValue(menu, MOTION.microMs);
  const panel = usePresence(items.length > 0 && !collapsed);
  const capsule = usePresence(items.length > 0 && collapsed);
  const editor = useRef<HTMLTextAreaElement>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const dragging = useRef<string | null>(null);
  const focusQueueToggle = useRef(false);
  const [over, setOver] = useState<string | null>(null);
  const autoN = items.filter(i => i.lane === 'auto').length;
  const manualN = items.length - autoN;
  const hasDraft = !!draft.trim() || image || !!annotation;
  const expandedDraft = () => [draft.trim(), annotation ? expandNoteToken({ seq: 1, ...annotation }) : ''].filter(Boolean).join(' ');
  const enterLane: Lane = manualN ? 'manual' : 'auto';
  function closeQuick() { setQuickOpen(false); setDraft(''); editor.current?.focus(); }
  function toggleQuick() {
    setQuickOpen(open => !open); setDraft('');
    setNoteOpen(false);
    editor.current?.focus();
  }

  useEffect(() => {
    document.documentElement.dataset.cqTheme = light ? 'light' : 'dark';
    return () => { delete document.documentElement.dataset.cqTheme; };
  }, [light]);
  useEffect(() => {
    if (!editor.current) return;
    editor.current.style.height = '0px';
    editor.current.style.height = `${Math.max(48, Math.min(160, editor.current.scrollHeight))}px`;
  }, [draft]);
  useEffect(() => {
    if (!focusQueueToggle.current) return;
    const target = document.querySelector<HTMLButtonElement>(collapsed ? '.cq-capsule' : '.cq-lane-head button');
    if (target) { target.focus(); focusQueueToggle.current = false; }
  }, [collapsed, panel.mounted, capsule.mounted]);
  useEffect(() => {
    if (!menu) return;
    menuEl.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menuEl.current?.contains(event.target as Node) && !menuTrigger.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menu, menuPresence.mounted]);

  function reset(kind: 'both' | 'auto' | 'manual' | 'empty' | 'many' | 'image' = 'both') {
    setScenario(kind);
    setItems(kind === 'empty' ? [] : kind === 'many'
      ? Array.from({ length: 10 }, (_, i) => ({ id: `long-${i}`, lane: i < 6 ? 'auto' : 'manual', text: examples[i % 3].text } as Item))
      : kind === 'image' ? [{ id: 'pic', lane: 'manual', text: '按这张截图检查窄屏布局。', image: true }]
      : examples.filter(i => kind === 'both' || i.lane === kind));
    setCollapsed(false); setDraft(''); setImage(false); setMenu(null); setBusy(kind !== 'empty');
    setQuickOpen(false);
    setAnnotation(null); setNoteOpen(false);
    setNotice('示例已重置；所有操作仅在此原型中模拟。');
  }
  function remove(id: string) { setItems(list => list.filter(i => i.id !== id)); }
  function edit(item: Item) {
    const text = item.editText ?? item.text;
    setDraft(current => current && text ? `${current}\n${text}` : current || text);
    if (item.annotation) setAnnotation(item.annotation);
    if (item.image) setImage(true);
    remove(item.id); setMenu(null);
    setNotice('已取回输入框；原有草稿保留。');
    editor.current?.focus();
  }
  function sendNow(item: Item) {
    if (item.image) return;
    remove(item.id); setMenu(null);
    setNotice(`模拟${busy ? '插话' : '发送'}：${item.text}`);
  }
  function changeLane(item: Item) {
    setItems(list => list.map(i => i.id === item.id ? { ...i, lane: i.lane === 'auto' ? 'manual' : 'auto' } : i));
    setMenu(null);
    setNotice(item.lane === 'auto' ? '已移到手动确认，不会自动发送。' : '已移到自动队列，将在本轮结束后发送。');
  }
  function add(lane: Lane) {
    if (!hasDraft || quickOpen) return;
    setItems(list => [...list, { id: `draft-${Date.now()}`, text: expandedDraft(), lane, image,
      ...(annotation ? { annotation: { ...annotation }, editText: draft.trim() } : {}) }]);
    setDraft(''); setImage(false);
    setAnnotation(null); setNoteOpen(false);
    setNotice(lane === 'auto' ? '已加入自动队列。' : '已留待手动确认，不会自动发送。');
    if (compactStudy) editor.current?.focus();
  }
  function submit() {
    if (!hasDraft || quickOpen) return;
    if (busy) add(enterLane);
    else { setNotice(`模拟发送：${expandedDraft() || '图片'}`); setDraft(''); setImage(false); setAnnotation(null); setNoteOpen(false); setBusy(true); }
  }
  function move(id: string, lane: Lane, beforeId?: string) {
    setItems(list => {
      const item = list.find(i => i.id === id);
      if (!item || id === beforeId) return list;
      const next = list.filter(i => i.id !== id);
      const at = beforeId ? next.findIndex(i => i.id === beforeId) : -1;
      next.splice(at < 0 ? next.length : at, 0, { ...item, lane });
      return next;
    });
    setOver(null); dragging.current = null;
  }
  function reorder(item: Item, delta: number) {
    setItems(list => {
      const lane = list.filter(i => i.lane === item.lane);
      const a = lane.findIndex(i => i.id === item.id), b = a + delta;
      if (b < 0 || b >= lane.length) return list;
      [lane[a], lane[b]] = [lane[b], lane[a]];
      let cursor = 0;
      return list.map(i => i.lane === item.lane ? lane[cursor++] : i);
    });
    setMenu(null);
  }
  function row(item: Item, index: number) {
    return <div className={`cq-row${over === item.id ? ' cq-over' : ''}`} role="listitem" key={item.id}
      onDragOver={event => { if (dragging.current) { event.preventDefault(); event.stopPropagation(); setOver(item.id); } }}
      onDrop={event => { event.preventDefault(); event.stopPropagation(); if (dragging.current) move(dragging.current, item.lane, item.id); }}>
      <span className="cq-order" draggable title="拖动排序，或拖到另一分组"
        onDragStart={event => { dragging.current = item.id; event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => { dragging.current = null; setOver(null); }}><span>{index + 1}</span><Icon name="drag" size={14}/></span>
      {item.image && <span className="cq-thumb" title="1 张图片（示意）"><Icon name="image" size={18}/></span>}
      <button className="cq-row-text" title={`${item.text || '1 张图片'} · 取回编辑`} onClick={() => edit(item)}>{item.text || '1 张图片'}</button>
      <button className="cq-icon cq-now" aria-label={`立即发送：${item.text}`} title={item.image ? '带图消息不支持插话' : busy ? '立即插话当前回合' : '立即发送'} disabled={item.image} onClick={() => sendNow(item)}><Icon name="up" size={15}/></button>
      <button className="cq-icon cq-more" aria-label={`更多：${item.text || '图片'}`} aria-haspopup="menu" aria-expanded={menu?.item.id === item.id}
        onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); menuTrigger.current = event.currentTarget; setMenu({ item, x: Math.max(8, rect.right - 188), y: Math.max(8, Math.min(rect.top, window.innerHeight - 218)) }); }}><Icon name="more"/></button>
    </div>;
  }
  function lane(kind: Lane) {
    const list = items.filter(i => i.lane === kind);
    return <section className={`cq-lane${over === kind ? ' cq-lane-over' : ''}`} aria-label={kind === 'auto' ? '自动发送队列' : '手动确认队列'}
      onDragOver={event => { if (dragging.current) { event.preventDefault(); setOver(kind); } }}
      onDrop={event => { event.preventDefault(); if (dragging.current) move(dragging.current, kind); }}>
      <div className="cq-lane-head"><span>{compactStudy && compactActions
        ? kind === 'auto' ? '排队自动发送' : '手动确认发送'
        : kind === 'auto' ? '自动发送' : '手动确认'} <b>{list.length}</b></span>
        {!(compactStudy && compactActions) && <small>{kind === 'auto' ? '本轮结束后按序发送' : '不会自动发送'}</small>}
        {kind === 'auto' && <button className="cq-icon" aria-label="收起排队面板" title="收起排队面板" onClick={() => { focusQueueToggle.current = true; setCollapsed(true); }}><Icon name="down"/></button>}
      </div>
      <div className="cq-lane-list" role="list">{list.map(row)}</div>
      {!list.length && <div className="cq-empty">暂无消息，可拖入此处</div>}
    </section>;
  }
  const menuItem = menuValue?.item;
  const menuLane = menuItem ? items.filter(i => i.lane === menuItem.lane) : [];
  const menuIndex = menuLane.findIndex(i => i.id === menuItem?.id);

  const route = busy ? `Enter ${enterLane === 'manual' ? '留待确认' : '加入自动队列'}` : 'Enter 发送';
  const compact = compactStudy && compactActions;
  const showAuto = busy || autoN > 0;
  return <div className={`cq-study${compactStudy ? ' cq-compact-study' : ''}`}>
    <header className="cq-study-head"><div><h1>{compactStudy ? '发送旁的小按钮' : '输入与待发送'}</h1><span>交互原型 · OPPO Sans</span></div>
      <div className="cq-study-controls"><div className="cq-switch"><button aria-pressed={!light} onClick={() => setLight(false)}>深色</button><button aria-pressed={light} onClick={() => setLight(true)}>浅色</button></div>
        {compactStudy && <div className="cq-switch"><button aria-pressed={!compactActions} onClick={() => setCompactActions(false)}>当前布局</button><button aria-pressed={compactActions} onClick={() => setCompactActions(true)}>紧凑方案</button></div>}
        <div className="cq-switch"><button aria-pressed={!narrow} onClick={() => setNarrow(false)}>工作区</button><button aria-pressed={narrow} onClick={() => setNarrow(true)}>窄面板</button></div>
        <label>场景 <select aria-label="示例场景" value={scenario} onChange={event => reset(event.target.value as Parameters<typeof reset>[0])}><option value="both">自动 + 手动</option><option value="auto">只有自动</option><option value="manual">只有手动</option><option value="empty">没有队列</option><option value="many">多条消息</option><option value="image">带图消息</option></select></label>
        <button className="cq-reset" onClick={() => reset()}>重置示例</button>
      </div>
    </header>
    {compactStudy && <div className="cq-study-options"><span>纯色输入与问答 · 24px 辅助按钮 / 30px 发送</span><label>问答 <select aria-label="问答示例" value={questionKind} onChange={e => setQuestionKind(e.target.value as StudyQuestionKind | 'none')}><option value="none">不显示</option><option value="single">单选</option><option value="multi">多选</option><option value="pages">多题</option></select></label><button className="cq-reset" aria-pressed={quickOpen} onClick={toggleQuick}>快捷短语</button><button className="cq-reset" onClick={() => { setAnnotation(current => current ?? { quote: "正文保留清楚的层次，辅助操作收在需要它们的位置。", note: "辅助操作再紧凑一点，保留正文空间。" }); setNoteOpen(true); setQuickOpen(false); }}>批注示例</button><label><input type="checkbox" checked={busy} onChange={e => setBusy(e.target.checked)}/>Agent 运行中</label><label><input type="checkbox" checked={showSessionActions} onChange={e => setShowSessionActions(e.target.checked)}/>显示会话操作</label></div>}
    <main className={`cq-workbench${narrow ? ' cq-narrow' : ''}`}>
      <div className="cq-chrome"><span className="cq-brand-mark">◈</span><b>演示工作区</b><span>⌄</span><span className="cq-chrome-extra">全局看板</span><span className="cq-chrome-end">—　□　×</span></div>
      <div className="cq-workbench-body">
        <aside className="cq-sidebar"><div className="cq-section-title">实用功能</div><div className="cq-utilities"><span>◷<br/>定时任务</span><span>▥<br/>使用统计</span><span>▣<br/>记忆整理</span></div>
          <div className="cq-section-title">工作会话</div><div className="cq-session selected"><span>◌　输入区视觉调整</span><small>现在</small></div><div className="cq-session"><span>◌　文件预览优化</span><small>2h</small></div><div className="cq-session"><span>◌　扩展面板检查</span><small>昨天</small></div>
          <div className="cq-spaces"><span>＋　⌄</span><div className="selected"><i>✦</i><b>演示工作区</b><small>对话</small></div><div><i>◎</i><span>前端项目</span><small>空闲</small></div></div>
        </aside>
        <section className="cq-chat" aria-label="聊天预览"><header className="cq-chat-head"><b>输入区视觉调整</b><span>{busy ? '正在处理' : '等待输入'}</span></header>
          <article className="cq-transcript">{!question.presence.mounted && <div className="cq-user-msg">输入框和排队面板也一起简化一下，和现在的纯色界面保持一致。</div>}<div className="cq-agent-name"><span>◈</span> Agent</div>
            {question.presence.mounted ? <div className={`acc${question.presence.stage === 'in' ? ' is-open' : ''}`} aria-hidden={question.presence.stage === 'out'} {...(question.presence.stage === 'out' ? { inert: '' } : {})}><div className="acc-body"><StudyQuestionCard key={question.value!} kind={question.value!} onNotice={setNotice}/></div></div>
              : <div className="cq-prose"><p>我会先检查深浅两种主题的阅读效果，再调整窄面板里的布局。</p><p>正文保留清楚的层次，辅助操作收在需要它们的位置。</p><div className="cq-work-note"><span>✓</span> 已检查输入区与队列的现有样式</div></div>}
          </article>
          <div className="cq-composer-wrap">
            {compactStudy && <StudyAnnotationEditor open={noteOpen && !!annotation} value={annotation ?? { quote: '', note: '' }} onClose={() => { setNoteOpen(false); editor.current?.focus(); }} onDelete={() => { setAnnotation(null); setNoteOpen(false); editor.current?.focus(); }} onSave={note => { setAnnotation(current => current ? { ...current, note } : current); setNoteOpen(false); editor.current?.focus(); setNotice('批注已保存，入队时会保留原文和批注内容。'); }}/>}
            {compactStudy && <StudyQuickPhrases ref={quickRef} open={quickOpen} query={draft} focusEditor={() => editor.current?.focus()} onClose={closeQuick} onInsert={value => { setDraft(value); setQuickOpen(false); editor.current?.focus(); setNotice('短语已填入草稿，可以继续编辑后发送。'); }}/>}<div className="cq-composer" data-testid="study-composer">
            {compactStudy && sessionActions.mounted && <div className={`acc${sessionActions.stage === 'in' ? ' is-open' : ''}`} aria-hidden={sessionActions.stage === 'out'} {...(sessionActions.stage === 'out' ? { inert: '' } : {})}><div className="acc-body"><div className="cq-session-actions"><span>会话操作</span><button onClick={() => { setShowSessionActions(false); setNotice('已模拟标记已处理。'); }}>标记已处理</button><button onClick={() => setNotice('示意：正式界面会打开验收确认框。')}>验收通过</button><button onClick={() => setNotice('示意：正式界面会打开打回说明框。')}>打回</button></div></div></div>}
            {compactStudy && !compact && <div className="cq-draft-actions cq-draft-actions-top"><span>{route}</span><div>{showAuto && <button disabled={!hasDraft} onClick={() => add('auto')}>加入自动队列</button>}<button disabled={!hasDraft} onClick={() => add('manual')}>留待确认</button></div></div>}
            <div className={`cq-queue-slot${panel.mounted ? ' cq-has-panel' : ''}`}>
              {panel.mounted && <div className={`acc${panel.stage === 'in' ? ' is-open' : ''}`} aria-hidden={panel.stage === 'out'} {...(panel.stage === 'out' ? { inert: '' } : {})}><div className="acc-body"><div className="cq-queue-panel">{lane('auto')}{lane('manual')}</div></div></div>}
              {capsule.mounted && <div className={`acc${capsule.stage === 'in' ? ' is-open' : ''}`} aria-hidden={capsule.stage === 'out'} {...(capsule.stage === 'out' ? { inert: '' } : {})}><div className="acc-body"><div className="cq-capsule-wrap">
                <button className="cq-capsule" aria-label="展开排队面板" title="展开查看待发送消息" onClick={() => { focusQueueToggle.current = true; setCollapsed(false); }}><Icon name="queue"/>{autoN > 0 && <span>自动 <b>{autoN}</b></span>}{autoN > 0 && manualN > 0 && <i/>}{manualN > 0 && <span>待确认 <b>{manualN}</b></span>}<Icon name="expand" size={13}/></button>
              </div></div></div>}
            </div>
            <div className="cq-draft">
              {quickOpen && <div className="cq-command-chip"><span>快捷短语</span><button className="cq-icon" aria-label="退出快捷短语" onClick={closeQuick}><Icon name="close" size={12}/></button></div>}
              {annotation && !quickOpen && <div className="cq-annotation-chips"><button className="cq-annotation-chip" aria-label="查看并编辑批注" title={annotation.quote} onClick={() => { setNoteOpen(true); setQuickOpen(false); }}><Icon name="edit" size={12}/><span>批注 · {annotation.note}</span></button><button className="cq-icon" aria-label="移除批注" onClick={() => { setAnnotation(null); setNoteOpen(false); }}><Icon name="close" size={12}/></button></div>}
              {image && <div className="cq-draft-image"><Icon name="image" size={22}/><span>示例图片</span><button className="cq-icon" aria-label="移除图片" onClick={() => setImage(false)}><Icon name="close" size={12}/></button></div>}
              <textarea ref={editor} aria-label="消息输入框" value={draft} onChange={event => setDraft(event.target.value)} placeholder={quickOpen ? '搜索短语，↑↓ 选择，Enter 插入…' : busy ? '继续补充你的想法…' : '对 Agent 说点什么…'} rows={2}
                onKeyDown={event => { if (quickOpen) quickRef.current?.onKeyDown(event); else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}/>
              {!compactStudy && hasDraft && <div className="cq-draft-actions"><span>{route}</span><div>{busy && <button onClick={() => add('auto')}>加入自动队列</button>}<button onClick={() => add('manual')}>留待确认</button></div></div>}
              <footer className="cq-toolbar"><div><button className="cq-icon" aria-label="添加示例图片" title="添加示例图片" onClick={() => setImage(true)}><Icon name="plus" size={18}/></button><span className="cq-mode"><Icon name="mode" size={13}/>全自动</span></div><div><span className="cq-context" title="上下文用量 24%"><Icon name="context" size={13}/><span>24%</span></span><span className="cq-model">Claude Sonnet<Icon name="down" size={11}/></span><div className="cq-send-actions" role="group" aria-label="发送操作">
                {compact && showAuto && <button className="cq-secondary-send" aria-label="加入自动队列" title="加入自动队列 · 本轮结束后按序发送" disabled={!hasDraft || quickOpen} onClick={() => add('auto')}><Icon name="queue" size={15}/></button>}
                {compact && <button className="cq-secondary-send" aria-label="留待确认" title="留待确认 · 保存草稿，确认后再发送" disabled={!hasDraft || quickOpen} onClick={() => add('manual')}><Icon name="hold" size={16}/></button>}
                <button className="cq-send" aria-label={busy ? '停止当前回合' : '发送消息'} disabled={!busy && (!hasDraft || quickOpen)} title={busy ? `停止当前回合，保留队列 · ${route}` : route} onClick={() => busy ? (setBusy(false), setNotice('已模拟停止当前回合，待发送消息保留。')) : submit()}><Icon name={busy ? 'stop' : 'up'} size={18}/></button>
              </div></div></footer>
            </div>
          </div></div>
        </section>
        <aside className="cq-file"><header>文件预览 <span>README.md</span></header><div><small>工作记录</small><h2>界面调整</h2><p>统一输入区域的材质，让输入和待发送消息形成一个整体。</p><h3>本轮检查</h3><p>深色与浅色主题<br/>窄面板布局<br/>队列展开与收起<br/>输入框聚焦状态</p><h3>下一步</h3><p>确认效果后再应用到工作会话和调度对话。</p></div></aside>
      </div>
    </main>
    <footer className="cq-study-foot"><span role="status">{notice}</span><span>原型模拟，不发送真实消息 · 拖动排序 / 跨组移动</span></footer>
    {menuPresence.mounted && menuItem && createPortal(<div ref={menuEl} role="menu" aria-label="消息操作" className="cq-menu mp-pop" {...menuPresence.spread} aria-hidden={menuPresence.stage === 'out'} {...(menuPresence.stage === 'out' ? { inert: '' } : {})} style={{ left: menuValue!.x, top: menuValue!.y }}
      onKeyDown={event => {
        if (event.key === 'Escape') { setMenu(null); menuTrigger.current?.focus(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const i = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      }}>
      <button role="menuitem" onClick={() => edit(menuItem)}><Icon name="edit" size={14}/>取回编辑</button>
      <button role="menuitem" onClick={() => changeLane(menuItem)}><Icon name="queue" size={14}/>{menuItem.lane === 'auto' ? '转为手动确认' : '加入自动队列'}</button>
      <div className="cq-menu-sep"/>
      <button role="menuitem" disabled={menuIndex <= 0} onClick={() => reorder(menuItem, -1)}>上移</button><button role="menuitem" disabled={menuIndex >= menuLane.length - 1} onClick={() => reorder(menuItem, 1)}>下移</button>
      <div className="cq-menu-sep"/><button role="menuitem" onClick={() => { remove(menuItem.id); setMenu(null); setNotice('已删除这条待发送消息。'); }}><Icon name="close" size={14}/>删除</button>
    </div>, document.body)}
  </div>;
}
