import { t } from './i18n';

/** Translate only recognized host diagnostics at their UI display sites. */
export const GUI_HOST_ERROR_KEYS = [
  'DeepSeek 模型探测未确认临时存储，请检查 DSH 版本与自定义配置后重试',
  '外部 Pi 模型身份无效', '外部 Pi 未返回完整有效的模型目录', '外部 Pi 模型目录包含无效身份',
  '外部 Pi 旧模型名称与其他模型身份冲突，请重新选择', '外部 Pi 旧模型名称对应多个模型，请刷新目录并重新选择',
  '所选模型不在当前外部 Pi 模型目录中，请刷新目录并重新选择', '外部 Pi 模型目录读取失败',
  'ZCode 未返回可用模型，请检查 ZCode CLI 的账号和服务商配置后再刷新',
  'model 必须是包含 providerId 与 modelId 的对象',
  '通信接入返回了无效回执；投递状态未知，未自动切换通道',
  '会话附件目录指向了非受管路径', '附件源文件超出会话目录', '当前协议无法发送历史原生附件，请切回原模型或开启新会话', 'Pi 缺少附件请求适配入口',
  '当前 PI 不支持宿主事件输入，请更新工作台', '宿主事件未写入 PI 会话，未记录消费成功', 'PI 未确认宿主事件已进入上下文，未记录成功',
  'Pi 技能目录兼容补丁未加载：请运行 npm install（或 node scripts/patch-pi-skill-discovery.mjs），然后重启工作台',
  'Shell 会话不支持 CLI 启动选项', '父会话已归档或删除，不能创建子代理', '子代理必须与父会话位于同一工作区',
  'GUI 会话不支持 CLI 启动选项', '交接会话标识无效或已被使用', '隔离目标尚未明确：请选择实际 Git 仓库，当前工作目录保持不变',
  '无效的交接会话标识', '交接文档目录不是受管目录', '交接文档根目录已指向其他位置',
  '交接文档目录已指向其他位置', '交接历史文档不存在或不是普通文件',
  '会话不存在或不支持读取模型目录', '引擎配置在模型校验期间变化，请重试', 'Codex 权限版本检测不可用',
  '引擎在权限校验期间变化，请重试', '会话或引擎配置已变化，请重新打开模型目录',
  '无法确认当前会话或引擎配置，请重新打开模型目录', '外部引擎模型验证不可用', '会话配置在模型校验期间已变化，请重试',
  '缺少 Windows 进程守护脚本', '缺少 Windows 受控工作进程身份校验',
  '工作进程在 Windows Job 赋值前退出，无法确认其后代状态', '进程已退出或开始回收，不能校验身份',
  'Windows Job 在身份校验前已赋值', '工作进程身份校验失败', '进程已退出或开始回收，不能赋值 Job',
  '进程已退出或开始回收，不能启动引擎', '工作进程已先退出，无法确认 Windows 子进程树已回收',
  '无法确认 Windows Job 归属', '工作进程已先退出，无法安全确认或回收原进程组', '无法确认工作进程组全部退出',
  '文件超出大小限制', '协议版本不匹配', '未找到 Windows 进程守护文件，请重新构建或重新安装工作台',
  '工作进程身份校验 超时', '工作进程身份校验 已取消', '工作进程退出 超时', '工作进程退出 已取消', '进程回收 超时', '进程回收 已取消',
  '待投递的分叉上下文无法读取，请保留会话并检查本地数据', '待投递的分叉上下文格式损坏',
  '原生分叉索引无法读取，请检查本地数据', '原生分叉索引格式损坏',
  '分叉上下文已投递，但引擎没有提供可恢复的会话标识；请检查原生历史后新建会话',
  '此 Cursor 旧会话使用已移除的 SDK，原生上下文无法通过 ACP 安全恢复；历史仍可查看，请新建 Cursor 会话',
  '引擎进程回收失败，会话仍被占用，请重试停止', '分叉会话回合结束时原生消息投递尚未确认，已停止自动续写；请检查原生历史',
  '操作期间引擎标识与会话记录不一致', '回合已变化，请重新发送消息', '原生通信期间连接已更换，投递状态未知',
  '等待旧引擎回收超时；请检查残留进程后重试', '回合已停止或被替代', '分叉上下文的引擎状态未知',
  '会话正在执行其他操作，请稍后再试', '分叉上下文的投递状态未知，请检查原生历史后新建会话',
  '会话正在接收消息，请稍后再分叉', '分叉期间源会话已变化，请重试', '分叉期间源引擎会话标识已变化，请重试',
  '分叉投递期间引擎标识与会话记录不一致，请检查原生历史后新建会话',
  '分叉上下文已投递，但引擎没有提供可恢复的会话标识；已停止继续发送和压缩，请检查原生历史后新建会话',
  '分叉会话的恢复标识不一致，已停止自动续写；请检查原生历史后新建会话',
  '上次清空会话未确认完成，已停止续写；请检查本地历史并重新清空',
  '分叉会话的引擎标识发生变化，无法确认原有上下文，已停止自动续写；请检查原生历史后新建会话',
  '分叉会话收到无法归属的引擎标识，已停止自动续写；请检查原生历史后新建会话',
  '会话正在分叉，请稍后再试', '会话正在分叉，请稍后再发', '会话正在分叉，请稍后再压缩',
  '会话正在清空，请稍后再压缩', '分叉上下文尚未确认投递，暂不能压缩会话',
  '会话正在清空或关闭', '引擎未提供可恢复的会话标识',
  '分叉投递期间引擎标识发生变化，无法确认上下文；请检查原生历史后新建会话',
  '分叉会话本轮的引擎状态未确认，已停止自动续写；请检查原生历史后新建会话',
  '分叉上下文已投递，但没有可恢复的引擎会话标识；请检查原生历史后新建会话',
  '分叉会话的原生标识恢复失败', '分叉上下文的引擎状态未知，请检查原生历史后新建会话',
  '分叉上下文状态未知，请先检查原生历史后新建会话', '分叉上下文的上次投递状态未知，请检查引擎历史后新建会话',
  '当前分叉会话暂不支持压缩：引擎未提供可关联的压缩完成事件', '压缩操作已结束或被替换，结果无法确认',
  '会话正在分叉，请稍后再清空', '会话正在清空，请稍后再试', '该会话正在清空，请稍后再试', '清空期间会话已关闭或替换', '会话清空期间引擎标识发生变化'
] as const;
export const GUI_HOST_ERROR_TEMPLATES = [
  { prefix: '未知子代理角色 characterId: ', key: '未知子代理角色 characterId: {{detail}}' },
  { prefix: '无法确认 Windows 子进程树已退出：', key: '无法确认 Windows 子进程树已退出：{{detail}}' },
  { prefix: '无法确认 Windows 进程组的归属与回收：', key: '无法确认 Windows 进程组的归属与回收：{{detail}}' },
  { prefix: 'Windows 进程守护文件不可用或版本不匹配，请重新构建或安装工作台：', key: 'Windows 进程守护文件不可用或版本不匹配，请重新构建或安装工作台：{{detail}}' },
  { prefix: '原生分叉截点保存失败：', key: '原生分叉截点保存失败：{{detail}}' },
  { prefix: '引擎连接回收未确认：', key: '引擎连接回收未确认：{{detail}}' },
  { prefix: '迟到的引擎连接回收失败：', key: '迟到的引擎连接回收失败：{{detail}}' },
  { prefix: '停止过程报告错误：', key: '停止过程报告错误：{{detail}}' },
  { prefix: '停止时无法确认引擎资源已回收：', key: '停止时无法确认引擎资源已回收：{{detail}}' },
  { prefix: '无法确认旧引擎连接已关闭，请检查残留进程并重启工作台：', key: '无法确认旧引擎连接已关闭，请检查残留进程并重启工作台：{{detail}}' },
  { prefix: '分叉投递状态无法保存：', key: '分叉投递状态无法保存：{{detail}}' },
  { prefix: '分叉投递结果无法保存：', key: '分叉投递结果无法保存：{{detail}}' },
  { prefix: '分叉会话无法确认恢复标识，未启动本次操作：', key: '分叉会话无法确认恢复标识，未启动本次操作：{{detail}}' },
  { prefix: '无法确认分叉进程已回收，请检查残留进程并重启工作台：', key: '无法确认分叉进程已回收，请检查残留进程并重启工作台：{{detail}}' },
  { prefix: '原生分叉失败：', key: '原生分叉失败：{{detail}}' },
  { prefix: '分叉数据准备失败：', key: '分叉数据准备失败：{{detail}}' },
  { prefix: '创建会话失败：', key: '创建会话失败：{{detail}}' }
] as const;
export const GUI_HOST_ERROR_FRAMES = [
  { prefix: '分叉会话恢复标识无法保存：', suffix: '；请检查本地存储', key: '分叉会话恢复标识无法保存：{{detail}}；请检查本地存储' },
  { prefix: '会话清空未完成，已停止自动续写：', suffix: '；请检查本地历史后再处理', key: '会话清空未完成，已停止自动续写：{{detail}}；请检查本地历史后再处理' },
  { prefix: '分叉会话历史无法可靠保存：', suffix: '；请检查本地历史后新建会话', key: '分叉会话历史无法可靠保存：{{detail}}；请检查本地历史后新建会话' }
] as const;
export const GUI_HOST_ERROR_COMPOUNDS = [
  { prefix: '会话注册表严格写入失败：', separator: '；重新排队失败：', key: '会话注册表严格写入失败：{{error}}；重新排队失败：{{requeue}}' }
] as const;
/** Labels supplied by the host's bounded process and protocol requests. */
export const GUI_HOST_TIMEOUT_LABELS = [
  'DeepSeek 临时探测存储确认',
  'ACP 认证', 'ACP 模型发现进程启动', 'ACP 初始化', 'ACP 模型目录', 'ACP 模型参数发现',
  'OpenCode 分叉服务启动', 'OpenCode 分叉服务就绪', 'Claude 模型发现', 'Claude 进程身份确认', 'Claude 模型发现关闭', 'Claude 原生分叉',
  'Codex 宿主工具连接', 'Codex 版本检测', 'Codex 桌面投递', 'Codex 协作模式确认', 'Codex 原生权限确认', 'Codex 原生设置进程启动',
  '外部 Pi 进程启动', 'Oh My Pi 启动', '外部 Pi 宿主桥接',
  '外部 Pi 模型发现进程启动', 'Oh My Pi 协议协商', '外部 Pi 模型目录', '外部 Pi 状态', '外部 Pi 分叉进程启动', '外部 Pi 分叉结果',
  'Oh My Pi 分叉进程启动', 'Oh My Pi 分叉协议', 'Muse 审批', 'Muse 取消提问', 'Muse 提问', 'Muse 进程启动', 'Muse 停止',
  'Muse 模型发现进程启动', 'Muse 初始化', 'Muse 模型目录', 'Muse 审批模式设置', 'Muse 权限配置设置', 'ZCode 停止', 'ZCode 模型发现进程启动', 'ZCode 模型目录',
  'ZCode 进程启动', 'ZCode 会话建立', 'ZCode 权限模式', 'ZCode 模型设置', 'ZCode 会话订阅', 'ZCode 发送',
  '工作进程身份校验', '工作进程退出', '进程回收'
] as const;
const timeoutLabels = new Set<string>(GUI_HOST_TIMEOUT_LABELS);
export const GUI_HOST_ERROR_SUFFIXES = [
  { suffix: '；消息投递状态未知，请检查引擎历史', key: '{{detail}}；消息投递状态未知，请检查引擎历史' },
  { suffix: '；分叉上下文投递状态未知，已停止自动续作，请检查引擎历史', key: '{{detail}}；分叉上下文投递状态未知，已停止自动续作，请检查引擎历史' },
  { suffix: '；消息投递状态未知，已停止自动重发，请检查引擎历史后再决定如何继续', key: '{{detail}}；消息投递状态未知，已停止自动重发，请检查引擎历史后再决定如何继续' },
  { suffix: '；无法确认消息未被引擎接收，已停止自动重发，请检查引擎历史', key: '{{detail}}；无法确认消息未被引擎接收，已停止自动重发，请检查引擎历史' }
] as const;
const known = new Set<string>(GUI_HOST_ERROR_KEYS);
export function localizeGuiHostError(value: string): string {
  if (known.has(value)) return t(value);
  const timeout = /^(.*) (超时|已取消)$/.exec(value);
  if (timeout && timeoutLabels.has(timeout[1])) return timeout[2] === '超时'
    ? t('{{operation}} 超时', { operation: t(timeout[1]) })
    : t('{{operation}} 已取消', { operation: t(timeout[1]) });
  const cliModel = /^runtime ([a-zA-Z0-9:_-]+) 是 CLI 接入，不接受 GUI model 参数；请使用该 CLI 的原生模型配置$/.exec(value);
  if (cliModel) return t('runtime {{runtime}} 是 CLI 接入，不接受 GUI model 参数；请使用该 CLI 的原生模型配置', { runtime: cliModel[1] });
  const provider = /^runtime ([a-zA-Z0-9:_-]+) 的 model\.providerId 必须为 \1，收到 ([\s\S]*)$/.exec(value);
  if (provider) return t('runtime {{runtime}} 的 model.providerId 必须为 {{runtime}}，收到 {{provider}}', { runtime: provider[1], provider: provider[2] });
  const launch = /^会话 ([a-zA-Z0-9:_-]+) 启动失败：([\s\S]*)；原会话保留$/.exec(value);
  if (launch) return t('会话 {{id}} 启动失败：{{error}}；原会话保留', {
    id: launch[1], error: launch[2] === '进程已退出' ? t('进程已退出') : launch[2]
  });
  const missing = /^会话不存在：([a-zA-Z0-9:_-]+)$/.exec(value);
  if (missing) return t('会话不存在：{{id}}', { id: missing[1] });
  const wrapped = /^(?:Error invoking remote method '[^']+': )?Error: ([\s\S]*)$/.exec(value);
  if (wrapped) {
    const detail = localizeGuiHostError(wrapped[1]);
    return detail === wrapped[1] ? value : detail;
  }
  const frame = GUI_HOST_ERROR_FRAMES.find(item => value.startsWith(item.prefix) && value.endsWith(item.suffix));
  if (frame) return t(frame.key, { detail: localizeGuiHostError(value.slice(frame.prefix.length, -frame.suffix.length)) });
  for (const compound of GUI_HOST_ERROR_COMPOUNDS) {
    if (!value.startsWith(compound.prefix)) continue;
    const detail = value.slice(compound.prefix.length);
    const split = detail.indexOf(compound.separator);
    // The delimiter can occur in an upstream error. Preserve ambiguous text.
    if (split < 0 || split !== detail.lastIndexOf(compound.separator)) return value;
    return t(compound.key, { error: detail.slice(0, split), requeue: detail.slice(split + compound.separator.length) });
  }
  const failedCleanup = /^分叉数据准备失败：([\s\S]*?)；清理临时数据失败：([\s\S]*?)（会话 ([^）]+)）$/.exec(value);
  if (failedCleanup) return t('分叉数据准备失败：{{error}}；清理临时数据失败：{{cleanup}}（会话 {{id}}）', { error: failedCleanup[1], cleanup: failedCleanup[2], id: failedCleanup[3] });
  const protectedState = /^(.*)；保护记录无法保存：([\s\S]*)$/.exec(value);
  if (protectedState) {
    const detail = localizeGuiHostError(protectedState[1]);
    if (detail !== protectedState[1]) return t('{{detail}}；保护记录无法保存：{{error}}', { detail: detail.endsWith('.') ? detail.slice(0, -1) : detail, error: protectedState[2] });
  }
  const created = /^(.*)（已创建原生会话 ([^）]+)）$/.exec(value);
  if (created) {
    const detail = localizeGuiHostError(created[1]);
    if (detail !== created[1] || created[1].startsWith('Failed to create session: '))
      return t('{{detail}}（已创建原生会话 {{id}}）', { detail, id: created[2] });
  }
  const englishCreationPrefix = 'Failed to create session: ';
  if (value.startsWith(englishCreationPrefix))
    return t('创建会话失败：{{detail}}', { detail: localizeGuiHostError(value.slice(englishCreationPrefix.length)) });
  const suffix = GUI_HOST_ERROR_SUFFIXES.find(item => value.length > item.suffix.length && value.endsWith(item.suffix));
  if (suffix) return t(suffix.key, { detail: localizeGuiHostError(value.slice(0, -suffix.suffix.length)) });
  const item = GUI_HOST_ERROR_TEMPLATES.find(entry => value.startsWith(entry.prefix));
  return item ? t(item.key, { detail: localizeGuiHostError(value.slice(item.prefix.length)) }) : value;
}

/** A fork result can append this host-owned suffix to an otherwise external error. */
export function localizeGuiForkError(value: string): string {
  const created = /^(.*)（已创建原生会话 ([^）]+)）$/.exec(value);
  return created
    ? t('{{detail}}（已创建原生会话 {{id}}）', { detail: localizeGuiHostError(created[1]), id: created[2] })
    : localizeGuiHostError(value);
}
