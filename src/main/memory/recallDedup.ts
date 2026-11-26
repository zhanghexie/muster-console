/** Only the immediately preceding, confirmed delivery in the same context can be shortened. */
type Delivery={connection:object;epoch:string;turn:string;blocks:Map<string,string>};
const states=new WeakMap<object,{committed?:Delivery;pending?:Delivery}>();

export function prepareRecall(owner:object,connection:object|null,epoch:string|undefined,turn:string,text:string):string {
  let state=states.get(owner);if(!state){state={};states.set(owner,state);}
  if(state.pending){state.committed=undefined;state.pending=undefined;}
  if(!connection||epoch===undefined){state.committed=undefined;return text;}
  const prior=state.committed?.connection===connection&&state.committed.epoch===epoch?state.committed:undefined;
  const parts=text.split(/\n(?=- \[)/),header=parts.shift()??'',blocks=new Map<string,string>();
  const rendered=parts.map(block=>{
    const first=block.split('\n',1)[0]??'',match=/^- \[([^\]]+)\]/.exec(first);
    if(!match)return block;
    blocks.set(match[1]!,block);
    if(prior?.blocks.get(match[1]!)!==block)return block;
    const verification=/\n  依据：([^；\n]+)/.exec(block)?.[1];
    const notices=block.split('\n').filter(line=>line.startsWith('  ')&&(/环境参数可能已变化|分支|\bbranch\b/i.test(line)));
    return `${first}${verification?` · 依据：${verification}`:''}（上一轮已提供，详情用 memory.get）${notices.length?`\n${notices.join('\n')}`:''}`;
  });
  state.pending={connection,epoch,turn,blocks};
  return parts.length?`${header}\n${rendered.join('\n')}`:text;
}
export function finishRecall(owner:object,connection:object|null,epoch:string|undefined,turn:string,confirmed:boolean):void {
  const state=states.get(owner),pending=state?.pending;if(!state||!pending)return;
  state.committed=confirmed&&connection===pending.connection&&epoch===pending.epoch&&turn===pending.turn?pending:undefined;
  state.pending=undefined;
}
export function clearRecall(owner:object):void {states.delete(owner);}

/** A Pi context must expose its compaction entries; unknown state disables deduplication. */
export function piRecallEpoch(session:{sessionManager?:{getEntries?:()=>unknown[]}}|null):string|undefined {
  try {
    const entries=session?.sessionManager?.getEntries?.();if(!Array.isArray(entries))return undefined;
    return JSON.stringify(entries.filter((item):item is {type:string;id?:string}=>!!item&&typeof item==='object'&&(item as {type?:unknown}).type==='compaction').map(item=>item.id??''));
  }catch{return undefined;}
}
