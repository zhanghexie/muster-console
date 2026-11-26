import { ErrorTip } from '../components/ErrorTip';
import { randomUuid } from '../../../shared/randomUuid';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getResolvedLocale, t } from '../../../shared/i18n';
import type { AgentAppDefinition, AppOperation, AppView } from '../../../shared/agentApps';
import { MOTION } from '../components/motion';
import { subscribeAppearance } from '../theme';
import componentHostScript from '../../../main/uiRuntime/bridge.js?raw';
import componentScript from '../../../main/uiRuntime/components.js?raw';
import expressionScript from '../../../main/uiRuntime/expressions.js?raw';
import dataScript from '../../../main/uiRuntime/data-components.js?raw';
import componentStyles from '../../../main/uiRuntime/styles.css?raw';

function pageHtml(html: string, token: string): string {
  // Shared ma-* components, with an app-specific read bridge. View state is ephemeral;
  // mutations remain in host-rendered command controls, so presentation cannot replay writes.
  const labels = JSON.stringify({ readTimeout: t('读取超时'), useAppActions: t('请使用页面底部的应用操作按钮') }).replace(/</g, '\\u003c');
  const bridge = `(() => {
    const token=${JSON.stringify(token)}, pending=new Map(), listeners=new Set(), state={}, ui={}, urls=new Set(); let sequence=0, present, setComponentLocale;
    let labels=${labels};
    const post=(type,body={})=>parent.postMessage({phoneApp:token,type,...body},'*');
    const request=(type,query)=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error(labels.readTimeout))},15000);pending.set(id,{resolve,reject,timer});post(type,{id,query})});
    const notify=()=>listeners.forEach(fn=>fn());
    const fail=error=>post('error',{error:String(error && error.message || error).slice(0,400)});
    const editing=()=>Boolean(document.activeElement?.matches('input,textarea,select,[contenteditable="true"]'));
    addEventListener('focusin',()=>post('interact',{editing:editing()}));
    addEventListener('focusout',()=>queueMicrotask(()=>post('interact',{editing:editing()})));
    window.app=Object.freeze({query:query=>request('query',query),asset:async(id,thumbnail=false)=>{const r=await request('asset',{id,thumbnail:thumbnail===true});const url=URL.createObjectURL(new Blob([new Uint8Array(r.bytes)],{type:r.mime}));urls.add(url);return url},releaseAsset:url=>{if(urls.delete(url))URL.revokeObjectURL(url)},onPresent:fn=>{if(typeof fn!=='function')throw Error('onPresent needs a function');present=fn;post('ready')},select:id=>post('select',{id}),get presentation(){return state.presentation}});
    addEventListener('unload',()=>{urls.forEach(url=>URL.revokeObjectURL(url));urls.clear()});
    window.maUi={version:2,get:(key,fallback)=>Object.hasOwn(state,key)?state[key]:fallback,set:(key,value)=>{if(!Object.is(state[key],value)){state[key]=value;notify()}return Promise.resolve(value)},ensure:(key,value)=>{if(!Object.hasOwn(state,key))state[key]=value;return state[key]},getUi:(key,fallback)=>Object.hasOwn(ui,key)?ui[key]:fallback,setUi:(key,value)=>{if(!Object.is(ui[key],value)){ui[key]=value;notify()}return Promise.resolve(value)},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},isPrivate:()=>true,whenReady:()=>Promise.resolve(),report:()=>{},warn:fail,fail,action:()=>Promise.reject(Error(labels.useAppActions)),onLocaleChange:fn=>{setComponentLocale=fn;fn(document.documentElement.lang)}};
    addEventListener('message',event=>{const m=event.data;if(event.source!==parent||m?.phoneApp!==token)return;if(m.type==='locale'){labels=m.labels;document.documentElement.lang=m.locale;setComponentLocale?.(m.locale)}if(m.type==='result'){const job=pending.get(m.id);if(job){clearTimeout(job.timer);pending.delete(m.id);m.error?job.reject(Error(m.error)):job.resolve(m.result)}}if(m.type==='present'){Object.entries(m.theme||{}).forEach(([key,value])=>document.documentElement.style.setProperty(key,value));state.presentation=m.presentation;try{Promise.resolve(present?.(m.presentation)).catch(fail)}catch(e){fail(e)}}});
    addEventListener('error',e=>fail(e.error||e.message));addEventListener('unhandledrejection',e=>fail(e.reason));
  })();`;
  return `<!doctype html><html lang="${getResolvedLocale()}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>${componentStyles}
    :root{--radius:0px;--bg-card:var(--phone-bg);--bg-input:var(--phone-bg);--ink:var(--phone-fg);--text-2:var(--phone-muted);--action-bg:var(--phone-accent);--action-fg:white}body{margin:0;padding:0;background:var(--phone-bg);color:var(--phone-fg);font-family:'Segoe UI',sans-serif}button,input,textarea,select,.ma-card{border-radius:0!important}ma-card{border:0!important}*{box-sizing:border-box;scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}
    </style><script>${bridge}</script><script>${componentHostScript}</script><script>${expressionScript}</script><script>${componentScript}</script><script>${dataScript}</script></head><body>${html}</body></html>`;
}
export function CustomAppView({ workspaceId, app, view, entityId, operation, revision, select, interact, fallback }: { workspaceId: string; app: AgentAppDefinition; view: AppView; entityId?: string; operation?: AppOperation; revision: number; select: (id: string) => void; interact: (editing: boolean) => void; fallback: () => void }) {
  const { t } = useTranslation();
  const locale = getResolvedLocale();
  const [timedOut, setTimedOut] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null), [error, setError] = useState(''), [ready, setReady] = useState(false);
  const selectRef = useRef(select); selectRef.current = select;
  const interactRef = useRef(interact); interactRef.current = interact;
  const token = useMemo(() => randomUuid(), [workspaceId, app.id, app.version, view.id]);
  const html = useMemo(() => pageHtml(view.html!, token), [view.html, token]);
  useEffect(() => {
    let active = true; setReady(false); setError(''); setTimedOut(false);
    const timeout = window.setTimeout(() => setTimedOut(true), MOTION.breathMs * 3);
    const receive = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.phoneApp !== token || !active) return;
      const message = event.data;
      if (message.type === 'ready') { clearTimeout(timeout); setReady(true); }
      else if (message.type === 'interact') interactRef.current(message.editing === true);
      else if (message.type === 'error') { clearTimeout(timeout); setError(String(message.error).slice(0, 400)); }
      else if (message.type === 'select' && typeof message.id === 'string' && message.id.length <= 128) selectRef.current(message.id);
      else if (message.type === 'query') {
        try {
          const query = message.query;
          if (!query || typeof query !== 'object' || JSON.stringify(query).length > 4000) throw new Error('Invalid query');
          const collection = view.collection ?? query.collection;
          if (!app.collections.some(c => c.id === collection)) throw new Error('Unknown collection');
          const result = await window.api.agentApps.query(workspaceId, { ...query, appId: app.id, collection });
          if (active) frame.current?.contentWindow?.postMessage({ phoneApp: token, type: 'result', id: message.id, result }, '*');
        } catch (err) { if (active) frame.current?.contentWindow?.postMessage({ phoneApp: token, type: 'result', id: message.id, error: String(err) }, '*'); }
      } else if (message.type === 'asset') {
        try {
          const query = message.query;
          if (!query || typeof query.id !== 'string' || query.id.length > 128 || typeof query.thumbnail !== 'boolean') throw new Error('Invalid image request');
          const result = await window.api.agentApps.readImage(workspaceId, app.id, query.id, query.thumbnail);
          if (active) frame.current?.contentWindow?.postMessage({ phoneApp: token, type: 'result', id: message.id, result }, '*');
        } catch (err) { if (active) frame.current?.contentWindow?.postMessage({ phoneApp: token, type: 'result', id: message.id, error: String(err) }, '*'); }
      }
    };
    window.addEventListener('message', receive);
    return () => { active = false; clearTimeout(timeout); window.removeEventListener('message', receive); };
  }, [token]);
  // A locale change updates bridge messages without reloading the author's page.
  useEffect(() => {
    if (!ready || !frame.current) return;
    frame.current.contentWindow?.postMessage({ phoneApp: token, type: 'locale', locale,
      labels: { readTimeout: t('读取超时'), useAppActions: t('请使用页面底部的应用操作按钮') } }, '*');
  }, [ready, token, locale, t]);
  useEffect(() => {
    if (!ready || !frame.current) return;
    const publish = () => {
      if (!frame.current) return;
      const style = getComputedStyle(frame.current), theme = Object.fromEntries(['--phone-bg', '--phone-fg', '--phone-muted', '--phone-accent', '--dur-micro', '--dur-panel', '--dur-exit', '--ease-standard'].map(key => [key, style.getPropertyValue(key)]));
      frame.current.contentWindow?.postMessage({ phoneApp: token, type: 'present', theme, presentation: { entityId, operation, revision } }, '*');
    };
    publish(); return subscribeAppearance(publish);
  }, [ready, token, entityId, operation, revision]);
  return <div className="ap-custom">{error || timedOut ? <><ErrorTip message={error || t('自定义页面未完成展示接入，请使用标准视图')} /><button onClick={fallback}>{t('打开标准视图')}</button></> : <iframe ref={frame} title={`${app.name} · ${view.title}`} sandbox="allow-scripts" srcDoc={html}/>}</div>;
}
