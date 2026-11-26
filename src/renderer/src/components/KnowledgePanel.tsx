import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { t as translate } from '../../../shared/i18n';
import { localizeKnowledgeHostText } from '../../../shared/knowledgeDisplayText';
import type { KnowledgeApi, KnowledgeDraft, KnowledgeRecord, KnowledgeSnapshot, KnowledgeEvidenceView, KnowledgeHit, KnowledgeNamespace } from '../../../shared/knowledge';
import { CustomSelect } from './CustomSelect';
import { usePresence } from './motion';
import { KnowledgeHistory } from './KnowledgeHistory';
import { TURN_CHANGE_TEXT_KEYS } from '../turnChangeDisplay';

const labels = { task_fact: '任务历史', stable_constraint: '持续约束', user_preference: '用户偏好', user_profile: '用户信息', reusable_lesson: '可复用经验' };
const statuses = { pending: '整理中', active: '已生效', needs_revalidation: '已暂停', superseded: '已取代', archived: '已停用', rejected: '未采用' };
const scopes = { worker: '工作区共享', scheduler: '调度专用', profile: '用户画像', host: '工作台通用' };
type Tab = 'active' | 'pending' | 'history' | 'retired';
type StateFilter = 'all' | 'active' | 'processing' | 'inactive';
type ObservedRecord = { record: KnowledgeRecord; deleted: boolean };
const retiredStatuses = new Set<KnowledgeRecord['status']>(['archived', 'superseded', 'rejected']);
const evidenceReasonKeys = new Set<string>([...TURN_CHANGE_TEXT_KEYS, '没有完整的轮次快照或仓库/分支依据，不能还原代码证据']);
function retiredRecord(record: KnowledgeRecord, deleted: boolean): boolean {
  return deleted || retiredStatuses.has(record.status) && (record.kind !== 'task_fact' || record.status !== 'archived');
}

