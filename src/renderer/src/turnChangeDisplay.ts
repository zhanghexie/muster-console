import { TURN_FILE_COLLISION, TURN_FILE_COLLISION_PRESERVED, turnChangeWarningText } from '../../shared/turnChanges';
import type { TurnChangedFile } from '../../shared/turnChanges';

export function turnChangeFileStatus(file: TurnChangedFile): string {
  if (file.reverted) return '已回退';
  if (file.origin === 'observed-tool') return '事件观察';
  if (file.origin === 'provider-diff') return '引擎报告';
  if (!file.revertible) return '来源未确认';
  return turnChangeKindLabel(file.kind);
}

export function turnChangeKindLabel(kind: TurnChangedFile['kind']): string {
  return kind === 'added' ? '新增' : kind === 'deleted' ? '删除' : '修改';
}

/** Known host-owned reasons are stored in snapshots and translated only at display time. */
export const TURN_CHANGE_TEXT_KEYS = [
  // turnChangeFileStatus labels are consumed as t() keys by the card and panel.
  '已回退', '事件观察', '引擎报告', '来源未确认', '新增', '删除', '修改',
  '部分工具没有可靠的写前通知，其改动可能未记录',
  '部分改动根据工具事件观察，写前时机无法确认，记录可能不完整',
  '工具事件的写前时机无法确认，仅供审阅',
  '工具完成后才报告文件，部分改动可能未记录',
  '引擎差异达到大小上限，部分改动未记录',
  '引擎提供的差异仅供审阅，不能自动回退',
  '部分差异由引擎报告，仅供审阅，不能自动回退',
  '同一文件的引擎差异按工具片段展示，并非合并后的净变化',
  '未登记的命令改动可能未记录',
  '写入工具未提供可采集的文件路径',
  '本轮采集路径已达到上限',
  '本轮采集批次已达到上限',
  '本轮采集正文已达到上限',
  '工具之间文件发生其他变化，无法确认全部改动归属',
  '同一文件有重叠工具调用',
  '无法核对完整工具意图和实际文件内容',
  '登记批次内存在未确认的文件变化',
  '显式登记只提供审阅，无法确认改动归属',
  '文件在工具完成后发生变化，已保留当前内容',
  TURN_FILE_COLLISION,
  TURN_FILE_COLLISION_PRESERVED,
  '文件基线仍在后台校验，Shell 变化可能未完整覆盖；已确认的工具文件仍按原文核对',
  '文件基线正在后台预热，本轮按文件采集写前原文；无可靠写前事件的变化可能未完整覆盖，且不会自动回退',
  '本轮开始时文件基线尚未就绪（预热或重新校验），已按文件采集写前原文；缺少可靠写前记录的变化可能未完整覆盖，且不会自动回退',
  '本轮结束时未完成文件校验，Shell 改动记录可能不完整；此为历史记录，不表示当前仍在校验',
  '正在准备文件基线…', '正在校验并保存本轮改动…', '正在记录本轮改动…',
  '上次改动采集中断，没有可用的回退快照',
  '该轮没有文件改动快照',
  '范围外或链接文件未纳入快照',
  '源目录身份已变化，已停止本轮审阅',
  '本轮文件审阅不可用：缺少可信轮前基线，无法核对本轮文件改动；不会自动回退',
  '部分原文未覆盖，已禁止自动回退',
  '部分文件为二进制、超限、链接或不可读，未提供回退',
  '部分审阅差异使用 Git 原文；缺少精确写前原文的文件不会自动回退',
  '无法确认全部改动归属，已保留文件',
  '文件基线覆盖不完整',
  '无效的快照',
  '快照不属于该回合',
  '文件不属于该回合',
  '证据仓库或分支范围未知、变化或不匹配',
  '文件不在当前授权范围或不属于此轮',
  '正在保存本轮回退结果，请稍后重试',
  '文件已不在当前可写范围',
  '有会话正在使用该目录，请等回合结束后重试',
  '文件在本轮后已变化，已保留当前内容',
  '无法确认改动归属',
  '文件路径或源目录已变化',
  '文件已变化',
  '缓存原文格式无效',
  '缓存原文校验失败',
  '源目录身份已变化，已停止快照采集',
  '快照达到容量上限，未覆盖的原文只在可靠写入前按需采集',
  '部分文件无法读取，未覆盖的文件不会自动回退',
  '子模块配置无法校验，未覆盖的文件不会自动回退',
  'Git 索引快照不可用，未覆盖的原文不会自动回退',
  '文件元数据达到覆盖上限',
  '无法安全覆盖 Git filter 配置',
  '部分目录无法读取',
  '文件通知不可用，使用元数据校验；无法完整观察的文件不会自动回退'
] as const;

