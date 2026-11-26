import type {KnowledgeDraft,KnowledgeEvidence,KnowledgeNamespace,KnowledgeRecord,KnowledgeEnvironmentDependency} from '../../../shared/knowledge';
import type {MemoryCorrectionInput,MemoryCorrectionProposal} from '../../../shared/memoryCurator';

/** Public tool input. Provenance and authorization deliberately live in a separate host context. */
export interface CuratorDecisionInput {
  operationId:string;
  candidateId:string;
  policyVersion:string;
  decision:'save'|'duplicate'|'discard'|'history'|'suspend'|'supersede'|'delete'|'restore'|'correct';
  draft?:KnowledgeDraft;
  sourceQuote:string;
  reason:string;
  targetId?:string;
  targetRevision?:number;
  /** IDs returned by the comparison tool. A new deletion invalidates an in-flight comparison. */
  reviewedDeletionIds?:string[];
  /** The curator must explicitly compare meaning and boundaries; the host never invents this verdict. */
  deletionComparisons?:Array<{id:string;equivalent:boolean}>;
}
export interface CuratorDecisionContext {
  namespace:KnowledgeNamespace;
  origin:KnowledgeRecord['origin'];
  evidence:KnowledgeEvidence[];
  sourceText:string;
  /** Bound original human text. Mixed tool evidence must never authorize a user action. */
  userText?:string;
  environment?:KnowledgeEnvironmentDependency[];
  repoKey?:string;
  branch?:string;
  taskId?:string;
  explicit?:boolean;
  correction?:MemoryCorrectionInput;
  now?:number;
  /** Synchronous host callback: checks candidate lease, policy generation and abort state. */
  assertCurrent?:()=>void;
}
export interface CuratorDecisionReceipt {
  operationId:string;
  candidateId:string;
  policyVersion:string;
  decision:CuratorDecisionInput['decision'];
  disposition:'active'|'duplicate'|'retained_ephemeral'|'discarded'|'suspended'|'superseded'|'rejected'|'updated'|'needs_user';
  targetId?:string;
  targetRevision?:number;
  proposedCorrection?:MemoryCorrectionProposal;
  record?:KnowledgeRecord;
  affected:Array<{id:string;revision:number}>;
  reason:string;
  at:number;
  replayed?:boolean;
}
export interface CuratorDeletion extends KnowledgeDraft {
  id:string;
  revision:number;
  namespace:KnowledgeNamespace;
  deletedAt:number;
}
export interface CuratorScope {namespace:KnowledgeNamespace;repoKey?:string;branch?:string}
export interface CuratorReferences {
  records:KnowledgeRecord[];
  deleted:CuratorDeletion[];
  /** Only ordinary comparison records may be bounded; deletion semantics stay complete. */
  truncated?:boolean;
  omittedRecords?:number;
  notice?:string;
}
