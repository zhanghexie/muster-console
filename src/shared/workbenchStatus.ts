/** 工作台 /status 快照（纯函数，Channel 远程输入与电脑调度共用）。 */

import { t } from './i18n';

export type StatusDetail = 'brief' | 'verbose'

export function isVerboseStatusArg(raw: string | undefined): boolean {
  const a = (raw ?? '').trim().toLowerCase()
  return a === 'v' || a === 'verbose' || a === 'full' || a === '详细' || a === '详'
}

export type WorkbenchTerminalLine = {
  name: string
  runtime?: string
  status: string
  active?: boolean
  cwd?: string
  lifecycle?: string
  liveStatus?: string
}

export type WorkbenchStatusSnapshot = {
  workspaceName: string
  workspaceCount: number
  agentBusy: boolean
  agentSessionTitle?: string
  agentLastPreview?: string
  agentMode?: string
  terminals: WorkbenchTerminalLine[]
  boundSession?: { name: string }
}

export function formatWorkbenchStatus(s: WorkbenchStatusSnapshot, detail: StatusDetail): string {
  // 显示输出走 t()；isVerboseStatusArg 的比较值（'详细'/'详' 等）是解析逻辑，绝不翻译
  const title = s.agentSessionTitle?.trim()
  const agentLine = t(s.agentBusy ? '调度：忙碌' : '调度：空闲') + (title ? ` · ${title}` : '')
  const lines = [
    t('工作区：{{name}}', { name: s.workspaceName.trim() || t('（未知）') }),
    agentLine
  ]
  if (s.boundSession?.name.trim()) lines.push(t('绑定会话：{{name}}', { name: s.boundSession.name.trim() }))
  if (!s.terminals.length) {
    lines.push(t('终端：无'))
  } else {
    lines.push(t('终端（{{n}}）：', { n: s.terminals.length }))
    for (const term of s.terminals) {
      const bits = [term.name, term.runtime, term.status].filter(Boolean)
      let line = `· ${bits.join(' · ')}`
      if (term.active) line += t(' ←当前')
      if (detail === 'verbose') {
        const extra: string[] = []
        if (term.cwd) extra.push(term.cwd)
        if (term.lifecycle) extra.push(t('lifecycle：{{value}}', { value: term.lifecycle }))
        if (term.liveStatus) extra.push(term.liveStatus)
        if (extra.length) line += `\n  ${extra.join(' · ')}`
      }
      lines.push(line)
    }
  }
  if (detail === 'verbose') {
    lines.push(t('工作区数：{{n}}', { n: s.workspaceCount }))
    if (s.agentMode) lines.push(t('调度模式：{{mode}}', { mode: s.agentMode }))
    if (s.agentLastPreview?.trim()) lines.push(t('最近：{{text}}', { text: s.agentLastPreview.trim() }))
  }
  return lines.join('\n')
}
