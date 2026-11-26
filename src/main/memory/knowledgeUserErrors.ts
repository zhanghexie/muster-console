import { t } from '../../shared/i18n';
import { localizeKnowledgeHostText } from '../../shared/knowledgeDisplayText';

/** Stable host errors remain unchanged for model tools and storage. */
export const KNOWLEDGE_UI_ERROR_KEYS = [
  '工作区不存在', '历史来源不属于此工作区或查询无效',
  '未知记忆资产格式', '记忆资产不完整', '记忆资产元数据损坏',
  '相同证据身份对应不同来源', '合并后超过32条证据上限，不能丢弃已有依据',
  '记忆资产不能是符号链接', '记忆资产身份与文件名不一致', '非法记忆ID',
  '非法记忆候选身份', '非法记忆查询范围', '记忆已变化，请刷新后删除',
  '该记忆已被用户删除，必须显式恢复后才能使用', '非法宿主来源', '非法记忆范围',
  '用户画像范围仅允许用户信息和偏好', '用户信息必须保存在全局画像范围',
  '工作台通用经验只能由用户明确提交，且不能绑定仓库或分支', '归纳来源已变化或不在同一范围',
  '事件处理租约已失效', '关联后超过32条证据上限，不会截断已有依据',
  '记忆已变化，请刷新后操作', '该内容不具备长期记忆准入条件', '仅待审记忆可驳回',
  '仅生效知识可退场或标记复核', '用户修订不能改变记忆类型；任务事实不能晋升为长期知识',
  '工作台通用经验不能绑定仓库或分支', '任务历史不能恢复为有效知识',
  '已有相同生效知识，请先处理重复条目', '存在另一条已删除的同义知识，请先核对删除记录',
  '确认依据需为1到2000字符', '记忆已变化，请刷新后确认', '只能确认当前生效且可用的长期记忆',
  '证据已达32条上限，请先核对已有依据', '仅当前生效知识可以停止使用',
  '记忆已变化或取代目标无效', '不同范围或类型的知识不能互相取代', '取代操作不适用于当前状态',
  '该历史版本不存在，无法恢复', '请填写治理理由（最多500字）', '当前条目不能执行此治理操作',
  '用户画像不存任务历史，请停止使用该条画像', '对照条目已变化，请刷新后操作',
  '不能跨范围或类型治理', '对照条目已退场', '适用条件或例外不同，请保留差异，不能合并证据',
  '合并后超过32条证据上限，请保留差异；不会静默丢弃依据', '两条内容与边界完全相同，请合并证据',
  '治理记录不存在', '治理记录不属于此条目', '治理后内容已变化，不能撤销覆盖后续修改', '归纳条目已变化',
  '必须先持久停用记忆策略，再补偿其操作'
] as const;

export const KNOWLEDGE_UI_ERROR_TEMPLATES = [
  { prefix: '仅账本历史出现非预期投影：', key: '仅账本历史出现非预期投影：{{detail}}' },
  { prefix: '记忆资产存在外部修改，请先核对：', key: '记忆资产存在外部修改，请先核对：{{detail}}' },
  { prefix: '记忆写入冲突：', key: '记忆写入冲突：{{detail}}' },
  { prefix: '记忆资产缺失或已被外部修改：', key: '记忆资产缺失或已被外部修改：{{detail}}' }
] as const;

const errorKeys = new Set<string>(KNOWLEDGE_UI_ERROR_KEYS);
export function localizeKnowledgeUserError(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  let translated = error.message;
  if (errorKeys.has(error.message)) translated = t(error.message);
  else {
    const template = KNOWLEDGE_UI_ERROR_TEMPLATES.find(item => error.message.startsWith(item.prefix));
    if (template) translated = t(template.key, { detail: error.message.slice(template.prefix.length) });
    else translated = localizeKnowledgeHostText(error.message);
  }
  if (translated === error.message) throw error;
  const copy = new Error(translated, { cause: error });
  copy.name = error.name;
  throw copy;
}
