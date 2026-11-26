import type {KnowledgeStore} from './knowledgeStore';
import type {MemoryCenterEventKind,MemoryCenterEventsResult} from '../../shared/memoryCenterIpc';

/** Read the new ledger, never the retired memory_events table. Counts use all rows, not the feed window. */
export function knowledgeActivity(stores:KnowledgeStore[],now=Date.now()):MemoryCenterEventsResult {
  const kinds:Record<string,MemoryCenterEventKind>={auto_admitted:'auto_admitted',auto_corrected:'auto_admitted',evidence_linked:'evidence_linked',
    conflict_suspended:'conflict_suspended',auto_superseded_source:'auto_admitted',auto_superseded_target:'superseded',user_deleted:'user_deleted',
    user_restored:'auto_admitted',user_revised:'direct_write',user_stopped:'conflict_suspended',user_restored_inactive:'superseded',user_revised_inactive:'superseded',remembered:'direct_write',governance_merge:'superseded',superseded_source:'superseded',governance_history:'superseded',archive:'superseded'};
  const today=new Date(now);today.setHours(0,0,0,0);
  const activatedToday=new Set<string>();
  const result:MemoryCenterEventsResult={items:[],todayActivations:0,kindCounts24h:{},kindCounts7d:{}};
  stores.forEach((store,index)=>{
    const activations=store.db.prepare("SELECT DISTINCT record_id FROM events WHERE record_id IS NOT NULL AND kind IN ('auto_admitted','auto_corrected','auto_superseded_source','user_restored','user_revised') AND at>=? AND at<=?").all(today.getTime(),now) as Array<{record_id:string}>;
    for(const activation of activations)activatedToday.add(activation.record_id);
    const counts=store.db.prepare("SELECT e.kind,json_extract(r.payload,'$.namespace') namespace,COUNT(*) total,SUM(CASE WHEN e.at>=? THEN 1 ELSE 0 END) recent FROM events e LEFT JOIN records r ON r.id=e.record_id WHERE e.at>=? AND e.at<=? GROUP BY e.kind,namespace").all(now-86400000,now-7*86400000,now) as Array<{kind:string;namespace:string;total:number;recent:number}>;
    for(const row of counts){const kind=row.kind==='remembered'&&row.namespace==='profile'?'profile_write':kinds[row.kind];if(!kind)continue;result.kindCounts24h[kind]=(result.kindCounts24h[kind]??0)+Number(row.recent);result.kindCounts7d[kind]=(result.kindCounts7d[kind]??0)+Number(row.total);}
    const events=store.db.prepare('SELECT id,record_id,kind,at,detail FROM events WHERE at<=? ORDER BY at DESC,id DESC LIMIT 200').all(now) as Array<{id:number;record_id:string;kind:string;at:number;detail:string}>;
    // Resolve only the records referenced by the bounded activity feed. The
    // previous implementation materialized the entire knowledge ledger here,
    // defeating bounded knowledge:list reads for large workspaces.
    const ids=[...new Set(events.map(row=>row.record_id).filter(Boolean))];
    const records=new Map<string,{namespace:string}>();
    if(ids.length){
      const placeholders=ids.map(()=>'?').join(',');
      for(const row of store.db.prepare(`SELECT id,payload FROM records WHERE id IN (${placeholders})`).all(...ids) as Array<{id:string;payload:string}>){
        try { const parsed=JSON.parse(row.payload) as {namespace?:unknown}; if(typeof parsed.namespace==='string')records.set(row.id,{namespace:parsed.namespace}); } catch { /* corrupt rows remain visible as unknown */ }
      }
    }
    for(const row of events){const record=records.get(row.record_id);const kind=row.kind==='remembered'&&record?.namespace==='profile'?'profile_write':kinds[row.kind];if(!kind)continue;
      result.items.push({id:row.id*10+index,kind,ts:row.at,namespace:record?.namespace??null,stagingId:null,approvalId:null,chunkId:null,entryRef:row.record_id,summary:row.detail,summaryArgs:null});
    }
  });
  result.todayActivations=activatedToday.size;
  result.items.sort((a,b)=>b.ts-a.ts||b.id-a.id);result.items=result.items.slice(0,200);return result;
}