function KnowledgeCard({ record, policySuppressed, deleted, readOnly, busy, api, related, onNavigate, onDelete, onRevise, onConfirm, onPromote, onStop, onRestore }: {
  policySuppressed:boolean; deleted: boolean; readOnly: boolean;
  record: KnowledgeRecord; busy: boolean; api: KnowledgeApi; related: KnowledgeRecord[];
  onNavigate: (record: KnowledgeRecord) => void; onDelete: (record: KnowledgeRecord) => void;
  onRevise: (record: KnowledgeRecord, draft: KnowledgeDraft) => void;
  onConfirm: (record: KnowledgeRecord) => void;
  onPromote: (record: KnowledgeRecord, draft: KnowledgeDraft) => Promise<boolean>;
  onStop: (record:KnowledgeRecord)=>void; onRestore:(record:KnowledgeRecord,revision:number)=>void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), [editing, setEditing] = useState(false), [promoting,setPromoting]=useState(false);
  const [summary, setSummary] = useState(record.summary), [conditions, setConditions] = useState(record.applicability.join('\n'));
  const [fields, setFields] = useState({ problem: record.problem ?? '', action: record.action ?? '', rationale: record.rationale ?? '', expectedFutureUse: record.expectedFutureUse ?? '', exceptions: (record.exceptions ?? []).join('\n') });
  const [repoKey, setRepoKey] = useState(record.repoKey ?? ''), [branch, setBranch] = useState(record.branch ?? '');
  const [evidence, setEvidence] = useState<KnowledgeEvidenceView | null>(null), [evidenceBusy, setEvidenceBusy] = useState(false), [evidenceError, setEvidenceError] = useState(''), [selectedEvidence, setSelectedEvidence] = useState('');
  const evidenceGeneration = useRef(0), presence = usePresence(open);
  useEffect(() => {
    setSummary(record.summary); setConditions(record.applicability.join('\n')); setRepoKey(record.repoKey ?? ''); setBranch(record.branch ?? '');
    setFields({ problem: record.problem ?? '', action: record.action ?? '', rationale: record.rationale ?? '', expectedFutureUse: record.expectedFutureUse ?? '', exceptions: (record.exceptions ?? []).join('\n') });
    setEditing(false); setPromoting(false); setEvidence(null); setEvidenceBusy(false); setEvidenceError(''); evidenceGeneration.current++;
  }, [record.id, record.revision]);
  useEffect(() => () => { evidenceGeneration.current++; }, []);
  const readEvidence = async (evidenceId: string, file?: string): Promise<void> => {
    const token = ++evidenceGeneration.current; setEvidenceBusy(true); setEvidence(null); setEvidenceError(''); setSelectedEvidence(evidenceId);
    try { const value = await api.evidence({ id: record.id, evidenceId, file }); if (token === evidenceGeneration.current) setEvidence(value); }
    catch (error) { if (token === evidenceGeneration.current) setEvidenceError(String((error as Error).message ?? error)); }
    finally { if (token === evidenceGeneration.current) setEvidenceBusy(false); }
  };
  return <article className="knowledge-card" aria-label={record.summary}>
    <div className="knowledge-meta"><span>{t(labels[record.kind])}</span><span>{t(scopes[record.namespace])}</span><span>{t(deleted ? '已删除' : policySuppressed?'策略已停用，暂停使用':statuses[record.status])}</span><span>r{record.revision}</span></div>
    <h3>{record.summary}</h3>
    {record.environmentCheck && record.environmentCheck.state!=='current' ? <p>{t('环境参数可能已变化，请重新核实。')}{record.environmentCheck.dependencies.map(item=><span key={item.key}> {item.key}: {item.recorded} → {item.current??t('当前值未知')}</span>)}</p> : null}
    {record.userManaged ? <p>{t('用户已确认，自动整理不会覆盖此版本。')}</p> : null}
    {record.expiresAt ? <p>{record.expiresAt <= Date.now() ? t('历史保留期已过，不再参与召回') : t('历史保留至 {{date}}', { date: new Date(record.expiresAt).toLocaleDateString() })}</p> : null}
    {record.action ? <p><strong>{t('怎么做：')}</strong>{record.action}</p> : null}
    <p><strong>{t('适用条件：')}</strong>{record.applicability.join('；') || t('未声明特定条件')}{record.branch ? t(' · 分支 {{branch}}', { branch: record.branch }) : ''}</p>
    {record.exceptions?.length ? <p><strong>{t('不适用：')}</strong>{record.exceptions.join('；')}</p> : null}
    {record.expectedFutureUse ? <p><strong>{t('下次有什么用：')}</strong>{record.expectedFutureUse}</p> : null}
    <div className="knowledge-actions">
      <button type="button" className="ui-btn compact" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t(open ? '收起依据' : readOnly ? '查看依据与历史' : '查看依据与修订')}</button>
      {record.kind !== 'task_fact' ? <button type="button" className="ui-btn compact" disabled={busy} onClick={() => { setOpen(true); setEditing(true); setPromoting(false); setRepoKey(record.repoKey??''); setBranch(record.branch??''); }}>{t(readOnly?'修改并恢复':'修订内容与条件')}</button> : null}
      {!readOnly && !policySuppressed && record.kind==='reusable_lesson' && record.namespace!=='host' && record.status==='active' ? <button type="button" className="ui-btn compact" disabled={busy} onClick={()=>{setOpen(true);setEditing(true);setPromoting(true);setRepoKey('');setBranch('');}}>{t('复制为工作台通用经验')}</button> : null}
      {!readOnly && !policySuppressed && record.kind !== 'task_fact' && record.status === 'active' && !record.userManaged ? <button type="button" className="ui-btn compact" disabled={busy} onClick={()=>onConfirm(record)}>{t('确认当前记忆')}</button> : null}
      {!readOnly && record.kind !== 'task_fact' && record.status==='active' ? <button type="button" className="ui-btn compact" disabled={busy} onClick={()=>onStop(record)}>{t('停止使用')}</button> : null}
      {!readOnly ? <button type="button" className="ui-btn compact" disabled={busy} onClick={() => onDelete(record)}>{t('删除')}</button> : null}
    </div>
    {presence.mounted ? <div className={`acc${presence.stage === 'in' ? ' is-open' : ''}`} {...presence.spread} {...(!open ? { inert: '' as unknown as boolean } : {})}><div className="acc-body"><div className="knowledge-details">
      <p>{localizeKnowledgeHostText(record.decisionReason)}</p>
      {record.problem ? <p><strong>{t('问题：')}</strong>{record.problem}</p> : null}
      {record.rationale ? <p><strong>{t('判断依据：')}</strong>{record.rationale}</p> : null}
      {record.relations?.length ? <ul>{record.relations.map(link => {
        const target = related.find(item => item.id === link.targetId), relation = { derived_from: '归纳自', supports: '支持', supersedes: '取代', contradicts: '矛盾', revision_of: '修订自' }[link.kind];
        return <li key={`${link.kind}:${link.targetId}`}>{t(relation)} · {t(link.inferred ? '推断关系' : '已记录关系')} · r{link.targetRevision ?? '?'} {target ? <button className="ui-btn compact" onClick={() => onNavigate(target)}>{target.summary}</button> : t('来源不可用：{{id}}', { id: link.targetId })}</li>;
      })}</ul> : null}
      {record.repoKey ? <p>{t('仓库：{{repo}}', { repo: record.repoKey })}</p> : null}
      <p>{t('依据按事件时间排序；只展示已采集轮次，不代表完整编辑历史或当前代码。')}</p>
      <ul>{[...record.evidence].sort((a, b) => a.eventTime - b.eventTime || a.id.localeCompare(b.id)).map((item, index) => <li key={item.id}>
        {t('第 {{n}} 份依据 · {{source}} · {{time}}', { n: index + 1, source: item.source, time: new Date(item.eventTime).toLocaleString() })}
        {item.verification !== 'unverified' ? <> · {t({ test: '测试记录', integration: '集成测试记录', runtime: '实际运行记录', user_stated: '用户提供', user_confirmed: '用户确认' }[item.verification])}</> : null}<br />
        {item.turnId ? t('轮次 {{id}}', { id: item.turnId }) : t('事件 {{id}}', { id: item.id })}{item.snapshotId ? t(' · 快照 {{id}}', { id: item.snapshotId }) : ''}
        <button className="ui-btn compact" disabled={evidenceBusy} onClick={() => void readEvidence(item.id)}>{t('核对快照依据')}</button>
        {selectedEvidence === item.id ? evidence?.files?.map(file => <button className="ui-btn compact" key={file.path} disabled={evidenceBusy} onClick={() => void readEvidence(item.id, file.path)}>{file.path}</button>) : null}
      </li>)}</ul>
      {evidenceBusy ? <p role="status">{t('正在读取轮次快照…')}</p> : null}
      {evidenceError ? <p role="alert">{t('证据读取失败：{{error}}', { error: evidenceReasonKeys.has(evidenceError) ? t(evidenceError) : evidenceError })}</p> : null}
      {evidence?.status === 'unavailable' ? <p>{t('依据不可用：{{reason}}', { reason: evidence.reason && evidenceReasonKeys.has(evidence.reason) ? t(evidence.reason) : evidence.reason })}</p> : null}
      {evidence?.diff ? <pre className="knowledge-diff">{evidence.diff}</pre> : null}
      {record.history.length ? <p>{t('修订历史：{{history}}', { history: record.history.map(item => `r${item.revision} ${item.summary}`).join(' → ') })}</p> : null}
      {record.history.length ? <ul>{[...record.history].reverse().map(version=><li key={version.revision}>
        <span>r{version.revision} · {version.summary} · {t(statuses[version.status])}</span>{' '}
        <button type="button" className="ui-btn compact" disabled={busy} onClick={()=>onRestore(record,version.revision)}>{t('恢复版本 r{{revision}}', {revision:version.revision})}</button>
      </li>)}</ul> : null}
      {editing ? <form onSubmit={event => { event.preventDefault(); const draft={ ...record, ...fields, repoKey: repoKey.trim() || undefined, branch: branch.trim() || undefined, exceptions: fields.exceptions.split('\n').map(value => value.trim()).filter(Boolean), summary, applicability: conditions.split('\n').map(value => value.trim()).filter(Boolean) }; if(promoting)void onPromote(record,draft).then(ok=>{if(ok){setEditing(false);setPromoting(false);}});else onRevise(record,draft); }}>
        {promoting ? <p>{t('此副本可被所有工作区读取。请检查并移除项目路径、隐私信息和不适用条件。')}</p> : null}
        <label>{t('记忆结论')}<textarea className="ui-input" aria-label={t('记忆结论')} value={summary} onChange={event => setSummary(event.target.value)} required maxLength={1500} /></label>
        <label>{t('适用条件（每行一条）')}<textarea className="ui-input" aria-label={t('适用条件（每行一条）')} value={conditions} onChange={event => setConditions(event.target.value)} /></label>
        <label>{t('适用仓库')}<input className="ui-input" aria-label={t('适用仓库')} value={repoKey} onChange={event => setRepoKey(event.target.value)} maxLength={500} /></label>
        <label>{t('适用分支')}<input className="ui-input" aria-label={t('适用分支')} value={branch} onChange={event => setBranch(event.target.value)} maxLength={300} /></label>
        <p>{t('清空仓库或分支会扩大适用范围；来源快照仍保留原始范围。')}</p>
        {([['problem', '问题'], ['action', '方法'], ['rationale', '判断依据'], ['expectedFutureUse', '未来用途'], ['exceptions', '例外（每行一条）']] as const).map(([key, label]) => <label key={key}>{t(label)}<textarea className="ui-input" aria-label={t(label)} value={fields[key]} maxLength={1500} onChange={event => setFields(current => ({ ...current, [key]: event.target.value }))} /></label>)}
        <button className="ui-btn primary compact" disabled={busy} type="submit">{t(promoting?'确认复制到工作台':'保存并生效')}</button><button className="ui-btn compact" type="button" disabled={busy} onClick={() => {setEditing(false);setPromoting(false);}}>{t('取消编辑')}</button>
      </form> : null}
    </div></div></div> : null}
  </article>;
}

