/** 通知区词条（key = 中文原文）：设置 → 通知页（T1.4 偏好）与推送文案（「通知」本词已有 chat.ts） */
export const frag: Record<string, string> = {
  // ── 设置页签（SETTINGS_TABS / SETTINGS_FIELDS，数据驱动）──
  '推送开关 · 免打扰 · 飞书': 'Toggles · Quiet hours · Feishu',
  '推送开关': 'Push toggles',
  '免打扰时段': 'Quiet hours',
  '飞书仅绑定会话推': 'Feishu bound sessions only',

  // ── NotifyPane ──
  '会话看板翻转时主动推送（桌面气泡 / 手机 / 飞书）。规则由通知总线统一裁决：同类翻转 45 秒内去重，隐藏会话不推。':
    'Push on board phase flips (desktop toast / mobile / Feishu). The notify bus arbitrates: same-trigger flips are deduped within 45s; hidden sessions never push.',
  '产品规则：「需要你」必须能到达你，不可关闭':
    'Product rule: "Needs you" must always reach you and cannot be turned off',
  '需要你（等待输入 / 卡住）· 不可关闭': 'Needs you (waiting / blocked) · always on',
  '已完成（done）': 'Done',
  '出错（error）': 'Error',
  '启用免打扰': 'Enable quiet hours',
  '从': 'From',
  '到': 'To',
  '免打扰开始': 'Quiet hours start',
  '免打扰结束': 'Quiet hours end',
  '时段内拦「已完成 / 出错」；「需要你」照推。支持跨零点（如 22:00–08:00），起止相同视为无效。':
    'Blocks done/error notifications inside the window; "needs you" always goes through. Overnight windows supported (e.g. 22:00–08:00); equal start/end is invalid.',
  // ── NotifyPane · 无系统通知能力兜底（notification F-01）──
  '本机无系统通知能力，桌面通知无法显示；「需要你」提醒请依赖左栏胶囊与看板列。':
    'This machine cannot show system notifications, so desktop toasts will not appear; rely on the Needs-you pills in the left panel and the board column instead.'
};
