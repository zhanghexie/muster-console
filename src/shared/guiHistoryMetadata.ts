import type {GuiCompactionRecord,GuiInjectionSnapshot} from './guiWorker';

export type GuiInjectionDetailRef={key:string};
/** Ordinary pages carry fingerprints and counts; full text is read on expand. */
export type GuiInjectionSummary={
  kind:'summary';
  at:number;
  segments:Array<Omit<GuiInjectionSnapshot['segments'][number],'text'>>;
  enginePrompt?:Omit<NonNullable<GuiInjectionSnapshot['enginePrompt']>,'text'>;
  toolsFingerprint:string;
  toolCount:number;
  details:GuiInjectionDetailRef;
};
export type GuiInjectionView=GuiInjectionSnapshot|GuiInjectionSummary;
export type GuiMetadataKind='injections'|'compactions';
export type GuiMetadataTimelinePage<T=GuiInjectionSummary|GuiCompactionRecord>={
  kind:GuiMetadataKind;
  records:T[];
  before:number;
  total:number;
  hasEarlier:boolean;
};
export type GuiInjectionDetailsResult={ok:true;snapshot:GuiInjectionSnapshot}|{ok:false;error:string};
export type GuiMetadataTimelineResult={ok:true;page:GuiMetadataTimelinePage}|{ok:false;error:string};
export type GuiHistoryMetadataStatus={injectionCount:number;compactionCount:number;compactionsOverflow:boolean};
export type GuiHistoryMetadataWindow={
  injections:GuiInjectionSummary[];
  compactions:GuiCompactionRecord[];
  injectionCount:number;
  compactionCount:number;
  /** More compression events exist inside this message window; the timeline
   * remains independently pageable rather than silently discarding history. */
  compactionsOverflow:boolean;
};

export type GuiHistoryMetadataCounts=Pick<GuiHistoryMetadataStatus,'injectionCount'|'compactionCount'>;
