import type {GuiCompactionRecord,GuiInjectionSnapshot} from '../../shared/guiWorker';
import type {GuiHistoryMetadataWindow,GuiInjectionDetailRef,GuiInjectionSummary,GuiMetadataKind,GuiMetadataTimelinePage} from '../../shared/guiHistoryMetadata';
import {summarizeGuiInjection} from './guiMetadataRangeIndex';

type Timed<T>={ordinal:number;value:T};
function upperBound<T extends {at:number}>(rows:readonly Timed<T>[],at:number):number{
  let lo=0,hi=rows.length;while(lo<hi){const middle=Math.floor((lo+hi)/2);if(rows[middle].value.at<=at)lo=middle+1;else hi=middle;}return lo;
}
function insert<T extends {at:number}>(rows:Timed<T>[],row:Timed<T>):void{
  let lo=0,hi=rows.length;while(lo<hi){const middle=Math.floor((lo+hi)/2),other=rows[middle];if(other.value.at<row.value.at||other.value.at===row.value.at&&other.ordinal<row.ordinal)lo=middle+1;else hi=middle;}rows.splice(lo,0,row);
}
/** Execution already owns the canonical full metadata. This auxiliary index
 * computes a fingerprint once per metadata change, not once per message/page. */
export class GuiMetadataProjectionIndex{
  private injections:Timed<GuiInjectionSummary>[]=[];
  private compactions:Timed<GuiCompactionRecord>[]=[];
  private detailOrdinals=new Map<string,number>();
  constructor(injections:readonly GuiInjectionSnapshot[],compactions:readonly GuiCompactionRecord[]){
    this.injections=injections.map((snapshot,ordinal)=>({ordinal,value:summarizeGuiInjection(snapshot)})).sort((a,b)=>a.value.at-b.value.at||a.ordinal-b.ordinal);
    for(const row of this.injections)this.detailOrdinals.set(row.value.details.key,row.ordinal);
    this.compactions=compactions.map((value,ordinal)=>({ordinal,value:structuredClone(value)})).sort((a,b)=>a.value.at-b.value.at||a.ordinal-b.ordinal);
  }
  appendInjection(ordinal:number,value:GuiInjectionSummary):GuiInjectionSummary{
    insert(this.injections,{ordinal,value});this.detailOrdinals.set(value.details.key,ordinal);return value;
  }
  upsertCompaction(ordinal:number,record:GuiCompactionRecord):void{
    const previous=this.compactions.findIndex(row=>row.ordinal===ordinal);if(previous>=0)this.compactions.splice(previous,1);
    insert(this.compactions,{ordinal,value:structuredClone(record)});
  }
  detailOrdinal(ref:GuiInjectionDetailRef):number|undefined{return this.detailOrdinals.get(ref.key);}
  window(timestamps:readonly number[]):GuiHistoryMetadataWindow{
    if(timestamps.length>121)throw new Error('GUI metadata window exceeds message budget');
    const times=timestamps.filter(Number.isFinite),positions=new Set<number>();
    for(const time of times)if(this.injections.length)positions.add(Math.max(0,upperBound(this.injections,time)-1));
    const injections=[...positions].sort((a,b)=>a-b).map(position=>this.injections[position].value);
    const from=times.length?Math.min(...times):Infinity,to=times.length?Math.max(...times):Infinity;
    const start=Math.max(0,upperBound(this.compactions,from)-1),end=upperBound(this.compactions,to),retainedStart=Math.max(start,end-120);
    return structuredClone({injections,compactions:this.compactions.slice(retainedStart,end).map(row=>row.value),
      injectionCount:this.injections.length,compactionCount:this.compactions.length,compactionsOverflow:retainedStart>start});
  }
  timeline(kind:GuiMetadataKind,before?:number,limit=120):GuiMetadataTimelinePage{
    if(before!==undefined&&!Number.isSafeInteger(before))throw new Error('Invalid GUI metadata cursor');
    const rows=kind==='injections'?this.injections:this.compactions,total=rows.length;
    const end=before===undefined?total:Math.max(0,Math.min(total,before)),take=Number.isFinite(limit)?Math.max(1,Math.min(120,Math.floor(limit))):120,start=Math.max(0,end-take);
    return structuredClone({kind,records:rows.slice(start,end).map(row=>row.value),before:start,total,hasEarlier:start>0});
  }
}
