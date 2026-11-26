import { t } from './i18n';

export const KNOWLEDGE_RUNTIME_ERROR_KEYS = [
  '记忆目录越界', '记忆目录不能经过符号链接', '记忆控制目录不能是符号链接',
  'evidence: 记忆证据必须由宿主提供1至32条可追溯事件',
  '专用记忆会话禁止加载额外资源', '记忆会话缺少可用模型或凭据，请在模型设置中配置',
  '记忆会话转录路径无效或已丢失', '记忆会话模型注册失败', '记忆会话当前没有宿主任务',
  '记忆会话工具白名单不匹配', '记忆会话实际工具集越界', '记忆模型请求未完成或输出截断', '记忆会话只允许串行执行',
  '记忆会话模型调用预算已用尽', '记忆会话上下文预算已用尽', '本轮记忆处理时间预算已用尽',
  '缺少工作区身份', '工作区身份或控制目录已改变', '同一记忆候选存在跨范围重复回执，拒绝重放',
  '纠错目标超出完整对照预算，不能省略目标后审核', '用户画像依据不在宿主绑定材料中', '用户画像缺少宿主绑定的用户输入来源',
  '用户画像必须能在本轮用户原话中定位依据', '用户要求不记录，本轮不能自动保存画像',
  '画像邮箱必须与用户原话中的值一致', '画像电话必须与用户原话中的号码一致',
  '用户偏好与持续约束必须直接依据原始用户输入', '当前工作区不存在唯一目标知识', '工作区删除记录已变化或尚未比较，请重新检索后提交',
  '该同义知识已被用户删除，不能换范围重新保存；仅可明确恢复选中的原条目', '候选缺少宿主绑定的工作区身份',
  '记忆候选越过当前工作区', '不可信或自动来源不能创建长期记忆候选'
] as const;

/** Exact host-authored descriptions; arbitrary knowledge and model text stays unchanged. */
export const KNOWLEDGE_DISPLAY_KEYS = [
  ...KNOWLEDGE_RUNTIME_ERROR_KEYS,
  '用户删除：停止使用并阻止同义内容自动复活', '该知识已被用户删除，不会重新收录',
  '用户已选择仅留历史，不再重复提案', '原合并目标已修订或退场，需要重新核对，不自动转移依据',
  '用户已确认此版本，自动候选不更改内容或状态', '该记忆已被用户退场，不会再次提案',
  '已有相同知识，仅关联新增证据', '相同事件和内容已记录', '用户明确要求保存',
  '基于独立事件归纳，等待核对条件；来源未被自动取代', '关键词与适用条件匹配', '内容相关；适用条件尚未核实',
  '用户停止使用', '用户恢复历史版本', '用户修订并生效', '用户确认当前版本', '用户确认取代旧结论；旧条目退出默认召回',
  '记忆持久回执格式无效或不属于当前候选', '普通候选不能接收纠错回执', '纠错回执目标、结果或用户保护格式无效',
  '记忆会话仍在处理，暂不能维护', '记忆会话已停止', '记忆用户请求必须绑定原始用户身份与原文',
  '专用记忆Pi会话尚未配置', '当前没有可处理的记忆任务', '记忆模型请求已暂停、过期或会话已换代',
  '记忆会话连接已取消或代次已变化', '记忆处理已暂停或停止', '记忆配置或策略已改变，拒绝迟到处理',
  '候选不属于本轮或已有真实处理回执', '记忆处理已停止', '处理进程中断，有限重试已用尽；未找到持久回执',
  '观察模式：仅记录建议，没有改变长期知识', '记忆会话代次已变化',
  '记忆队列账本不能使用目录或符号链接', '不可信或系统输出不能成为自动记忆候选',
  '记忆候选缺少可信身份、原始依据或超出长度范围', '宿主原始材料身份与内容不匹配，请重新绑定依据',
  '纠错请求缺少目标版本、问题、依据线索或宿主会话身份', '同一记忆候选身份对应不同内容',
  '候选已可靠入队，尚未作为长期知识生效', '处理进程中断，有限重试已用尽',
  '记忆候选处理已暂停、过期或会话已换代', '记忆候选处理回执已过期', '宿主重试时间无效', '宿主单条补试状态无效',
  '无效纠错请求身份', '纠错请求不存在或不属于当前会话', '纠错请求状态损坏', '纠错正在审核，尚未改变记忆',
  '纠错尚未完成', '纠错持久回执无效', '无效记忆队列状态', '无效整理记录可见范围', '无效记忆队列分页',
  '无效整理记录ID', '无效整理记录归档状态', '整理记录不存在，请刷新后重试', '正在处理的整理记录不能归档或恢复',
  '记忆消息需为1到6000字符', '无效暂停状态', '记忆服务尚未就绪',
  '记忆内容必须是对象', '未知记忆类型', 'summary 不能为空', 'expiresAt 格式错误', '环境依赖格式错误',
  '任务要求、进度和结果只保留在历史中', '来源不可信，不能成为长期指令', '缺少可追溯来源', '有期限的任务上下文不进入长期知识',
  '临时要求只属于当前任务', '经验需要问题、方法、依据、适用条件和未来用途', '用户信息、稳定约束和偏好必须由用户表达',
  '具有明确用途和来源，等待确认适用范围', '记忆抽取必须返回最多4条records',
  'draft: 必须提供结构化记忆对象', 'draft.kind: 必须为 task_fact、stable_constraint、user_preference、user_profile 或 reusable_lesson',
  'draft.applicability: 可复用经验至少需要一条明确适用条件', 'draft.expiresAt: 必须为有限数值时间戳'
] as const;
export const KNOWLEDGE_DISPLAY_TEMPLATES = [
  { prefix: '用户操作：', key: '用户操作：{{detail}}' },
  { prefix: '仅留历史：', key: '仅留历史：{{detail}}' },
  { prefix: '合并证据，结论与条件保持原样：', key: '合并证据，结论与条件保持原样：{{detail}}' },
  { prefix: '撤销治理：', key: '撤销治理：{{detail}}' },
  { prefix: '候选已存在：', key: '候选已存在：{{detail}}' }
] as const;
const known = new Set<string>(KNOWLEDGE_DISPLAY_KEYS);
const runtimeErrors = new Set<string>(KNOWLEDGE_RUNTIME_ERROR_KEYS);

