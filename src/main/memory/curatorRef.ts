import type { MemoryCuratorCandidate, MemoryCuratorReceipt } from '../../shared/memoryCurator';
import type { MemoryService } from './service';

type CandidateSink = (root:string,candidate:MemoryCuratorCandidate)=>MemoryCuratorReceipt;
const sinks=new WeakMap<MemoryService,CandidateSink>();
/** Application binds this once; pure producer tests supply a controlled sink. */
export function setMemoryCandidateSink(service:MemoryService,sink:CandidateSink):void {sinks.set(service,sink);}
export function enqueueMemoryCandidate(service:MemoryService,root:string,candidate:MemoryCuratorCandidate):MemoryCuratorReceipt {
  const sink=sinks.get(service);
  if(!sink)throw new Error('记忆会话尚未装配，候选未受理');
  return sink(root,candidate);
}
