/**
 * MemoryService owns versioned knowledge stores, scoped recall/core injection and lexical search.
 * memory.note/remember enqueue through curatorBindings; the dedicated Pi runtime owns processing.
 * The older staging/index/transcript methods remain for compatibility consumers and replay tests;
 * they are not automatic turn, compaction or journal ingestion paths. See docs/features/memory-system.md.
 */
import fs from 'node:fs';
import type { KnowledgeNamespace, KnowledgeQuery, KnowledgeHit } from '../../shared/knowledge';
import {PROFILE_INJECTION_BUDGET} from '../../shared/knowledge';
import { KnowledgeStore } from './knowledgeStore';
import {KnowledgeSearch} from './knowledgeSearch';
import type {CuratorReferences,CuratorScope} from './curator/storageTypes';
import {pruneCuratorRetention,type CuratorRetentionOptions} from './curatorRetention';
import {assertKnowledgeDirectory,knowledgeDirectory} from './layout';
import {readGitIdentity} from '../git/identity';
import {createHash} from 'node:crypto';
import { formatKnowledgeHits } from './knowledgeRecall';
import { detectRecallIntent } from './recallIntent';
import path from 'node:path';
import { MemoryDb, openMemoryDb, recordRecallStat } from './db';
import { appendEvent } from './events';
import { setProfileWriteObserver } from './userProfile';
import {
  type IndexSyncSummary,
  ensureMemoryIndex,
  syncMemoryIndex,
  USER_MD_SOURCE_PATH,
  watchMemorySources,
  type MemoryWatcherHandle
} from './indexer';
import { type MemorySearchHit, type MemorySearchOptions, searchMemory } from './search';
import { type NoteStagingInput, type NoteStagingResult, noteStaging } from './staging';
import { assembleMemoryInjection } from './injection';
import { getUserProfileFilePath } from './userProfile';
import {
  type IndexSchedulerTranscriptInput,
  type IndexSchedulerTranscriptResult,
  indexSchedulerTranscript
} from './transcriptIndex';
import type {
  MemoryBudgetProfile,
  MemoryInjection,
  MemoryInjectionSection,
  MemorySessionKind
} from './serviceTypes';
import {
  JOURNAL_DIR_REL,
  MEMORY_FILE_REL,
  SCHEDULER_MEMORY_FILE_REL,
  todayKey,
  journalFilePath
} from './paths';

// ---------------------------------------------------------------------------
// 注入 API 合同（§12；B5 实装）。类型真源在 serviceTypes.ts（避免纯模块反向依赖本
// 文件形成环），此处 re-export 保持 B1–B4 的 `from './service'` 导入面不变。
// ---------------------------------------------------------------------------

export type {
  MemoryBudgetProfile,
  MemoryInjection,
  MemoryInjectionSection,
  MemoryInjectionSectionKind,
  MemorySessionKind
} from './serviceTypes';

/**
 * 缺省画像（B5 接线批按「现行注入量级起步」校准——progress B1 TODO 收口）：
 * - scheduler：调度核心=R-12 前缀口径（.muster/scheduler/MEMORY.md ≤6000；journal
 *   不注入——现行调度前缀只带调度记忆+态势，态势不在记忆服务域内）；
 * - worker / chat：共享核心=旧 readMemoryContext 的 16K + 今日 journal 尾 2K。
 * profileChars 为 USER.md 画像槽位（B7 填充，先留接口）。
 */
export const MEMORY_BUDGET_PROFILES: Record<'scheduler' | 'worker' | 'chat', MemoryBudgetProfile> = {
  scheduler: { coreChars: 6_000, journalChars: 0, profileChars: 2_000 },
  worker: { coreChars: 16_000, journalChars: 2_000, profileChars: 2_000 },
  chat: { coreChars: 16_000, journalChars: 2_000, profileChars: 2_000 }
};

const ZERO_BUDGET: MemoryBudgetProfile = { coreChars: 0, journalChars: 0, profileChars: 0 };

/**
 * bootstrap 注入缓存的会话键上限（B5 评审 MINOR-③：调度/worker 会话键长期累积无界
 * ——每键存一份注入结果文本，多工作区长驻进程下会涨；超限按 LRU 淘汰最久未用键，
 * 被淘汰键下次注入走重组装 + 重落账，语义不变只是多一次读）。
 */
