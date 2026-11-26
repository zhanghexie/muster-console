import {CustomSelect} from './CustomSelect';
import React,{useEffect,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {KnowledgeApi,KnowledgeHistorySource} from '../../../shared/knowledge';
import {KNOWLEDGE_HISTORY_TRUNCATION_NOTE} from '../../../shared/knowledge';
import {usePresence} from './motion';

export function KnowledgeHistory({api}:{api:KnowledgeApi}):React.JSX.Element {
  const {t}=useTranslation();
  const [open,setOpen]=useState(false),[sources,setSources]=useState<KnowledgeHistorySource[]>([]),[sessionId,setSession]=useState(''),[query,setQuery]=useState('');
  const [result,setResult]=useState<Awaited<ReturnType<KnowledgeApi['history']>>|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),presence=usePresence(open);
  const historyText=(message:NonNullable<typeof result>['messages'][number])=>{
    const marker=`\n${KNOWLEDGE_HISTORY_TRUNCATION_NOTE}`;
    return message.textTruncated&&message.text.endsWith(marker)?`${message.text.slice(0,-marker.length)}\n${t(KNOWLEDGE_HISTORY_TRUNCATION_NOTE)}`:message.text;
  };
  const historyState=(state:string)=>state==='已中止'?t('已中止'):state==='失败'?t('失败'):state==='原始记录'?t('原始记录'):state;
  useEffect(()=>()=>{generation.current++;},[]);
  const toggle=async()=>{
    generation.current++;setBusy(false);setOpen(!open);setError('');
    if(open)return;const token=generation.current;setBusy(true);
    try{const list=await api.historySources();if(token===generation.current){setSources(list);setSession(list[0]?.id??'');setResult(null);}}
    catch(e){if(token===generation.current)setError(String((e as Error).message));}
    finally{if(token===generation.current)setBusy(false);}
  };
  const search=async()=>{const token=++generation.current;setBusy(true);setError('');setResult(null);
    try{const value=await api.history({sessionId,query});if(token===generation.current)setResult(value);}
    catch(e){if(token===generation.current)setError(String((e as Error).message));}
    finally{if(token===generation.current)setBusy(false);}
  };
  return <section aria-label={t('原始会话查询')}><button className="ui-btn compact" aria-expanded={open} onClick={()=>void toggle()}>{t(open?'关闭原始会话查询':'查询原始会话（含切换前历史）')}</button>
    {presence.mounted?<div className={`acc${presence.stage==='in'?' is-open':''}`} {...presence.spread} {...(!open?{inert:'' as unknown as boolean}:{})}><div className="acc-body"><div className="knowledge-details">
      <p>{t('只读当前工作区的原始会话，不重新提炼记忆。旧快照不代表当前代码。')}</p>
      <label>{t('原始会话')}<CustomSelect ariaLabel={t('原始会话')} disabled={busy} value={sessionId} onChange={value=>{setSession(value);setResult(null);}} options={sources.map(s=>({value:s.id,label:s.namespace==='scheduler'?t('调度 · {{name}}',{name:s.id==='scheduler'&&s.name==='调度原始会话'?t('调度原始会话'):s.name}):s.name}))}/></label>
      <form onSubmit={e=>{e.preventDefault();void search();}}><label>{t('历史关键词')}<input className="ui-input" aria-label={t('历史关键词')} maxLength={500} value={query} disabled={busy} onChange={e=>setQuery(e.target.value)}/></label><button className="ui-btn compact" disabled={busy||!sessionId}>{t('查询原文')}</button></form>
      {busy?<p role="status">{t('正在读取原始会话…')}</p>:null}{error?<p role="alert">{error}</p>:null}
      {!busy&&!sources.length?<p>{t('没有可读取的原始会话。')}</p>:null}
      {result?<><p>{t('{{n}} 条匹配',{n:result.messages.length})}{result.truncated?t('；仅显示最后50条，请缩小关键词范围'):''}</p>{result.messages.map(m=><article className="knowledge-card" key={m.id}><p>{t(m.role==='user'?'用户':'助手')} · {new Date(m.at).toLocaleString()} · {historyState(m.state)}</p><pre className="knowledge-diff">{historyText(m)}</pre><p>{t('轮次 {{id}}',{id:m.id})}{m.snapshotId?t(' · 快照 {{id}}',{id:m.snapshotId}):''}</p></article>)}</>:null}
    </div></div></div>:null}
  </section>;
}
