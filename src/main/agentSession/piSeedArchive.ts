import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type * as Pi from '@earendil-works/pi-coding-agent';
import type {Api} from '@earendil-works/pi-ai';
import type {GuiSeedMessage} from './types';

type ArchiveApi=Pick<typeof Pi,'SessionManager'>;
const zeroUsage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
/** Produce SDK-native wire entries with a single-record scratch manager. The
 * actual engine may later load its own context; archive preparation does not. */
export function writePiSeedArchive(pi:ArchiveApi,input:{sessionId:string;cwd:string;directory:string;seeds:Iterable<GuiSeedMessage>;model:{api:string;provider:string;id:string};onScratchSize?:(count:number)=>void}):{file:string;count:number}{
  const manager=pi.SessionManager.inMemory(input.cwd,{id:input.sessionId});
  const header=manager.getHeader();if(!header)throw new Error('GUI seed archive header is unavailable');
  const file=path.join(input.directory,`${header.timestamp.replace(/[:.]/g,'-')}_${header.id}.jsonl`);
  const fd=fs.openSync(file,'wx',0o600);let complete=false,count=0,parentId:string|null=null;
  try{
    fs.writeFileSync(fd,JSON.stringify(header)+'\n');
    for(const seed of input.seeds){
      if(!seed||!['user','assistant'].includes(seed.role)||typeof seed.text!=='string'||!Number.isFinite(seed.ts))throw new Error('Invalid GUI seed archive record');
      if(seed.role==='user')manager.appendMessage({role:'user',content:seed.text,timestamp:seed.ts||Date.now()});
      else manager.appendMessage({role:'assistant',content:[{type:'text',text:seed.text}],timestamp:seed.ts||Date.now(),
        api:input.model.api as Api,provider:input.model.provider,model:input.model.id,usage:structuredClone(zeroUsage),stopReason:'stop'});
      const entries=manager.getEntries();input.onScratchSize?.(entries.length);
      if(entries.length!==1)throw new Error('GUI seed archive scratch state is not bounded');
      const entry:Pi.SessionEntry={...entries[0],id:randomUUID(),parentId};
      fs.writeFileSync(fd,JSON.stringify(entry)+'\n');parentId=entry.id;count++;
      manager.newSession();
    }
    complete=true;return {file,count};
  }finally{fs.closeSync(fd);if(!complete)fs.rmSync(file,{force:true});}
}