export const INJECTION_CACHE_MAX_KEYS = 200;

function defaultBudgetProfileFor(kind: MemorySessionKind): MemoryBudgetProfile {
  if (kind === 'headless' || kind === 'heartbeat' || kind === 'auto') return ZERO_BUDGET;
  return MEMORY_BUDGET_PROFILES[kind] ?? MEMORY_BUDGET_PROFILES.worker;
}

// ---------------------------------------------------------------------------
// 文件版本 token（§7 bootstrap 逐回合刷新判定的地基；memoryVersionToken 同口径）
// ---------------------------------------------------------------------------

/** 单文件版本片段：`mtimeMs:size`；缺失 `none` */
export function fileVersionTokenPart(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
}

/** 多文件聚合版本 token：任一文件 mtime/size 变化即 token 变化 */
export function fileVersionToken(files: string[]): string {
  return files.map(fileVersionTokenPart).join('|');
}

// ---------------------------------------------------------------------------
// 服务骨架
// ---------------------------------------------------------------------------

// 现行记忆文件路径：单源在 paths.ts（B8 收口——此前与 metaAgent/memoryStore 同值
// 双定义，B1「不反向依赖旧模块」立场的遗留，旧模块已退役）。本文件以别名引用
// （CORE/SCHEDULER 与 JOURNAL 同源）。
const CORE_MEMORY_FILE_REL = MEMORY_FILE_REL;

/**
 * 注入涉及的 canonical 文件——**按面取真注入源**（B5 评审 MAJOR-1：versionToken 必须
 * 只覆盖该面实际读的文件，不同面互不拖动）：
 * - scheduler 面：调度私有 MEMORY.md + USER.md 画像（B7 接线——画像独立小预算注入
 *   所有交互面；工作区 MEMORY.md / journal 不是调度面的注入源——Worker 侧仅写 journal
 *   若拖动调度 token，会让已带旧前缀的 pi 会话再拼一次调度前缀（前缀重复，实证），
 *   故坚决排除；
 * - worker / chat 面：共享核心 MEMORY.md + 今日 journal + USER.md 画像（B7）。
 * features 等只可检索语料不进注入面（MAJOR-2 口径）。画像文件未装配（userData 未
 * 注入，如测试）时不计入 token——与「文件不存在」同语义。
 */
function injectionSourceFiles(workspaceRoot: string, kind: MemorySessionKind, now?: Date): string[] {
  const profile = kind === 'headless' || kind === 'heartbeat' || kind === 'auto' ? null : getUserProfileFilePath();
  const files =
    kind === 'scheduler'
      ? [path.join(workspaceRoot, SCHEDULER_MEMORY_FILE_REL)]
      : [
          path.join(workspaceRoot, CORE_MEMORY_FILE_REL),
          journalFilePath(workspaceRoot, `${todayKey(now)}`)
        ];
  return profile ? [...files, profile] : files;
}

