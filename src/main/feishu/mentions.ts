/** 群聊 @机器人 会留下 @_user_N 占位符；按 mentions 清理成纯文本 */
export function stripFeishuMentions(
  text: string,
  mentions?: readonly { key?: string; name?: string }[]
): string {
  let out = text;
  if (mentions?.length) {
    for (const m of mentions) {
      if (m.key) out = out.split(m.key).join('');
    }
  }
  out = out.replace(/@_user_\d+/g, '');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}
