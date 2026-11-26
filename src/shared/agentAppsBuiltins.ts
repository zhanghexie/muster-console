import { CHANNEL_APP_ID, CHANNEL_APP_COMMANDS, defineRecordApp, validateAppDefinition, type AgentAppDefinition, type AppField } from './agentApps';
const text = (id: string, label: string, required = false): AppField => ({ id, label, type: 'text', required });
const flag = (id: string, label: string): AppField => ({ id, label, type: 'boolean' });
const body = (id: string, label: string): AppField => ({ id, label, type: 'multiline' });
const time = (id: string, label: string, required = false): AppField => ({ id, label, type: 'datetime', required });

export function builtInAgentApps(): AgentAppDefinition[] {
  const tasks = defineRecordApp({ id: 'tasks', name: '待办', icon: '✓', description: '我的责任、下一步与完成依据', titleField: 'title', bodyField: 'note', fields: [text('title', '要做什么', true), body('note', '下一步 / 完成依据'), flag('done', '已完成'), time('deadline', '截止时间'), text('waitingFor', '等待对象')] });
  tasks.views[0].kind = 'checklist';
  tasks.commands.push({ id: 'complete', title: '完成', handler: 'records.update', collection: 'items', patch: { done: true } }, { id: 'reopen', title: '恢复', handler: 'records.update', collection: 'items', patch: { done: false } });
  tasks.views[0].commands = ['create', 'update', 'complete', 'reopen', 'remove'];
  const reminders = defineRecordApp({ id: 'reminders', name: '提醒', icon: '◷', description: '到时候叫醒我', titleField: 'title', bodyField: 'note', fields: [text('title', '提醒内容', true), time('dueAt', '提醒时间', true), text('dailyTime', '重复时间（HH:mm）'), { id: 'repeatMinutes', label: '重复间隔（分钟，0为单次）', type: 'number' }, body('note', '处理说明'), flag('enabled', '启用'), text('targetApp', '关联应用'), text('targetId', '关联记录'), { id: 'missed', label: '错过时', type: 'select', options: ['catch-up', 'skip'] }] });
  reminders.collections[0].fields.push(text('weekdays', '每周星期（0=日，1=一，…6=六，逗号分隔）'));
  reminders.version = 4;
  reminders.commands = reminders.commands.filter(c => !['create', 'update'].includes(c.id));
  reminders.commands.push({ id: 'set', title: '设置提醒', handler: 'reminders.set', collection: 'items' }, { id: 'cancel', title: '取消提醒', handler: 'reminders.cancel', collection: 'items' });
  reminders.views[0].commands = ['set', 'cancel', 'remove'];
  const rss: AgentAppDefinition = { sdkVersion: 1, id: 'rss', name: '阅读', icon: '◔', version: 3, description: '订阅外面的新消息', homeView: 'articles', permissions: ['rss'],
    collections: [
      { id: 'articles', title: '文章', titleField: 'title', subtitleField: 'source', bodyField: 'content', fields: [text('title', '标题', true), text('source', '来源'), body('content', '正文'), { ...text('url', '原文'), type: 'url' }, time('publishedAt', '发布于'), flag('read', '已读'), flag('saved', '收藏'), { ...text('sourceId', '订阅ID'), readOnly: true }, { ...text('externalId', '来源标识'), readOnly: true }] },
      { id: 'feeds', title: '订阅', titleField: 'title', subtitleField: 'url', fields: [text('title', '订阅名称', true), { ...text('url', 'RSS / Atom 地址', true), type: 'url' }, { id: 'intervalMinutes', label: '刷新间隔（分钟）', type: 'number' }, text('keyword', '唤醒关键词（可选）'), { id: 'notify', label: '通知策略', type: 'select', options: ['digest', 'wake', 'mute'] }, body('notificationHint', '收到后怎么处理（留空使用默认）'), flag('enabled', '启用')] }
    ],
    commands: [
      { id: 'list', title: '阅读列表', handler: 'records.list', collection: 'articles' }, { id: 'get', title: '阅读文章', handler: 'records.get', collection: 'articles' },
      { id: 'read', title: '标为已读', handler: 'records.update', collection: 'articles', patch: { read: true } }, { id: 'save', title: '收藏', handler: 'records.update', collection: 'articles', patch: { saved: true } },
      { id: 'subscribe', title: '添加订阅', handler: 'rss.subscribe', collection: 'feeds' }, { id: 'sync', title: '刷新', handler: 'rss.sync', collection: 'articles' },
      { id: 'edit-feed', title: '编辑订阅', handler: 'records.update', collection: 'feeds' }, { id: 'remove-feed', title: '取消订阅', handler: 'records.remove', collection: 'feeds' }
    ],
    views: [{ id: 'articles', title: '阅读', kind: 'reader', collection: 'articles', commands: ['sync', 'read', 'save'] }, { id: 'feeds', title: '订阅', kind: 'list', collection: 'feeds', commands: ['subscribe', 'edit-feed', 'remove-feed'] }]
  };
  const mail = defineRecordApp({ id: 'mail', name: '邮箱', icon: '✉', description: '我的真实邮箱', titleField: 'subject', bodyField: 'body', fields: [text('subject', '主题', true), text('from', '发件人'), text('to', '收件人'), body('body', '正文'), text('accountId', '邮箱连接'), { id: 'folder', label: '文件夹', type: 'select', options: ['inbox', 'drafts', 'sent'] }, flag('read', '已读'), time('date', '时间'), { ...text('messageId', '邮件标识'), readOnly: true }, { ...text('uid', 'IMAP UID'), readOnly: true }, { ...text('status', '发送状态'), readOnly: true }, text('replyTo', '回复邮件ID'), body('attachments', '附件信息')] });
  mail.permissions = ['mail.read', 'mail.send']; mail.views[0].kind = 'reader';
  mail.collections[0].purpose = 'mail'; mail.collections[0].subtitleField = 'from';
  for (const field of mail.collections[0].fields) if (['from', 'folder', 'date', 'attachments'].includes(field.id)) field.readOnly = true;
  mail.version = 2;
  mail.commands.find(c => c.id === 'remove')!.title = '删除本地记录';
  mail.commands.push({ id: 'sync', title: '收信', handler: 'mail.sync', collection: 'items' }, { id: 'send', title: '发送', handler: 'mail.send', collection: 'items' }, { id: 'read', title: '标为已读', handler: 'records.update', collection: 'items', patch: { read: true } });
  mail.commands.push({ id: 'reply', title: '回复', handler: 'mail.reply', collection: 'items', presentation: { viewId: 'main', entity: 'result.id' } });
  mail.views[0].commands = ['create', 'update', 'sync', 'send', 'reply', 'read', 'remove'];
  const messages = defineRecordApp({ id: 'messages', name: '短信', icon: '▱', description: '通过飞书与外界对话', titleField: 'sender', bodyField: 'body', fields: [text('sender', '发信人'), body('body', '消息'), text('accountId', '对话连接'), text('chatId', '飞书对话'), time('date', '时间'), flag('read', '已读'), flag('mine', '我发送的'), text('replyTo', '回复消息ID'), { ...text('messageId', '消息标识'), readOnly: true }, { ...text('status', '发送状态'), readOnly: true }] });
  messages.permissions = ['messages.read', 'messages.send']; messages.views[0].kind = 'messages';
  messages.collections[0].purpose = 'messages';
  for (const field of messages.collections[0].fields) if (['sender', 'chatId', 'date', 'mine'].includes(field.id)) field.readOnly = true;
  messages.version = 2;
  messages.commands = messages.commands.filter(c => !['create', 'update'].includes(c.id));
  messages.commands.find(c => c.id === 'remove')!.title = '删除本地记录';
  messages.commands.push({ id: 'sync', title: '收取消息', handler: 'messages.sync', collection: 'items' }, { id: 'send', title: '发送消息', handler: 'messages.send', collection: 'items' }, { id: 'read', title: '标为已读', handler: 'records.update', collection: 'items', patch: { read: true } });
  messages.views[0].commands = ['sync', 'send', 'read', 'remove'];
  // Reading, processing and notification delivery are independent facts.
  for (const app of [mail, messages, rss]) {
    const collection = app.collections[0];
    collection.fields.push(flag('processed', '已处理'));
    app.commands.push({ id: 'processed', title: '标为已处理', handler: 'records.update', collection: collection.id, patch: { processed: true } });
    app.views[0].commands!.push('processed');
  }
  rss.version = 4;
  rss.commands.push({ id: 'remove', title: '删除本地记录', handler: 'records.remove', collection: 'articles' });
  rss.views[0].commands!.push('remove');
  for (const app of [mail, messages, rss]) {
    const reverse = [['unread', 'read', '标为未读'], ['unprocessed', 'processed', '标为未处理'], ...(app === rss ? [['unsave', 'saved', '取消收藏']] : [])];
    for (const [id, key, title] of reverse) {
      app.commands.push({ id, title, handler: 'records.update', collection: app.collections[0].id, patch: { [key]: false } });
      app.views[0].commands!.push(id);
    }
  }
  rss.collections[0].purpose = 'articles'; rss.collections[1].purpose = 'feeds';
  const channel: AgentAppDefinition = {
    sdkVersion: 1, id: CHANNEL_APP_ID, name: 'Channel', icon: '▱', version: 3,
    description: '在同一个收件箱读取和回复各来源的消息', homeView: 'main', collections: [],
    views: [{ id: 'main', title: 'Channel', kind: 'operation' }],
    commands: CHANNEL_APP_COMMANDS.map((id, index) => ({ id, title: ['渠道列表', '查询消息', '查看消息', '修改消息状态', '回复', '发送', '保存草稿', '搜索所有渠道', '渠道目录', '绑定渠道', '解除渠道绑定'][index], handler: 'channel.run', presentation: { viewId: 'main' } }))
  };
  return [tasks, reminders, mail, rss, messages, channel].map(validateAppDefinition);
}
