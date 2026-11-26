// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {AppContext} from '../../../src/main/context';
import type {SessionMeta} from '../../../src/shared/types';
import type {GuiRuntimeConnection} from '../../../src/main/agentSession/types';
const env=vi.hoisted(()=>({root:''}));
vi.mock('electron',()=>({app:{getPath:()=>env.root}}));
import {AgentSessionHost} from '../../../src/main/agentSession/host/agentSessionHost';
import {GuiSessionStore} from '../../../src/main/agentSession/persist';
import {ownArchiveOperation,archiveOperationFor} from '../../../src/main/agentSession/host/archiveOwnership';
import {getNodeReplManager} from '../../../src/main/agentSession/tools/nodeRepl';
vi.stubGlobal('window',globalThis);
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function fixture(){
  env.root=fs.mkdtempSync(path.join(os.tmpdir(),'gui-archive-'));roots.push(env.root);
  const meta={id:'archive',name:'Archive',type:'terminal',runtime:'codex-gui',workspaceId:'ws',cwd:env.root,createdAt:1} as SessionMeta;
  const initial=new GuiSessionStore(env.root);initial.save(meta.id,[{id:'old',role:'assistant',ts:1,parts:[{kind:'text',text:'keep history'}]}]);initial.flushSync();
  const background=vi.fn(async()=>{});
  const ctx={config:{get:()=>({activeWorkspaceId:'ws',workspaces:[{id:'ws',name:'Workspace',path:env.root}]})},
    sessions:{get:(id:string)=>id===meta.id?meta:undefined,engineSweepRoster:()=>[meta],rootDependencyRoster:()=>[meta],list:()=>[meta],
      applyActivitySignal:vi.fn(),setQueuedInjects:vi.fn(),setBoardReplyPreview:vi.fn()},
    bgTasks:{killAllForSessionAndWait:background},store:{loadSessions:()=>[meta]},getWindow:()=>null} as unknown as AppContext;
  const host=new AgentSessionHost(ctx,{userDataDir:env.root});host.open(meta);
  return{host,meta,background};
}
describe('GUI archive owns resource retirement',()=>{
  it('publishes the archive owner before synchronous reentry and rejects synchronous throws',async()=>{
    const {host,meta}=fixture();let nested:Promise<void>|undefined;
    const duplicate=vi.fn(async()=>{});
    const original=ownArchiveOperation(host,meta.id,()=>{
      nested=ownArchiveOperation(host,meta.id,duplicate);
      expect(archiveOperationFor(host,meta.id)).toBe(nested);
      throw new Error('synchronous owner failure');
    });
    expect(nested).toBe(original);expect(duplicate).not.toHaveBeenCalled();
    await expect(original).rejects.toThrow('synchronous owner failure');
    await Promise.resolve();expect(archiveOperationFor(host,meta.id)).toBeUndefined();
    await host.closeAll();
  });
  it('waits for background, repl and native close while releasing the writer and preserving history',async()=>{
    const {host,meta,background}=fixture();const entry=host.materializeForExecution(meta.id);
    const bg=deferred(),repl=deferred(),native=deferred();
    background.mockImplementationOnce(()=>bg.promise);
    vi.spyOn(getNodeReplManager(),'dispose').mockImplementationOnce(()=>repl.promise);
    const close=vi.fn(()=>native.promise);
    entry.connection={close} as unknown as GuiRuntimeConnection;
    const storage=vi.spyOn(host.store,'release');let finished=false;
    const archiving=host.release(meta.id).then(()=>{finished=true;});
    await vi.waitFor(()=>expect(storage).toHaveBeenCalledOnce());
    expect(close).toHaveBeenCalledOnce();expect(entry.connection).toBeNull();expect(entry.clearing).toBe(true);
    expect(entry.messages[0].id).toBe('old');expect(finished).toBe(false);
    bg.resolve();native.resolve();await Promise.resolve();expect(finished).toBe(false);
    repl.resolve();await archiving;expect(entry.clearing).toBe(false);
    expect(host.isOpen(meta.id)).toBe(false);expect(entry.closed).toBe(true);
    await expect(host.send(meta.id,'archived send')).rejects.toThrow('GUI 会话未打开');
    expect(host.store.loadRangeSnapshot(meta.id,undefined,1).messages[0].id).toBe('old');
    host.open(meta);const retain=vi.spyOn(host.store,'retain');
    const restored=host.materializeForExecution(meta.id);expect(restored).not.toBe(entry);expect(retain).toHaveBeenCalledOnce();expect(restored.messages[0].id).toBe('old');
    await host.closeAll();
  });
  it('reclaims independent owners after failures and keeps the failure as a reopen barrier',async()=>{
    const {host,meta,background}=fixture();const entry=host.materializeForExecution(meta.id);
    background.mockRejectedValueOnce(new Error('background retirement failed'));
    vi.spyOn(getNodeReplManager(),'dispose').mockRejectedValueOnce(new Error('repl retirement failed'));
    entry.connection={close:vi.fn(async()=>{throw new Error('native retirement failed');})} as unknown as GuiRuntimeConnection;
    const storage=vi.spyOn(host.store,'release');
    await expect(host.release(meta.id)).rejects.toThrow(/background retirement failed.*repl retirement failed/);
    expect(storage).toHaveBeenCalledOnce();expect(entry.connection).toBeNull();expect(entry.clearing).toBe(false);
    host.open(meta);expect(()=>host.materializeForExecution(meta.id)).toThrow(/清理失败/);
    await expect(host.closeAll()).rejects.toThrow('GUI session shutdown failed');
  });
  it('shares a failed cold materialization writer and waits for archive-only background and repl owners',async()=>{
    const {host,meta,background}=fixture();const writer=deferred(),bg=deferred(),repl=deferred();
    const original=host.store.release.bind(host.store);
    const release=vi.spyOn(host.store,'release').mockImplementationOnce(async id=>{await writer.promise;await original(id);});
    vi.spyOn(host.store,'loadSnapshot').mockImplementationOnce(()=>{throw new Error('restore failed');});
    expect(()=>host.materializeForExecution(meta.id)).toThrow('restore failed');
    background.mockImplementationOnce(()=>bg.promise);
    vi.spyOn(getNodeReplManager(),'dispose').mockImplementationOnce(()=>repl.promise);
    let finished=false;const archiving=host.release(meta.id).then(()=>{finished=true;});
    await vi.waitFor(()=>expect(release).toHaveBeenCalledOnce());
    let closed=false;const closing=host.close(meta.id).then(()=>{closed=true;});
    expect(()=>host.open(meta)).toThrow('正在归档');
    writer.resolve();await Promise.resolve();expect(finished).toBe(false);expect(closed).toBe(false);
    bg.resolve();repl.resolve();await archiving;await closing;expect(release).toHaveBeenCalledOnce();
    expect(host.entries.size).toBe(0);await host.closeAll();
  });
});
