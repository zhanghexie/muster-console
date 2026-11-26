import { t } from './i18n';
import { localizeSafetyReason } from './safetyReason';

/** Stable service errors are translated only when returned to the phone UI. */
export const APP_UI_ERROR_KEYS = [
  '应用重启，执行结果需要核对',
  'RSS 检测到 fake-IP，但未发现系统代理或 TUN 网卡；请开启代理，或让该域名返回真实公网 DNS 地址',
  'RSS 的 TUN fake-IP 路径需要 HTTPS；请使用 HTTPS 订阅地址或开启系统代理',
  '飞书 CLI 超时', '飞书 CLI 未返回有效 JSON，请检查飞书连接', '飞书 CLI 操作失败',
  '飞书连接缺少有效的 CLI profile，请在 Channels 中重新接入飞书。',
  '无法取得手机机器人身份，不能判断群里的 @ 消息', '请选择手机专用机器人',
  '飞书会话响应缺少 chats，请刷新重试', '飞书会话分页异常，请刷新重试', '飞书会话缺少有效标识，请刷新重试',
  '飞书消息响应缺少 messages', '飞书消息缺少持久身份', '飞书分页未完成且没有续收游标',
  '飞书发送响应缺少 message_id，请核对远端状态',
  '系统凭据存储不可用。Windows 请登录当前账户；macOS 请解锁钥匙串；Linux 请启用 Secret Service 或 KWallet 后重试。密码未保存。',
  '图片处理组件不可用，请重新安装当前平台的工作台', '需要当前调度会话的受管附件路径',
  '受管附件不存在或已被清理', '只能导入当前调度会话的受管源附件',
  '手机机器人接入服务尚未就绪', '此会话不能用于手机，请联系手机专用机器人',
  '已有私聊连接已停用或关闭读取权限，请在“我的连接”中启用', '请先启用短信应用，再连接私聊',
  '无效的飞书身份', '无效的飞书分页标记', '处理提示最多 2000 字符',
  '此会话已用于遥控调度，请选择另一个会话', '连接授权由手机管理，不能切换到其他机器人',
  '此会话已添加到手机，请编辑原连接', '连接目标不能更换；请为另一个邮箱或飞书会话新建连接，原连接可停用',
  '当前工作区的附件导入不可用'
] as const;
/** Previously translated status strings can outlive the locale in which they were produced. */
export const APP_STATUS_ERROR_KEYS = [
  '检查手机机器人超时，请重试', '无法读取手机机器人的授权状态，请重试', '检查手机机器人失败',
  '已找到手机机器人配置，但当前工作台无法读取它的机器人凭据。请在工作台使用的运行环境中恢复该机器人的授权；重新生成授权码不能修复凭据缺失。',
  '手机机器人接入未完成，请重试', '扫码进程已结束，但手机机器人的授权尚未保存，请重试',
  '接入超时，请重新扫码', '未能取得二维码，请重试', '手机机器人收信连接超时，请重试',
  '授权码已过期，请重新生成', '手机机器人收信服务未加载，请重启工作台', '无法识别手机机器人的 @ 身份，请重试连接'
] as const;
export const APP_UI_ERROR_TEMPLATES = [
  { prefix: '发送结果未确认，请核对远端后再决定是否重发：', key: '发送结果未确认，请核对远端后再决定是否重发：{{detail}}' },
  { prefix: '接收手机消息失败：', key: '接收手机消息失败：{{error}}' },
  { prefix: '保存手机会话失败，请重试：', key: '保存手机会话失败，请重试：{{error}}' }
] as const;
const keys = new Set<string>([...APP_UI_ERROR_KEYS, ...APP_STATUS_ERROR_KEYS]);

export function localizeAppUserErrorText(message: string): string {
  if (message === 'imap-mailbox-in-use') return t('同一个 IMAP 邮箱已有收取连接。请停用原连接，待它关闭后再试。');
  if (message === 'imap-mailbox-identity-invalid') return t('无法核对 IMAP 邮箱身份，请检查服务器、端口、登录名及文件夹。');
  if (message === 'imap-mailbox-close-unconfirmed') return t('IMAP 连接尚未确认关闭，请等待原连接关闭后重试。');
  if (keys.has(message)) return t(message);
  const template = APP_UI_ERROR_TEMPLATES.find(item => message.startsWith(item.prefix));
  if (!template) return localizeSafetyReason(message);
  const detail = message.slice(template.prefix.length);
  return t(template.key, { detail, error: detail });
}

export function localizeAppUserError(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  const translated = localizeAppUserErrorText(error.message);
  if (translated === error.message) throw error;
  const copy = new Error(translated, { cause: error });
  copy.name = error.name;
  throw copy;
}