function readTextSoft(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function isZeroBudget(p: MemoryBudgetProfile): boolean {
  return p.coreChars <= 0 && p.journalChars <= 0 && p.profileChars <= 0;
}

export class MemoryService {
  private readonly knowledgeStores = new Map<string,KnowledgeStore>();
  private readonly knowledgeSearches = new Map<KnowledgeStore,KnowledgeSearch>();
  knowledge(workspaceRoot:string,namespace:KnowledgeNamespace='worker'):KnowledgeStore {
    if(!['worker','scheduler','profile','host'].includes(namespace)) throw new Error('无效记忆范围');
    const root=path.resolve(workspaceRoot);
    const profileFile=getUserProfileFilePath();
    if((namespace==='profile'||namespace==='host')&&!profileFile) throw new Error('全局记忆目录尚未装配');
    const directory=namespace==='profile'?path.join(path.dirname(profileFile!),'knowledge'):namespace==='host'?path.join(path.dirname(profileFile!),'host-knowledge'):
      knowledgeDirectory(root,namespace);
    const existing=this.knowledgeStores.get(directory);if(existing) return existing;
    const ledger=namespace==='profile'||namespace==='host'?directory:path.join(directory,'ledger');
    const owner=namespace==='profile'||namespace==='host'?path.dirname(profileFile!):root;
    assertKnowledgeDirectory(owner,directory);assertKnowledgeDirectory(owner,ledger);
    const store=new KnowledgeStore(directory,ledger);
    this.knowledgeStores.set(directory,store);return store;
  }
  /** Host maintenance entry; neither worker tools nor the curator tool set can invoke it. */
  stopKnowledgePolicy(workspaceRoot:string,namespace:KnowledgeNamespace,version:string,reason:string) {
    const store=this.knowledge(workspaceRoot,namespace);store.disablePolicy(version,reason);
    return store.compensatePolicy(version);
  }
  continueKnowledgePolicyCompensation(workspaceRoot:string,namespace:KnowledgeNamespace,version:string) {
    return this.knowledge(workspaceRoot,namespace).compensatePolicy(version);
  }
  /** Bounded local maintenance only; the caller supplies the workspace's queue guard. */
  pruneKnowledgeHistory(workspaceRoot:string,options:CuratorRetentionOptions={}) {
    const stores=(['worker','scheduler',...(getUserProfileFilePath()?['profile','host']:[])] as KnowledgeNamespace[]).map(namespace=>this.knowledge(workspaceRoot,namespace));
    const guardDatabases=[...stores.map(store=>store.db),...(options.guardDatabases??[])];
    return stores.map(store=>pruneCuratorRetention(store,{...options,guardDatabases}));
  }
  async queryKnowledge(workspaceRoot:string,input:KnowledgeQuery):Promise<KnowledgeHit[]> {
    const namespace=input.namespace??'worker';
    const store=this.knowledge(workspaceRoot,namespace);
    let engine=this.knowledgeSearches.get(store);
    if(!engine){engine=new KnowledgeSearch(store);this.knowledgeSearches.set(store,engine);}
    const query={...input,namespace};
    return engine.current(await engine.search(query),query);
  }
  /** Curator comparison remains bounded to its host-selected scope. */
  async curatorReferences(workspaceRoot:string,query:string,scope:CuratorScope):Promise<CuratorReferences> {
    const store=this.knowledge(workspaceRoot,scope.namespace);
    let engine=this.knowledgeSearches.get(store);
    if(!engine){engine=new KnowledgeSearch(store);this.knowledgeSearches.set(store,engine);}
    return engine.references(query,scope);
  }
  /**
   * 召回（任务/历史语义路由 + 全局画像合并）。整体 1500ms 有界；**截止保留已完成命中**
   * （memory-system F-01③/架构审计 P1-6）：工作范围命中先重检并记为部分结果，profile
   * 查询未完而截止到来时返回已完成部分，不再整包丢弃（空结果与超时不可都呈现为
   * 「没有记忆」）。后台未完成的查询自然结束即弃，不产生副作用。
   */
  async recallKnowledge(workspaceRoot:string,query:string,namespace:KnowledgeNamespace='worker',scope?:{root:string;branch?:string|null}):Promise<string> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    let partial='';
    try{return await Promise.race([(async()=>{
      const repository=scope&&scope.branch!==undefined?scope:await readGitIdentity(scope?.root??workspaceRoot);
      const mode=detectRecallIntent(query).intent?'history':'task';
      const input:KnowledgeQuery={query,namespace,repoKey:repository?.root??path.resolve(workspaceRoot),branch:repository?.branch??undefined,mode,limit:5};
      const workerStore=this.knowledge(workspaceRoot,namespace),profileStore=getUserProfileFilePath()&&mode==='task'?this.knowledge(workspaceRoot,'profile'):undefined;
      const hostStore=getUserProfileFilePath()&&mode==='task'?this.knowledge(workspaceRoot,'host'):undefined;
      const hits=await this.queryKnowledge(workspaceRoot,input);
      const current=this.knowledgeSearches.get(workerStore)?.current(hits,input)??[];
      partial=formatKnowledgeHits(current,1600,repository?.branch);
      const profile=profileStore?await this.queryKnowledge(workspaceRoot,{query,namespace:'profile',mode,limit:3}):[];
      const host=hostStore?await this.queryKnowledge(workspaceRoot,{query,namespace:'host',mode,limit:3}):[];
      // 全量路径仍按既有合同在 profile await 之后重检两侧命中（删除/修订竞态防护）
      const currentWorker=this.knowledgeSearches.get(workerStore)?.current(hits,input)??[];
      const currentProfile=profileStore?this.knowledgeSearches.get(profileStore)?.current(profile,{query,namespace:'profile',mode,limit:3})??[]:[];
      const currentHost=hostStore?this.knowledgeSearches.get(hostStore)?.current(host,{query,namespace:'host',mode,limit:3})??[]:[];
      return formatKnowledgeHits([...currentWorker,...currentProfile,...currentHost],1600,repository?.branch);
    })(),new Promise<string>(resolve=>{timer=setTimeout(()=>resolve(partial),1500);})]);}finally{if(timer)clearTimeout(timer);}
  }
  /** 注入执行范围缓存 TTL（branch 切换的注入滞后上界） */
  static readonly GIT_SCOPE_TTL_MS = 30_000;
  /**
   * 注入执行范围读取（同步）：缓存新鲜直接命中；过期/缺失时触发一次异步刷新并按
   * 现有口径（仅 repoKey）先行返回——分支信息自下回合起生效。非 git 目录回落
   * workspaceRoot 本身（与旧 repoKey 口径一致）。
   */
  gitScopeFor(workspaceRoot:string):{repoKey?:string;branch?:string} {
    const key=path.resolve(workspaceRoot),cached=this.gitScopes.get(key);
    if(cached&&Date.now()-cached.at<MemoryService.GIT_SCOPE_TTL_MS) return cached.scope;
    if(!cached?.refresh) void this.refreshGitScope(key).catch(()=>undefined);
    return cached?.scope??{repoKey:key};
  }
  /** 显式刷新注入执行范围（测试/宿主预热；并发调用共享同一次刷新） */
  async refreshGitScope(workspaceRoot:string):Promise<{repoKey?:string;branch?:string}> {
    const key=path.resolve(workspaceRoot);
    const existing=this.gitScopes.get(key);
    if(existing?.refresh){await existing.refresh;return this.gitScopes.get(key)?.scope??{repoKey:key};}
    // readGitIdentity 对 git 失败恒 resolve(null)（回落仅 repoKey）；.catch 兜底非预期
    // 异常——删除占位条目让下次 gitScopeFor 可重触发，不留永久占位的 refresh。
    const refresh=(async()=>{
      const identity=await readGitIdentity(key);
      const scope=identity?{repoKey:identity.root,branch:identity.branch??undefined}:{repoKey:key};
      this.gitScopes.set(key,{scope,at:Date.now()});
    })().catch(()=>{this.gitScopes.delete(key);});
    this.gitScopes.set(key,{scope:existing?.scope??{repoKey:key},at:existing?.at??0,refresh});
    await refresh;
    return this.gitScopes.get(key)?.scope??{repoKey:key};
  }
  /**
   * 核心常驻注入（调度/worker/chat 交互面）。执行范围（仓库/分支）走 gitScopeFor 缓存
   * （memory-system F-01①/架构审计 P1-2：绑定分支的 active 条目此前永不进 core——注入
   * 只传 repoKey、无 branch）。四个调用面均为同步注入，故缓存 + TTL + 异步刷新：未预热
   * 时先按仅 repoKey 口径注入（与旧行为一致），后台刷新后下回合起生效；测试/宿主可用
   * refreshGitScope 显式预热。
   */
  injectKnowledge(workspaceRoot:string,kind:MemorySessionKind):MemoryInjection {
    if(['headless','heartbeat','auto'].includes(kind)) return {text:'',sections:[],injectedChunkIds:[],versionToken:'disabled'};
    const namespace=kind==='scheduler'?'scheduler':'worker';
    const scope=this.gitScopeFor(workspaceRoot);
    const core=this.knowledge(workspaceRoot,namespace).core(namespace,1200,scope);
    const profile=getUserProfileFilePath()?this.knowledge(workspaceRoot,'profile').core('profile',PROFILE_INJECTION_BUDGET,scope):'';
    const text=[core?`### 持续约束\n${core}`:'',profile?`### 用户画像\n${profile}`:''].filter(Boolean).join('\n\n');
    return {text,sections:[{kind:'core',budgetChars:1200,chars:core.length,entryCount:core?core.split('\n').length:0},{kind:'profile',budgetChars:PROFILE_INJECTION_BUDGET,chars:profile.length,entryCount:profile?profile.split('\n').length:0}],injectedChunkIds:[],versionToken:createHash('sha256').update(text).digest('hex')};
  }
  private readonly dbs = new Map<string, MemoryDb>();
  private readonly watchers = new Map<string, MemoryWatcherHandle>();
  /**
   * 注入执行范围缓存（root → {scope, at, refresh}；缺口①：core 常驻注入读取执行仓库/
   * 分支）。injectKnowledge 为同步签名（四个调用面均同步），identity 走异步刷新 + TTL；
   * branch 切换后至多 TTL 内可能短暂按旧分支注入（versionToken 随内容变化自动重注入）。
   */
  private readonly gitScopes = new Map<string, {scope: {repoKey?:string;branch?:string};at:number;refresh?:Promise<void>}>();
  /** bootstrap 注入缓存（root|kind|sessionId → {token, result}；§7 逐回合刷新判定） */
  private readonly injectionCache = new Map<
    string,
    { versionToken: string; result: MemoryInjection }
  >();

  /** 缓存写入 + LRU 淘汰（Map 迭代序=插入序；命中时先删后插刷新新近度） */
  private rememberInjection(cacheKey: string, entry: { versionToken: string; result: MemoryInjection }): void {
    this.injectionCache.delete(cacheKey);
    this.injectionCache.set(cacheKey, entry);
    while (this.injectionCache.size > INJECTION_CACHE_MAX_KEYS) {
      const oldest = this.injectionCache.keys().next();
      if (oldest.done) break;
      this.injectionCache.delete(oldest.value);
    }
  }
  /** 打开（不存在则创建）工作区派生库；同根幂等返回同一句柄 */
  init(workspaceRoot: string): MemoryDb {
    const key = path.resolve(workspaceRoot);
    const existing = this.dbs.get(key);
    if (existing && !existing.isClosed) return existing;
    const db = openMemoryDb(workspaceRoot);
    this.dbs.set(key, db);
    // 画像写事件观察点（条目 1A）：USER.md 全局无归属工作区，profile_write 落
    // 「最近 init 的活跃工作区」派生库——面板/工具的读写都会先 init 活跃工作区。
    // appendEvent 内部 try/catch，库关闭等失败只打日志，不影响画像写盘。
    setProfileWriteObserver((info) => {
      appendEvent(db, {
        kind: 'profile_write',
        ts: Date.now(),
        namespace: 'profile',
        entryRef: 'USER.md',
        summary: '用户画像已更新（{{totalChars}} 字）',
        summaryArgs: { ...info }
      });
    });
    return db;
  }

  /** 已打开的句柄（未 init 返回 undefined） */
  db(workspaceRoot: string): MemoryDb | undefined {
    return this.dbs.get(path.resolve(workspaceRoot));
  }

  // -------------------------------------------------------------------------
  // P1 检索面（B2）：惰性索引同步 + 排序检索；memory.search 工具接线在 B5
  // -------------------------------------------------------------------------

  /** 同步词法索引后检索工作记录。 */
  async search(workspaceRoot:string,query:string,opts:MemorySearchOptions={}):Promise<MemorySearchHit[]> {
    const db=this.init(workspaceRoot);
    await ensureMemoryIndex(db,workspaceRoot,{userMdPath:getUserProfileFilePath()??undefined});
    return searchMemory(db,query,opts);
  }

  async ensureIndex(workspaceRoot:string):Promise<IndexSyncSummary> {
    return ensureMemoryIndex(this.init(workspaceRoot),workspaceRoot,{userMdPath:getUserProfileFilePath()??undefined});
  }

  // -------------------------------------------------------------------------
  // P2 写路径（B3）：情景暂存写入唯一通道（§6.2）
  // -------------------------------------------------------------------------

  /**
   * 情景暂存写入（memory.note 工具 / 压缩前 flush / 会话结束转录摄入共用）：
   * 种类门 → 精确/高重叠判重 → 召回回路防护 → staging 表 state=pending。
   * 拒收一律返回 {ok:false, reason}（不抛错），调用方按 reason 决定回执与日志。
   */
  noteStaging(workspaceRoot: string, input: NoteStagingInput): NoteStagingResult {
    return noteStaging(this.init(workspaceRoot), input);
  }

  // -------------------------------------------------------------------------
  // fs.watch 防抖（watcher 失效自动退化懒同步——search/ensureIndex 的指纹检查兜底）
  // -------------------------------------------------------------------------

  startWatching(workspaceRoot: string): boolean {
    const key = path.resolve(workspaceRoot);
    if (this.watchers.has(key)) return true;
    const handle = watchMemorySources(workspaceRoot, {
      onInvalidate: () => {
        void this.ensureIndex(workspaceRoot).catch(() => undefined);
      },
      onError: (err) => {
        console.error('[memory] 目录 watcher 失效，退化懒同步（检索路径指纹检查兜底）', err);
        this.watchers.delete(key);
      }
    });
    if (!handle) return false;
    this.watchers.set(key, handle);
    return true;
  }

  stopWatching(workspaceRoot?: string): void {
    if (workspaceRoot === undefined) {
      for (const h of this.watchers.values()) h.close();
      this.watchers.clear();
      return;
    }
    const key = path.resolve(workspaceRoot);
    this.watchers.get(key)?.close();
    this.watchers.delete(key);
  }

  /**
   * §12 单一注入 API（B5 实装）：bootstrap 优先级装箱 + 逐回合预算内刷新。
   *
   * - 版本缓存：按 root|kind|sessionId 键持有 {token, result}——文件（mtime+size）
   *   没变返回**字节不变**的同一结果（保前缀缓存，§7 Lane1；快照模式照 pi driver
   *   memoryVersionToken 先例）；变化才重读组装；
   * - bootstrap 落账：首次（该缓存键）或 token 刷新时，对注入涉及的 chunk 记
   *   recall_stats kind=bootstrap（字节稳定复用不重复落账）；
   * - headless/heartbeat/auto 零注入（P0 预算画像）；
   * - 注入涉及 chunk id（injectedChunkIds）取注入源文件的现役 chunk（同步索引后按
   *   source_path 查回）——写入路径的召回回路防护对照面；
   * - 任何 IO/db 异常静默降级为空注入（记忆注入不拖垮调用方）。
   */
  inject(
    workspaceRoot: string,
    sessionKind: MemorySessionKind,
    budgetProfile?: MemoryBudgetProfile,
    opts?: { sessionId?: string; now?: Date }
  ): MemoryInjection {
    const key = path.resolve(workspaceRoot);
    const profile = budgetProfile ?? defaultBudgetProfileFor(sessionKind);
    const cacheKey = `${key}|${sessionKind}|${opts?.sessionId ?? '-'}`;
    const nowMs = (opts?.now ?? new Date()).getTime();
    // 按面取源（MAJOR-1）：token 只覆盖该面真注入源，journal 写入不拖动调度面前缀
    const files = injectionSourceFiles(key, sessionKind, new Date(nowMs));
    const versionToken = fileVersionToken(files);
    const cached = this.injectionCache.get(cacheKey);
    if (cached && cached.versionToken === versionToken && budgetProfile === undefined) {
      this.rememberInjection(cacheKey, cached); // 命中刷新 LRU 新近度
      return cached.result; // 字节稳定复用（显式传预算=调用方要另一档画像，不走缓存）
    }
    let result: MemoryInjection;
    if (isZeroBudget(profile)) {
      result = { text: '', sections: [], injectedChunkIds: [], versionToken };
    } else {
      try {
        // 同步词法索引（指纹未变零开销）
        const db = this.init(key);
        try {
          syncMemoryIndex(db, key, { userMdPath: getUserProfileFilePath() ?? undefined });
        } catch {
          /* 索引失败不挡注入——注入文本直接读 canonical 文件 */
        }
        const isScheduler = sessionKind === 'scheduler';
        const profilePath = getUserProfileFilePath();
        const assembled = assembleMemoryInjection({
          sessionKind,
          budget: profile,
          workspaceMemoryMd: isScheduler ? null : readTextSoft(files[0]),
          schedulerMemoryMd: isScheduler ? readTextSoft(files[0]) : null,
          todayJournalMd: isScheduler ? null : readTextSoft(files[1]),
          journalDayKey: todayKey(new Date(nowMs)),
          // USER.md 画像槽位（B7 兑现）：userData 全局文件，独立小预算注入交互面
          // （scheduler/worker/chat；headless/heartbeat/auto 零预算已整节排除）
          userProfileMd: profilePath ? readTextSoft(profilePath) : null
        });
        const injectedChunkIds = assembled.text
          ? this.collectInjectedChunkIds(db, sessionKind, assembled.sections, new Date(nowMs))
          : [];
        result = {
          text: assembled.text,
          sections: assembled.sections,
          injectedChunkIds,
          versionToken
        };
        // bootstrap 落账：首次/刷新（token 变化）时；字节稳定复用不落
        if (injectedChunkIds.length) {
          const qs = `bootstrap:${sessionKind}`;
          for (const id of injectedChunkIds) {
            try {
              recordRecallStat(db, id, 'bootstrap', qs, nowMs, null);
            } catch {
              /* 落账失败不影响注入 */
            }
          }
        }
      } catch {
        result = { text: '', sections: [], injectedChunkIds: [], versionToken };
      }
    }
    if (budgetProfile === undefined) {
      this.rememberInjection(cacheKey, { versionToken, result });
    }
    return result;
  }

  /** 注入分节 → 涉及源文件的现役 chunk id（召回回路防护对照面）；按面记**实际装箱**源 */
  private collectInjectedChunkIds(
    db: MemoryDb,
    sessionKind: MemorySessionKind,
    sections: ReadonlyArray<MemoryInjectionSection>,
    now: Date
  ): number[] {
    const sourcePaths: Array<{ sourceType: string; sourcePath: string }> = [];
    for (const s of sections) {
      if (s.kind === 'core') {
        // 按面取真装箱源（B5 评审 MINOR-①）：调度核心只涉调度 MEMORY.md，共享核心
        // 只涉工作区 MEMORY.md——落账面=真注入面，不把另一面的 chunk 拖进对照集
        sourcePaths.push({
          sourceType: 'memory',
          sourcePath: (
            sessionKind === 'scheduler' ? SCHEDULER_MEMORY_FILE_REL : CORE_MEMORY_FILE_REL
          ).replace(/\\/g, '/')
        });
      } else if (s.kind === 'journal') {
        sourcePaths.push({
          sourceType: 'journal',
          sourcePath: `${JOURNAL_DIR_REL.replace(/\\/g, '/')}/${todayKey(now)}.md`
        });
      } else if (s.kind === 'profile') {
        sourcePaths.push({ sourceType: 'user_md', sourcePath: USER_MD_SOURCE_PATH });
      }
    }
    const ids: number[] = [];
    for (const src of sourcePaths) {
      try {
        const rows = db.handle
          .prepare('SELECT id FROM chunks WHERE source_type = ? AND source_path = ?')
          .all(src.sourceType, src.sourcePath) as Array<{ id: number }>;
        ids.push(...rows.map((r) => Number(r.id)));
      } catch {
        /* 查询失败按无涉及处理 */
      }
    }
    return ids;
  }

  /**
   * 调度转录增量索引（B5 §4）：回合 settle/去抖后与 clearHistory/会话切换尾批的
   * 服务入口。核心逻辑见 transcriptIndex.ts；失败向上抛由调用方兜底。
   */
  indexSchedulerTranscript(
    workspaceRoot: string,
    input: IndexSchedulerTranscriptInput
  ): IndexSchedulerTranscriptResult {
    return indexSchedulerTranscript(this.init(workspaceRoot), input);
  }

  /** 关闭单工作区句柄（before-quit / 工作区移除用） */
  close(workspaceRoot?: string): void {
    if (workspaceRoot === undefined) {
      this.closeAll();
      return;
    }
    const key = path.resolve(workspaceRoot);
    for(const [directory,store] of this.knowledgeStores){
      const relative=path.relative(key,directory);
      if(relative.startsWith('..')||path.isAbsolute(relative))continue;
      this.knowledgeSearches.get(store)?.close();
      this.knowledgeSearches.delete(store);store.close();this.knowledgeStores.delete(directory);
    }
    this.gitScopes.delete(key);
    this.watchers.get(key)?.close();
    this.watchers.delete(key);
    this.dbs.get(key)?.close();
    this.dbs.delete(key);
  }

  closeAll(): void {
    for(const engine of this.knowledgeSearches.values()) engine.close();
    this.knowledgeSearches.clear();
    for(const store of this.knowledgeStores.values()) store.close();
    this.knowledgeStores.clear();
    this.gitScopes.clear();
    this.stopWatching();
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
    this.injectionCache.clear();
  }
}