/** Only the host's known prefix/suffix is translated; paths and underlying errors stay literal. */
export const TURN_CHANGE_TEXT_TEMPLATES = [
  { prefix: `${TURN_FILE_COLLISION_PRESERVED}：`, key: `${TURN_FILE_COLLISION_PRESERVED}：{{detail}}`, literalDetail: true },
  { prefix: '写前采集失败：', key: '写前采集失败：{{detail}}' },
  { prefix: '改动采集失败：', key: '改动采集失败：{{detail}}' },
  { prefix: '引擎差异无法纳入审阅：', key: '引擎差异无法纳入审阅：{{detail}}' },
  { prefix: '无法检查文件后续变化：', key: '无法检查文件后续变化：{{detail}}' },
  { prefix: '工具未成功完成或缺少可靠结束通知：', key: '工具未成功完成或缺少可靠结束通知：{{detail}}' },
  { prefix: '工具结束前本轮已收口：', key: '工具结束前本轮已收口：{{detail}}' },
  { prefix: '登记批次未完成该文件：', key: '登记批次未完成该文件：{{detail}}' },
  { prefix: '登记批次未完成：', key: '登记批次未完成：{{detail}}' },
  { prefix: '工具结束后采集失败（', key: '工具结束后采集失败（{{detail}}' },
  { prefix: '文件审阅初始化失败：', key: '文件审阅初始化失败：{{detail}}' },
  { prefix: '改动快照失败：', key: '改动快照失败：{{detail}}' },
  { prefix: '文件在快照读取期间发生变化：', key: '文件在快照读取期间发生变化：{{detail}}' },
  { prefix: '文件在基线读取期间发生变化：', key: '文件在基线读取期间发生变化：{{detail}}' },
  { prefix: '文件基线准备失败：', key: '文件基线准备失败：{{detail}}' },
  { prefix: '改动采集异常，本轮保守不提供自动回退：', key: '改动采集异常，本轮保守不提供自动回退：{{detail}}' },
  { prefix: 'Git 基线按需查询失败，已禁止该文件自动回退：', key: 'Git 基线按需查询失败，已禁止该文件自动回退：{{detail}}' },
  { prefix: '无法核对轮前文件状态，不提供该文件的审阅或回退：', key: '无法核对轮前文件状态，不提供该文件的审阅或回退：{{detail}}' },
  { prefix: '改动快照汇总或保存失败：', key: '改动快照汇总或保存失败：{{detail}}' },
  { prefix: '文件基线准备失败，任务未启动：源目录不可用 ', key: '文件基线准备失败，任务未启动：源目录不可用 {{detail}}' },
  { prefix: '源目录不可用 ', key: '源目录不可用 {{detail}}' },
  { prefix: '部分源目录无可信轮前基线，其文件不会自动回退：', key: '部分源目录无可信轮前基线，其文件不会自动回退：{{detail}}' },
  { prefix: '文件回退结果已列出，快照状态保存失败：', key: '文件回退结果已列出，快照状态保存失败：{{detail}}' },
  { prefix: 'Git 基线索引查询返回了非精确结果（', suffix: ' 条），已按目录语义保守处理', key: 'Git 基线索引查询返回了非精确结果（{{detail}} 条），已按目录语义保守处理' },
  { prefix: 'Git 基线索引查询失败：', key: 'Git 基线索引查询失败：{{detail}}' },
  { prefix: 'Git 忽略规则校验失败：', key: 'Git 忽略规则校验失败：{{detail}}' },
  { prefix: '基线原文读取失败：', key: '基线原文读取失败：{{detail}}' },
  { prefix: '发现的子仓目录已离线或改变，未覆盖的文件不会自动回退：', key: '发现的子仓目录已离线或改变，未覆盖的文件不会自动回退：{{detail}}' },
  { prefix: '子模块目录未覆盖，不会自动回退：', key: '子模块目录未覆盖，不会自动回退：{{detail}}' },
  { prefix: '目录增量校验失败：', key: '目录增量校验失败：{{detail}}' },
  { prefix: '增量快照校验失败：', suffix: '；下轮将重新校验元数据', key: '增量快照校验失败：{{detail}}；下轮将重新校验元数据' }
] as const;
const knownDetails = new Set<string>(TURN_CHANGE_TEXT_KEYS);

export function turnChangeDisplayText(value: string, translate: (key: string, options?: Record<string, unknown>) => string, normalizeWarning = false): string {
  const text = normalizeWarning ? turnChangeWarningText(value) : value;
  for (const item of TURN_CHANGE_TEXT_TEMPLATES) {
    const suffix = 'suffix' in item ? item.suffix : '';
    if (text.startsWith(item.prefix) && text.endsWith(suffix) && text.length >= item.prefix.length + suffix.length) {
      const detail = text.slice(item.prefix.length, suffix ? -suffix.length : undefined);
      if ('literalDetail' in item) return translate(item.key, { detail });
      const wrapped = /^Error: ([\s\S]*)$/.exec(detail);
      const nested = wrapped ? wrapped[1] : detail;
      const known = knownDetails.has(nested) || TURN_CHANGE_TEXT_TEMPLATES.some(entry => nested.startsWith(entry.prefix) && nested.endsWith('suffix' in entry ? entry.suffix : ''));
      const translated = known ? turnChangeDisplayText(nested, translate) : nested;
      return translate(item.key, { detail: wrapped && translated === wrapped[1] ? detail : translated });
    }
  }
  return translate(text);
}