/** Lists and optional corrections are separate from automatic admission; no approval actions. */
export function KnowledgePanel({ api, workspaceKey, initialTab = 'active', initialNamespace = 'all', focusEntryId, embedded = false, allowHistory = false, page, sharedSnapshot, onNavigateEntry }: {
  api: KnowledgeApi; workspaceKey: string; initialTab?: Tab; initialNamespace?: string; focusEntryId?: string;
  embedded?: boolean; allowHistory?: boolean; page?: 'entries' | 'profile' | 'review' | 'approvals' | 'recycle' | 'history';
  sharedSnapshot?: KnowledgeSnapshot | null; onNavigateEntry?: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [localSnapshot, setSnapshot] = useState<{ workspaceKey: string; data: KnowledgeSnapshot } | null>(null), [tab, setTab] = useState<Tab>(initialTab);
  const snapshot = sharedSnapshot !== undefined ? sharedSnapshot : localSnapshot?.workspaceKey === workspaceKey ? localSnapshot.data : null;
  const [query, setQuery] = useState(''), [namespace, setNamespace] = useState(initialNamespace), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>(initialTab === 'pending' ? 'processing' : 'all');
  const [searchHits, setSearchHits] = useState<KnowledgeHit[] | null>(null), [pageSize, setPageSize] = useState(30);
  const [observed, setObserved] = useState<{ workspaceKey: string; records: Record<string, ObservedRecord> }>({ workspaceKey, records: {} });
  const [confirmedDeletion,setConfirmedDeletion] = useState<{workspaceKey:string;id:string;revision:number}|null>(null);
  const [confirmedChange,setConfirmedChange] = useState<{workspaceKey:string;record:KnowledgeRecord;fromRevision:number}|null>(null);
  const generation = useRef(0), searchContext = useRef('');
  const focusRequest = useRef<{ workspaceKey: string; entryId: string | undefined; applied: boolean } | null>(null);
  const isHistory = tab === 'history' || tab === 'retired';
  const observedRecords = observed.workspaceKey === workspaceKey ? observed.records : {};
  const currentRecords = new Map((snapshot?.records ?? []).map(record => [record.id, record]));
  const deletedIds = new Set(snapshot?.deletedIds ?? []);
  for (const [id, known] of Object.entries(observedRecords)) {
    const current = currentRecords.get(id);
    if (!current || known.record.revision >= current.revision) {
      currentRecords.set(id, known.record);
      if (known.deleted) deletedIds.add(id);
      else if (!current || known.record.revision > current.revision) deletedIds.delete(id);
    }
  }
  const knownRecords = [...currentRecords.values()];
  searchContext.current = JSON.stringify([query, namespace, tab, stateFilter, workspaceKey]);
  useEffect(() => {
    setObserved(previous => {
      const prior = previous.workspaceKey === workspaceKey ? previous.records : {};
      const next = { ...prior }, snapshotDeletedIds = new Set(snapshot?.deletedIds ?? []);
      let changed = previous.workspaceKey !== workspaceKey;
      for (const record of snapshot?.records ?? []) {
        const known = prior[record.id], deleted = snapshotDeletedIds.has(record.id);
        // Retired versions are revision floors; a later authoritative restore may supersede them.
        if (!known && !retiredRecord(record, deleted)) continue;
        if (!known || record.revision > known.record.revision || record.revision === known.record.revision && deleted && !known.deleted) {
          next[record.id] = { record, deleted }; changed = true;
        }
      }
      return changed ? { workspaceKey, records: next } : previous;
    });
  }, [snapshot, workspaceKey]);
  useEffect(() => { setPageSize(30); setSearchHits(null); }, [tab, query, namespace, stateFilter, workspaceKey]);
  const refresh = useCallback(async (afterDeletion = false) => {
    // Read the shared i18n instance at completion without binding this callback
    // to react-i18next's locale-specific function identity.
    const t = translate;
    const token = ++generation.current; setBusy(true); setError(''); setSearchHits(null);
    try { const data = await api.list(); if (token === generation.current) setSnapshot({ workspaceKey, data }); }
    catch (failure) { if (token === generation.current) setError(t(afterDeletion ? '记忆列表刷新失败：{{error}}。已确认的删除仍然生效。' : '记忆列表刷新失败：{{error}}', { error: String((failure as Error).message ?? failure) })); }
    finally { if (token === generation.current) setBusy(false); }
  }, [api, workspaceKey]);
  useEffect(() => { setSnapshot(null); setQuery(''); void refresh(); return () => { generation.current++; }; }, [refresh]);
  useEffect(() => {
    if (!focusRequest.current || focusRequest.current.workspaceKey !== workspaceKey || focusRequest.current.entryId !== focusEntryId) {
      focusRequest.current = { workspaceKey, entryId: focusEntryId, applied: false };
    }
    const request = focusRequest.current;
    if (!focusEntryId || request.applied) return;
    const record = currentRecords.get(focusEntryId);
    if (!record) return;
    // A route is an initial navigation request, not a filter to reapply on every background snapshot.
    request.applied = true;
    setQuery(record.summary); setNamespace(record.namespace); setTab(retiredRecord(record, deletedIds.has(record.id)) ? 'retired' : record.kind === 'task_fact' ? 'history' : 'active'); setStateFilter('all');
  }, [workspaceKey, focusEntryId, snapshot, observed]);
  const mutate = async (target:KnowledgeRecord,action: () => Promise<KnowledgeRecord>): Promise<void> => {
    const token = ++generation.current; setBusy(true); setError('');setConfirmedChange(null);
    try {
      const receipt=await action();if(token!==generation.current)return;
      if(!receipt||receipt.id!==target.id||receipt.namespace!==target.namespace||receipt.kind!==target.kind||receipt.userManaged!==true||!statuses[receipt.status]||!Number.isInteger(receipt.revision)||receipt.revision<=target.revision)throw new Error(t('操作未返回有效版本回执，请刷新核对。'));
      setObserved(previous=>({workspaceKey,records:{...(previous.workspaceKey===workspaceKey?previous.records:{}),[receipt.id]:{record:receipt,deleted:receipt.status==='rejected'}}}));
      setConfirmedChange({workspaceKey,record:receipt,fromRevision:target.revision});setSearchHits(null);
      setBusy(false);
      // Keep the authoritative receipt visible; a stale shared snapshot cannot undo it.
    } catch (failure) { if (token === generation.current) { setError(String((failure as Error).message ?? failure)); setBusy(false); } }
  };
  const deleteRecord = async (target: KnowledgeRecord): Promise<void> => {
    const token = ++generation.current; setBusy(true); setError('');setConfirmedDeletion(null);
    try {
      const receipt = await api.decide({ id: target.id, revision: target.revision, decision: 'archive' });
      if (token !== generation.current) return;
      if (!receipt || receipt.id !== target.id || receipt.namespace !== target.namespace || !Number.isInteger(receipt.revision) || receipt.revision <= target.revision || receipt.status !== 'rejected') {
        throw new Error(t('删除未返回有效回执，请刷新后核对。'));
      }
      // Only the successful host receipt may retire a card before the next list response.
      setConfirmedDeletion({workspaceKey,id:receipt.id,revision:receipt.revision});
      setObserved(previous => {
        const records = previous.workspaceKey === workspaceKey ? previous.records : {};
        const known = records[receipt.id];
        if (known && known.record.revision > receipt.revision) return previous;
        return { workspaceKey, records: { ...records, [receipt.id]: { record: receipt, deleted: true } } };
      });
      await refresh(true);
    } catch (failure) {
      if (token === generation.current) { setError(t('删除尚未确认：{{error}}。当前列表保留该记忆，请刷新核对。', { error: String((failure as Error).message ?? failure) })); setBusy(false); }
    }
  };
  const semanticSearch = async (): Promise<void> => {
    if (tab === 'retired') return;
    const token = ++generation.current, context = searchContext.current; setBusy(true); setError('');
    try {
      const namespaces: KnowledgeNamespace[] = namespace === 'all' ? ['worker', 'scheduler', 'profile','host'] : [namespace as KnowledgeNamespace];
      const hits = (await Promise.all(namespaces.map(scope => api.search({ query, namespace: scope, mode: tab === 'history' ? 'history' : 'task', limit: 20 })))).flat();
      if (token === generation.current && context === searchContext.current) setSearchHits(hits);
    } catch (failure) { if (token === generation.current) setError(String((failure as Error).message ?? failure)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const policySuppressedIds=new Set((snapshot?.policySuppressedIds??[]).filter(id=>!currentRecords.get(id)?.userManaged));
  const candidates = searchHits ? searchHits.map(hit => {
    const current = currentRecords.get(hit.record.id);
    return current && (current.revision >= hit.record.revision || retiredRecord(current, deletedIds.has(current.id))) ? current : hit.record;
  }) : knownRecords;
  const records = candidates.filter(record =>
    (page === 'profile' ? record.namespace === 'profile' : namespace === 'all' || record.namespace === namespace) &&
    (tab === 'retired' ? retiredRecord(record, deletedIds.has(record.id)) : tab === 'history' ? record.kind === 'task_fact' && !retiredRecord(record, deletedIds.has(record.id)) :
      record.kind !== 'task_fact' && !retiredRecord(record, deletedIds.has(record.id)) && (stateFilter === 'all' || stateFilter === 'active' && record.status === 'active'&&!policySuppressedIds.has(record.id) || stateFilter === 'processing' && record.status === 'pending' || stateFilter === 'inactive' && (policySuppressedIds.has(record.id)||record.status === 'needs_revalidation'))) &&
    (searchHits !== null || !query || [record.summary, record.problem, record.action, ...record.applicability, ...(record.searchKeys ?? [])].join(' ').toLowerCase().includes(query.toLowerCase()))
  ).sort((a, b) => b.updatedAt - a.updatedAt);
  return <section className={`${embedded ? '' : 'memory-panel '}knowledge-panel`} aria-label={t(embedded ? '记忆条目' : '记忆中心')}>
    {!embedded ? <><header className="knowledge-header"><div><h2>{t('记忆中心')}</h2><p>{t('记忆子系统自动整理；你可以查看依据、纠正或删除。')}</p></div></header>
      <nav aria-label={t('记忆分类')} className="knowledge-tabs"><button className={`memory-chip${!isHistory ? ' is-active' : ''}`} aria-pressed={!isHistory} onClick={() => setTab('active')}>{t('长期知识')}</button><button className={`memory-chip${isHistory ? ' is-active' : ''}`} aria-pressed={isHistory} onClick={() => setTab('history')}>{t('任务历史')}</button></nav></> : null}
    <div className="knowledge-toolbar">
      {allowHistory ? <CustomSelect ariaLabel={t('内容类型')} value={isHistory ? 'history' : 'active'} onChange={value => setTab(value as Tab)} options={[{ value: 'active', label: t('长期知识') }, { value: 'history', label: t('任务历史') }]} /> : null}
      {isHistory ? <CustomSelect ariaLabel={t('历史类型')} value={tab} onChange={value => setTab(value as Tab)} options={[{ value: 'history', label: t('任务事实') }, { value: 'retired', label: t('退场与删除记录') }]} /> : null}
      <CustomSelect ariaLabel={t('记忆范围')} value={namespace} onChange={setNamespace} options={[{ value: 'all', label: t('全部范围') }, ...Object.entries(scopes).map(([value, label]) => ({ value, label: t(label) }))]} />
      {!isHistory ? <CustomSelect ariaLabel={t('记忆状态')} value={stateFilter} onChange={value => setStateFilter(value as StateFilter)} options={[{ value: 'all', label: t('全部状态') }, { value: 'active', label: t('已生效') }, { value: 'processing', label: t('整理中') }, { value: 'inactive', label: t('已暂停') }]} /> : null}
      <input className="ui-input" aria-label={t('搜索记忆')} placeholder={t('搜索记忆')} value={query} onChange={event => setQuery(event.target.value)} />
      {tab !== 'retired' ? <button className="ui-btn compact" disabled={busy || !query.trim()} onClick={() => void semanticSearch()}>{t('按含义查找相关记忆')}</button> : null}
      <button className="ui-btn compact" disabled={busy} onClick={() => void refresh()}>{t('刷新')}</button>
    </div>
    {isHistory ? <KnowledgeHistory key={workspaceKey} api={api} /> : null}
    {tab === 'retired' ? <p>{t('这里只保留追溯记录，不会参与常用列表或自动召回。')}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {confirmedChange?.workspaceKey===workspaceKey && currentRecords.get(confirmedChange.record.id)?.revision===confirmedChange.record.revision ? <div role="status">
      {t('已保存 r{{revision}} · {{status}}；后续检索使用当前版本。', {revision:confirmedChange.record.revision,status:t(statuses[confirmedChange.record.status])})}{' '}
      <button type="button" className="ui-btn compact" disabled={busy} onClick={()=>void mutate(confirmedChange.record,()=>api.restore({id:confirmedChange.record.id,revision:confirmedChange.record.revision,fromRevision:confirmedChange.fromRevision}))}>{t('撤销本次修改')}</button>
    </div> : null}
    {confirmedDeletion?.workspaceKey===workspaceKey && (currentRecords.get(confirmedDeletion.id)?.revision??confirmedDeletion.revision)<=confirmedDeletion.revision
      ? <p role="status">{t('已删除，不再参与自动召回。')}</p> : null}
    {busy ? <p role="status">{t('正在处理记忆…')}</p> : null}
    {!busy && !records.length ? <div className="knowledge-empty"><h3>{t(tab === 'retired' ? '没有匹配的退场或删除记录' : tab === 'history' ? '没有匹配的任务历史' : namespace === 'profile' ? '暂无用户画像' : '目前没有匹配的知识')}</h3><p>{t(isHistory ? '任务事实只供追溯，不会作为经验常驻注入。' : 'Agent 发现有用内容时才会提交；没有新增记忆也是正常结果。')}</p></div> : null}
    <div className="knowledge-list">{records.slice(0, pageSize).map(record => {
      const hit = searchHits?.find(item => item.record.id === record.id);
      return <React.Fragment key={`${workspaceKey}:${record.id}`}>
        {hit ? <p>{t('本次召回原因：{{reason}} · {{applicability}}', { reason: localizeKnowledgeHostText(hit.reason), applicability: t(hit.applicability === 'matched' ? '条件匹配' : '条件仍需核对') })}</p> : null}
        <KnowledgeCard record={record} policySuppressed={policySuppressedIds.has(record.id)} deleted={deletedIds.has(record.id)} readOnly={tab === 'retired'} busy={busy} api={api} related={knownRecords} onNavigate={target => { if (onNavigateEntry) { onNavigateEntry(target.id); return; } setTab(retiredRecord(target, deletedIds.has(target.id)) ? 'retired' : target.kind === 'task_fact' ? 'history' : 'active'); setStateFilter('all'); setNamespace(target.namespace); setQuery(target.summary); }}
          onDelete={target => void deleteRecord(target)}
          onRevise={(target, draft) => void mutate(target,() => api.revise({ id: target.id, revision: target.revision, draft }))}
          onConfirm={target=>void mutate(target,()=>api.confirm({id:target.id,revision:target.revision}))}
          onPromote={async(target,draft)=>{
            const token=++generation.current;setBusy(true);setError('');
            try{const receipt=await api.promoteHost({id:target.id,revision:target.revision,draft});if(token!==generation.current)return false;
              if(receipt.namespace!=='host'||receipt.kind!=='reusable_lesson'||!receipt.userManaged)throw new Error(t('操作未返回有效版本回执，请刷新核对。'));
              setObserved(previous=>({workspaceKey,records:{...(previous.workspaceKey===workspaceKey?previous.records:{}),[receipt.id]:{record:receipt,deleted:false}}}));
              setSearchHits(null);setBusy(false);return true;
            }catch(failure){if(token===generation.current){setError(String((failure as Error).message??failure));setBusy(false);}return false;}
          }}
          onStop={target=>void mutate(target,()=>api.decide({id:target.id,revision:target.revision,decision:'revalidate'}))}
          onRestore={(target,fromRevision)=>void mutate(target,()=>api.restore({id:target.id,revision:target.revision,fromRevision}))} />
      </React.Fragment>;
    })}</div>
    {records.length > pageSize ? <button className="ui-btn" onClick={() => setPageSize(value => value + 30)}>{t('再显示 30 条（共 {{n}} 条）', { n: records.length })}</button> : null}
  </section>;
}
