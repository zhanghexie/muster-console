import { t } from './i18n';
import { localizeSafetyReason } from './safetyReason';

/** Stored extension reasons are stable data. Translate only known host messages at display time. */
export const EXTENSION_REASON_KEYS = [
  '已有不同的全局日报版本，保留现有代码', '已有不同的全局日报更新候选', '没有可用工作区',
  '多个工作区共用同一管理根，已跳过这些副本', '没有可写的工作区',
  '内置日报的上一个可信副本不可用，等待工作区恢复', '旧版内置日报包含目录，保留现场并等待处理', '日报新版本尚未成为全局版本',
  '导航文件为空或超过大小限制', '标记文件名无效', '标记文件不可读取', '标记身份无效',
  '扩展目录包含符号链接或不是目录', '扩展上次启动异常，已进入安全模式',
  '扩展或其所属项目在审核期间发生变化', '审核未通过', '原生扩展上次运行异常，请先禁用再重新启用以确认重试',
  'extension.json 必须是对象', '包含未知字段或已移除的扩展接口',
  '扩展 ID 与目录名必须一致', '扩展名称或描述不合法', 'scope 必须是 global 或 project',
  '项目扩展必须绑定项目，全局扩展不能绑定项目', 'data 声明不合法', '只有全局扩展可以声明共享数据',
  'views 必须是至多 32 项的数组', 'view 字段或权限不合法', 'view.id 重复',
  'commands 必须是至多 64 项的数组', 'command 字段不合法', 'command.id 重复',
  'tools 必须是至多 32 项的数组', '工具脚本必须位于可审核的扩展包内', 'tool.name 重复',
  'background.entry 必须是扩展包内 .mjs', 'native 入口不合法', 'host 要求不合法',
  'capabilities 不合法', 'hostTools 含未知能力或重复值', 'toolbar 不合法', 'toolbar.menu 项不合法',
  'toolbar 需要命令或菜单（二选一）', 'toolbar 引用了未声明的命令', 'commands 需要后台或原生业务入口',
  '原生命令需要 native.entry', '扩展没有可用能力',
  '工作区管理根不是目录', '扩展管理路径包含符号链接或不是目录', '扩展目录监听已停止，将自动重试',
  '人工审核未通过', '安全审核未通过',
  '扩展开关改变，审核结果已失效', '工作区副本不可用', '等待同步已审核的全局版本',
  '未知的同 ID 副本，不能自动覆盖或作为更新', '存在多个不同的更新候选', '工作区副本有独立修改',
  '扩展同步事务需要处理', '工作区没有此扩展副本', '与全局扩展的 ID 冲突', '副本无法校验',
  '当前版本没有本机审核记录', '同步未完成', '工作区副本尚不可用', '目标扩展或工作区已改变',
  '全局版本或草稿已改变', '工作区或全局版本已改变', '旧版内置文件已改变或不再由宿主管理',
  '全局版本已改变', '管理根不是目录', '多个工作区共用同一管理根', '扩展目录不能通过符号链接访问',
  '审核快照内容不一致', '审核后的工作区源码已改变', '审核快照不是全局扩展',
  '该工作区副本正在同步', '工作区或项目身份已失效', '分发快照与审核过的扩展范围不一致', '扩展仍有运行中的任务',
  '同步期间工作区或运行任务发生变化', '同步期间工作区副本或 Git 暂存发生变化', '旧副本在同步期间变化，已保留',
  '同步期间目标路径或 Git 暂存发生变化', '新副本在同步期间变化，已保留', '同步期间 Git 暂存或目标副本发生变化，已保留现场',
  '同步期间工作区或项目身份发生变化', '事务 ID 不合法', '事务记录损坏', '工作区管理根已改变或不可用', '事务路径不匹配',
  'Git 暂存或目标状态不允许自动恢复，保留现场', '旧副本已变化，保留现场', '暂存副本已变化，保留现场',
  '私有文件的事务位置不完整，保留现场', '私有文件的位置已变化，保留现场', '事务目录出现未知私有文件，保留现场',
  '私有文件在事务期间丢失或重复，保留现场', '旧副本恢复期间发生变化，保留现场', '暂存目录出现未知私有文件，保留现场',
  '目标副本已发生未知变化，保留现场', '已完成中断的同步', '已恢复同步前状态，仍需同步新版本'
] as const;
const exactReasons = new Set<string>(EXTENSION_REASON_KEYS);
export const EXTENSION_REASON_TEMPLATES = [
  ['扩展运行状态刷新失败：', '扩展运行状态刷新失败：{{error}}'],
  ['扩展监听重试失败：', '扩展监听重试失败：{{error}}'],
  ['内置日报：', '内置日报：{{error}}'],
  ['内置日报准备失败：', '内置日报准备失败：{{error}}'],
  ['内置扩展归属记录不可用：', '内置扩展归属记录不可用：{{error}}'],
  ['日报源码已发布，但归属记录保存失败：', '日报源码已发布，但归属记录保存失败：{{error}}'],
  ['日报已更新，但归属记录保存失败：', '日报已更新，但归属记录保存失败：{{error}}'],
  ['扩展目录监听失败，将自动重试：', '扩展目录监听失败，将自动重试：{{error}}'],
  ['扩展目录监听不可用，将自动重试：', '扩展目录监听不可用，将自动重试：{{error}}'],
  ['扩展扫描失败：', '扩展扫描失败：{{error}}'],
  ['源码已发布，但工作区同步状态刷新失败：', '源码已发布，但工作区同步状态刷新失败：{{error}}'],
  ['源码已发布，但同步状态刷新失败：', '源码已发布，但同步状态刷新失败：{{error}}'],
  ['管理根不可用：', '管理根不可用：{{error}}'],
  ['原生扩展恢复目录不可读取：', '原生扩展恢复目录不可读取：{{error}}'],
  ['扩展启动状态不可用：', '扩展启动状态不可用：{{error}}'],
  ['无法清理启动标记：', '无法清理启动标记：{{error}}'],
  ['启动标记清理失败：', '启动标记清理失败：{{error}}'],
  ['扩展目录不可读取：', '扩展目录不可读取：{{error}}'],
  ['审核快照不可用：', '审核快照不可用：{{error}}']
] as const;