/** Translate the host's bounded draft diagnostics only; keep other model details verbatim. */
function localizeDraftDiagnostic(value: string): string | undefined {
  if (value.startsWith('draft') && known.has(value)) return t(value);
  const match = /^draft\.(summary|problem|action|rationale|expectedFutureUse|applicability|exceptions|searchKeys|repoKey|branch|taskId)(?:\[(\d+)\])?: (.*)$/.exec(value);
  if (!match) return undefined;
  const field = match[1] + (match[2] === undefined ? '' : `[${match[2]}]`), message = match[3];
  if (message === '必须提供非空文本（最多1500字符）') return t('draft.{{field}}: 必须提供非空文本（最多1500字符）', { field });
  if (message === '必须为非空文本，最多1500字符') return t('draft.{{field}}: 必须为非空文本，最多1500字符', { field });
  if (message === '必须为文本，最多1500字符') return t('draft.{{field}}: 必须为文本，最多1500字符', { field });
  if (message === '必须提供字符串数组') return t('draft.{{field}}: 必须提供字符串数组', { field });
  if (message === '必须提供字符串数组（无已知例外时使用[]）') return t('draft.{{field}}: 必须提供字符串数组（无已知例外时使用[]）', { field });
  if (message === '必须为字符串数组，最多12项') return t('draft.{{field}}: 必须为字符串数组，最多12项', { field });
  if (message === '最多12项') return t('draft.{{field}}: 最多12项', { field });
  if (message === '必须为非空文本，最多300字符') return t('draft.{{field}}: 必须为非空文本，最多300字符', { field });
  const bounded = /^必须为文本，最多(\d+)字符；实际写入范围仍由宿主绑定$/.exec(message);
  if (bounded) return t('draft.{{field}}: 必须为文本，最多{{max}}字符；实际写入范围仍由宿主绑定', { field, max: bounded[1] });
  return undefined;
}
function localizeEvidenceDiagnostic(value: string): string | undefined {
  const match = /^evidence\[(\d+)\](?:\.(id|source|sessionId|turnId|snapshotId|path|repoKey|branch|eventTime|verification|contentHash|excerpt|observation))?: (.*)$/.exec(value);
  if (!match) return undefined;
  const [, index, field, message] = match;
  const args = { index, field };
  if (!field && message === '记忆证据必须由宿主提供可追溯事件对象') return t('evidence[{{index}}]: 记忆证据必须由宿主提供可追溯事件对象', args);
  if (['id','source','sessionId','turnId','snapshotId','path','repoKey','branch'].includes(field ?? '')) {
    if (message === '必须为非空宿主来源文本，最多1000字符') return t('evidence[{{index}}].{{field}}: 必须为非空宿主来源文本，最多1000字符', args);
    if (message === '必须为宿主来源文本，最多1000字符') return t('evidence[{{index}}].{{field}}: 必须为宿主来源文本，最多1000字符', args);
  }
  if (field === 'eventTime' && message === '必须为有限数值事件时间') return t('evidence[{{index}}].eventTime: 必须为有限数值事件时间', args);
  if (field === 'verification' && message === '必须为宿主绑定的unverified/test/integration/runtime/user_stated/user_confirmed等级') return t('evidence[{{index}}].verification: 必须为宿主绑定的unverified/test/integration/runtime/user_stated/user_confirmed等级', args);
  if (field === 'id' && message === '证据身份不能重复') return t('evidence[{{index}}].id: 证据身份不能重复', args);
  if (field === 'contentHash' && message === '证据内容签名必须为64位小写十六进制哈希') return t('evidence[{{index}}].contentHash: 证据内容签名必须为64位小写十六进制哈希', args);
  if (field === 'excerpt' && message === '证据摘录必须为文本，最多4000字符') return t('evidence[{{index}}].excerpt: 证据摘录必须为文本，最多4000字符', args);
  if (field === 'observation' && message === '宿主观察类型仅允许tool_output或user_input') return t('evidence[{{index}}].observation: 宿主观察类型仅允许tool_output或user_input', args);
  return undefined;
}
function localizeDiagnosticLines(value: string): string {
  if (!value.includes('draft') && !value.includes('evidence') && !value.includes('\n') && !runtimeErrors.has(value)) return value;
  return value.split('\n').map(line => runtimeErrors.has(line) ? t(line) : localizeDraftDiagnostic(line) ?? localizeEvidenceDiagnostic(line) ?? line).join('\n');
}

