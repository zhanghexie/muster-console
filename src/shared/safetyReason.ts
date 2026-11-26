import { t } from './i18n';

/** Host-generated audit reasons stay stable; translate only known display text. */
export const SAFETY_REASON_KEYS = [
  '调用已取消', '例行操作，沿用既有授权', '人工确认目标作用域无效', '人工确认期间目标作用域已变化', '人工确认失败',
  '人工批准本次操作', '人工拒绝本次操作', '人工未批准本次操作',
  '安全工作区已删除或无效', '安全操作会话不存在', '安全操作工作区与宿主作用域不匹配', '安全操作身份与宿主作用域不匹配',
  '上次进程未完成审核；必须重新提交，不恢复授权', '操作已取消', '例行操作，沿用既有能力授权',
  '安全审计不可读取，未授权', '宿主作用域无效，操作已取消', '排队等待审批',
  '安全审计写入失败，未授权', '操作已取消或作用域已变化', '审批排队超过预算，请人工决定本次操作',
  '人工确认超时，本次操作未授权。', '等待人工确认超过预算，未授权', '审批作用域或规则版本已变化',
  '安全服务未就绪，请确认本次高危操作', '审批记录暂时无法保存，本次改由人工直接决定；此次决定无法写入审批历史。'
] as const;
export const SAFETY_REASON_TEMPLATES = [
  { prefix: '审批代理需要人工确认：', key: '审批代理需要人工确认：{{detail}}' },
  { prefix: '审批模型失败：', suffix: '。请人工决定本次操作', key: '审批模型失败：{{detail}}。请人工决定本次操作' },
  { prefix: '审批队列失败：', key: '审批队列失败：{{detail}}' },
  { prefix: '人工处理失败，未授权：', key: '人工处理失败，未授权：{{detail}}' },
  { prefix: '需要人工审核：', key: '需要人工审核：{{detail}}' },
  { prefix: '用户在人工确认弹窗中批准本次操作：', key: '用户在人工确认弹窗中批准本次操作：{{detail}}' },
  { prefix: '用户在人工确认弹窗中拒绝本次操作：', key: '用户在人工确认弹窗中拒绝本次操作：{{detail}}' }
] as const;
export const SAFETY_UI_ERROR_KEYS = [
  '审批模型执行超过预算', '安全审计写入失败',
  '安全转录文件无效', '安全转录格式无效', '旧安全审计无效', '旧安全审计格式无效',
  '安全审计写入失败，必须恢复服务后再审批', '安全会话或审计已失效', '用户规则写入作用域或版本已失效',
  '人工确认未返回有效决定', '非法或过期裁决', '请输入1至8000字符', '审批请求不存在或不属于当前工作区',
  '审批聊天作用域已失效', '审批规则版本已变化，请刷新', '审批规则不存在',
  '安全会话禁止加载额外资源', '安全审核缺少可用模型或凭据', '安全模型注册失败', '没有活动审批任务',
  '审批上下文或请求超过预算', '重复或非法安全审核回执', '规则范围无效', '安全会话工具越界',
  '安全裁决工具调用失败或回执非法', '安全模型未完整结束审核', '安全模型输出达到上限', '安全模型调用已中止',
  '审批证据不足或不可用', '审批证据作用域无效', '审批证据分页参数无效', '审批证据仓库不可用', '审批证据选择未完成', '审批模型必须先等待证据结果',
  '审批证据类型无效', '审批证据文件无效', '审批证据不可用',
  '审批会话必须串行', '安全审核未返回结构化裁决'
] as const;
const known = new Set<string>(SAFETY_REASON_KEYS);
const knownErrors = new Set<string>(SAFETY_UI_ERROR_KEYS);

/** Translate only summaries whose action and exact text are owned by the host. */
export function localizeSafetySummary(action: string, summary: string): string {
  return action === 'apps.saveMailbox' && summary === '配置邮箱连接' ? t('配置邮箱连接') : summary;
}

export function localizeSafetyReason(reason: string): string {
  if (known.has(reason)) return t(reason);
  const unavailable = '；人工确认通道不可用，未授权';
  if (reason.endsWith(unavailable)) {
    const original = reason.slice(0, -unavailable.length);
    const detail = localizeSafetyReason(original);
    if (detail !== original) return t('{{detail}}；人工确认通道不可用，未授权', { detail });
  }
  const unsaved = '；审批记录暂不可保存';
  if (reason.endsWith(unsaved)) {
    const original = reason.slice(0, -unsaved.length);
    if (known.has(original)) {
      const detail = t(original);
      if (detail !== original) return t('{{detail}}；审批记录暂不可保存', { detail: detail.endsWith('.') ? detail.slice(0, -1) : detail });
    }
  }
  for (const item of SAFETY_REASON_TEMPLATES) {
    const suffix = 'suffix' in item ? item.suffix : '';
    if (reason.startsWith(item.prefix) && reason.endsWith(suffix) && reason.length >= item.prefix.length + suffix.length) {
      const detail = reason.slice(item.prefix.length, suffix ? -suffix.length : undefined);
      let translated = item.prefix === '审批模型失败：' && knownErrors.has(detail) ? t(detail) : detail;
      const cleanupPrefix = '审批模型取消清理失败：';
      if (item.prefix === '审批模型失败：' && detail.startsWith(cleanupPrefix))
        translated = t('审批模型取消清理失败：{{detail}}', { detail: detail.slice(cleanupPrefix.length) });
      const providerPrefix = '安全模型调用失败：';
      if (item.prefix === '审批模型失败：' && detail.startsWith(providerPrefix))
        translated = t('安全模型调用失败：{{detail}}', { detail: detail.slice(providerPrefix.length) });
      const repositoryPrefix = '审批证据仓库不可用：';
      if (item.prefix === '审批模型失败：' && detail.startsWith(repositoryPrefix))
        translated = t('审批证据仓库不可用：{{detail}}', { detail: detail.slice(repositoryPrefix.length) });
      return t(item.key, { detail: translated !== detail && translated.endsWith('.') ? translated.slice(0, -1) : translated });
    }
  }
  return reason;
}

/** Leave the model's and audit log's original errors intact; copy only recognized UI errors. */
export function localizeSafetyUserError(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  const providerPrefix = '安全模型调用失败：';
  const translated = knownErrors.has(error.message) ? t(error.message)
    : error.message.startsWith(providerPrefix)
      ? t('安全模型调用失败：{{detail}}', { detail: error.message.slice(providerPrefix.length) })
      : error.message;
  if (translated === error.message) throw error;
  const copy = new Error(translated, { cause: error });
  copy.name = error.name;
  throw copy;
}
