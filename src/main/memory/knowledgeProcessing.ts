import {createHash} from 'node:crypto';
import type {KnowledgePipeline} from './knowledgePipeline';

/** One line per failed event; a legacy processing checkpoint may repeat those same failures. */
export function knowledgeProcessingStatus(pipeline:KnowledgePipeline,namespace:string):{pending:number;failed:number;errors:string[]} {
  const rows=pipeline.store.db.prepare("SELECT id,error FROM source_events WHERE state='failed' ORDER BY created_at DESC,id").all() as Array<{id:string;error:string}>;
  const errors=rows.slice(0,20).map(row=>`${namespace==='worker'?'工作区':'调度'}事件 ${createHash('sha256').update(row.id).digest('hex').slice(0,8)}：${row.error}`);
  const summary=pipeline.store.checkpoint('processing:error');
  if(summary){
    const redundant=rows.some(row=>summary===`${row.id}: ${row.error}`)||
      (rows.length>0&&summary.split('\n').every(line=>rows.some(row=>line===`${row.id}: ${row.error}`)));
    if(!redundant)errors.push(summary);
  }
  const maintenance=pipeline.store.checkpoint('consolidation:error');if(maintenance)errors.push(maintenance);
  return {pending:pipeline.pending(),failed:rows.length,errors};
}
