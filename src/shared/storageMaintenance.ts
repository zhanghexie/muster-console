/** A cleanup group is a user-visible operation. Its physical members live in the main-process catalog. */
export const storageMaintenanceCopy = {
  chromiumCache: {
    name: '工作台网页和图形缓存',
    effect: '清除工作台网页缓存和编译后的图形缓存。下次使用时按需重建。',
    risk: 'low'
  },
  workbenchWebData: {
    name: '工作台界面本地数据',
    effect: '清除工作台的界面偏好、未发送草稿和本地网页数据。使用该存储的页面可能需要重新登录。',
    risk: 'high'
  },
  appCache: {
    name: '工作台应用缓存',
    effect: '删除可由工作台重新生成的应用缓存。',
    risk: 'low'
  },
  crashReports: {
    name: '崩溃转储',
    effect: '删除已保存的崩溃转储。历史崩溃的诊断文件将不可用。',
    risk: 'low'
  },
  processProfiles: {
    name: '性能采集快照',
    effect: '删除进程监控保存的 CPU 和内存采集文件。',
    risk: 'low'
  },
  modelCatalogs: {
    name: '模型目录缓存',
    effect: '清除已发现的模型和参数缓存。内置目录会重新加载，外部目录可重新刷新。',
    risk: 'low'
  },
  toolOutputs: {
    name: '工具结果全文缓存',
    effect: '删除上下文裁剪前保存的全文。历史回复中的摘要仍可查看，原全文链接会失效。',
    risk: 'medium'
  },
  evidence: {
    name: '会话证据',
    effect: '清除会话证据索引和其中保存的切片。历史证据页中的对应记录将不可用。',
    risk: 'medium'
  },
  desktopCaptures: {
    name: '桌面截图和采集记录',
    effect: '删除桌面采集文件和相应索引。历史截图链接会失效。',
    risk: 'medium'
  },
  usageHistory: {
    name: '使用统计和明细',
    effect: '清除工作台已记录的使用统计、模型调用和工具失败明细。',
    risk: 'medium'
  },
  capabilityUsage: {
    name: '能力使用统计',
    effect: '清除能力管理中的历史使用计数。',
    risk: 'low'
  },
  sessionReminders: {
    name: '会话待办提醒',
    effect: '清除全部会话的待办和已完成提醒。',
    risk: 'high'
  },
  waitingTips: {
    name: '自定义等待提示',
    effect: '清除自定义等待提示，恢复工作台默认文案。',
    risk: 'low'
  },
  backgroundTasks: {
    name: '后台任务记录和输出',
    effect: '工作台退出时停止后台任务。下次启动清除任务记录、输出和尚未投递的任务摘要。',
    risk: 'high'
  }
} as const;

export type StorageMaintenanceId = keyof typeof storageMaintenanceCopy;