export function localizeExtensionReason(reason: string): string {
  if (reason.startsWith('Error: ')) return `Error: ${localizeExtensionReason(reason.slice(7))}`;
  const invokeError = /^(Error invoking remote method '[^']+': )([\s\S]+)$/.exec(reason);
  if (invokeError) return invokeError[1] + localizeExtensionReason(invokeError[2]);
  if (exactReasons.has(reason)) return t(reason);
  const safeMode = /^原生扩展 ([a-z0-9][a-z0-9-]{0,63}) 上次运行异常，已进入安全模式；禁用后重新启用可重试。启动期能力需重启应用。$/.exec(reason);
  if (safeMode) return t('原生扩展 {{id}} 上次运行异常，已进入安全模式；禁用后重新启用可重试。启动期能力需重启应用。', { id: safeMode[1] });
  const recoveredPrefix = '扩展导航配置损坏，已保留至 ';
  const recoveredSeparator = '；已重建默认导航。原因：';
  if (reason.startsWith(recoveredPrefix)) {
    const details = reason.slice(recoveredPrefix.length);
    const separator = details.indexOf(recoveredSeparator);
    // An arbitrary path or external diagnostic may contain the delimiter too.
    if (separator >= 0 && separator === details.lastIndexOf(recoveredSeparator)) {
      return t('扩展导航配置损坏，已保留至 {{path}}；已重建默认导航。原因：{{error}}', {
        path: details.slice(0, separator), error: localizeExtensionReason(details.slice(separator + recoveredSeparator.length))
      });
    }
  }
  const recoveryPrefix = '原生扩展恢复记录损坏，已保留：';
  if (reason.startsWith(recoveryPrefix)) {
    const details = reason.slice(recoveryPrefix.length), separator = details.indexOf(' · ');
    if (separator >= 0 && separator === details.lastIndexOf(' · ')) {
      return t('原生扩展恢复记录损坏，已保留：{{file}} · {{error}}', {
        file: details.slice(0, separator), error: localizeExtensionReason(details.slice(separator + 3))
      });
    }
  }
  const navigationSuffix = '；导航暂不可保存。';
  if (reason.endsWith(navigationSuffix)) {
    const detail = reason.slice(0, -navigationSuffix.length);
    if (detail.startsWith('无法读取扩展导航：')) return t('无法读取扩展导航：{{error}}；导航暂不可保存。', { error: localizeExtensionReason(detail.slice('无法读取扩展导航：'.length)) });
    if (detail.startsWith('扩展导航路径不是普通文件：')) return t('扩展导航路径不是普通文件：{{path}}；导航暂不可保存。', { path: detail.slice('扩展导航路径不是普通文件：'.length) });
    if (detail.startsWith('扩展导航配置损坏，无法保留原文件 ')) return t('扩展导航配置损坏，无法保留原文件 {{detail}}；导航暂不可保存。', { detail: detail.slice('扩展导航配置损坏，无法保留原文件 '.length) });
  }
  if (reason.startsWith('内置日报：')) {
    const detail = reason.slice('内置日报：'.length);
    const whole = localizeExtensionReason(detail);
    return t('内置日报：{{error}}', { error: whole !== detail ? whole : detail.split('；').map(localizeExtensionReason).join('；') });
  }
  const workspace = /^([\s\S]+) 已有无法确认归属的同名扩展，保留原文件$/.exec(reason);
  if (workspace) return t('{{name}} 已有无法确认归属的同名扩展，保留原文件', { name: workspace[1] });
  const namedError = /^([\s\S]+?): (Error: [\s\S]+)$/.exec(reason);
  if (namedError) {
    const detail = localizeExtensionReason(namedError[2]);
    if (detail !== namedError[2]) return `${namedError[1]}: ${detail}`;
  }
  const namedCleanup = /^([\s\S]+?): ((?:无法清理启动标记：|启动标记清理失败：)[\s\S]*)$/.exec(reason);
  if (namedCleanup) return `${namedCleanup[1]}: ${localizeExtensionReason(namedCleanup[2])}`;
  const template = EXTENSION_REASON_TEMPLATES.find(([prefix]) => reason.startsWith(prefix));
  return template ? t(template[1], { error: localizeExtensionReason(reason.slice(template[0].length)) }) : localizeSafetyReason(reason);
}