export function localizeKnowledgeHostText(value: string): string {
  if (known.has(value)) return t(value);
  const related = /^关联依据：([\s\S]*)（(derived_from|supports|supersedes|contradicts|revision_of)，仅一跳）$/.exec(value);
  if (related) return t('关联依据：{{summary}}（{{relation}}，仅一跳）', { summary: related[1], relation: related[2] });
  const incomplete = /^本批已确认 (\d+)\/(\d+) 条处理回执，剩余 (\d+) 条经补结算仍未取得回执；已保留确认结果，未完成项可重试$/.exec(value);
  if (incomplete) return t('本批已确认 {{done}}/{{total}} 条处理回执，剩余 {{remaining}} 条经补结算仍未取得回执；已保留确认结果，未完成项可重试', { done: incomplete[1], total: incomplete[2], remaining: incomplete[3] });
  const failure = /^本批已确认 (\d+)\/(\d+) 条处理回执，剩余 (\d+) 条；已保留确认结果。([\s\S]*?)(?:；回执复核失败：([\s\S]*))?$/.exec(value);
  if (failure) return t('本批已确认 {{done}}/{{total}} 条处理回执，剩余 {{remaining}} 条；已保留确认结果。{{detail}}', {
    done: failure[1], total: failure[2], remaining: failure[3],
    detail: localizeDiagnosticLines(failure[4]) + (failure[5] === undefined ? '' : t('；回执复核失败：{{detail}}', { detail: localizeDiagnosticLines(failure[5]) }))
  });
  const localizedDiagnostic = localizeDiagnosticLines(value);
  if (localizedDiagnostic !== value) return localizedDiagnostic;
  const field = /^(summary|problem|action|rationale|expectedFutureUse|repoKey|branch|taskId|applicability|exceptions|searchKeys) (格式或长度错误|必须是短文本数组)$/.exec(value);
  if (field) return field[2] === '格式或长度错误'
    ? t('{{field}} 格式或长度错误', { field: field[1] })
    : t('{{field}} 必须是短文本数组', { field: field[1] });
  const prefix = KNOWLEDGE_DISPLAY_TEMPLATES.find(item => value.startsWith(item.prefix));
  if (prefix) return t(prefix.key, { detail: value.slice(prefix.prefix.length) });
  const retired = /^已被 ([a-z0-9-]+) 取代$/i.exec(value);
  if (retired) return t('已被 {{id}} 取代', { id: retired[1] });
  const merge = /^证据合并至 ([a-z0-9-]+)：([\s\S]*)$/i.exec(value);
  if (merge) return t('证据合并至 {{id}}：{{detail}}', { id: merge[1], detail: merge[2] });
  const difference = /^(保留差异|已核对差异)（对照 ([a-z0-9-]+)）：([\s\S]*)$/i.exec(value);
  if (difference) return difference[1] === '保留差异'
    ? t('保留差异（对照 {{id}}）：{{detail}}', { id: difference[2], detail: difference[3] })
    : t('已核对差异（对照 {{id}}）：{{detail}}', { id: difference[2], detail: difference[3] });
  const unchanged = /^原始依据、适用内容和策略未变化：([^；]+)；沿用原候选，不重复复评$/.exec(value);
  if (unchanged) return t('原始依据、适用内容和策略未变化：{{state}}；沿用原候选，不重复复评', { state: unchanged[1] });
  return value;
}

/** Project only exact, host-authored progress text; caller validates message origin. */
export function localizeKnowledgeProgress(value: string): string {
  const received = /^收到 (\d+) 条记忆候选，核对依据与已有知识。$/.exec(value);
  if (received) return t('收到 {{n}} 条记忆候选，核对依据与已有知识。', { n: received[1] });
  const repaired = /^已确认 (\d+) 条处理回执，正在补齐剩余 (\d+) 条。$/.exec(value);
  if (repaired) return t('已确认 {{done}} 条处理回执，正在补齐剩余 {{remaining}} 条。', { done: repaired[1], remaining: repaired[2] });
  return value;
}
