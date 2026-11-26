import type { FeedbackEntry } from './feedback';
import { PRODUCT_NAME } from './productIdentity';

/** The editable Issue body, without the internal reconciliation marker. */
export function feedbackReadableBody(entry: FeedbackEntry): string {
  if (entry.editedBody !== undefined) return entry.editedBody;
  return [
    `类型：${entry.kind === 'bug' ? '问题' : '改进建议'}${entry.area ? `\n涉及功能：${entry.area}` : ''}`,
    ...(entry.context ? [`使用场景：\n${entry.context}`] : []),
    ...(entry.actual ? [`实际情况：\n${entry.actual}`] : []),
    ...(entry.expected ? [`期望：\n${entry.expected}`] : []),
    ...(entry.steps ? [`复现步骤或触发条件：\n${entry.steps}`] : []),
    ...(entry.impact ? [`影响：\n${entry.impact}`] : []),
    ...(entry.evidence ? [`证据与不确定性：\n${entry.evidence}`] : []),
    ...(entry.suggestion ? [`建议：\n${entry.suggestion}`] : []),
    `环境：${PRODUCT_NAME} ${entry.appVersion}${entry.environment ? `\n${entry.environment}` : ''}`
  ].join('\n\n');
}

/** The first line becomes the Issue title; the rest is the complete Issue body. */
export function feedbackEditableText(entry: FeedbackEntry): string {
  return `${entry.title}\n\n${feedbackReadableBody(entry)}`;
}

export interface FeedbackEditorSection {
  label: string;
  prefix: string;
  leading: string;
  value: string;
  trailing: string;
  optional?: boolean;
}

/** Split known labels while preserving the complete original text byte-for-byte. */
export function splitFeedbackBody(body: string): FeedbackEditorSection[] {
  const names = '类型|涉及功能|使用场景|实际情况|期望|复现步骤或触发条件|影响|证据与不确定性|建议|环境|反馈正文';
  const pattern = new RegExp(`(^|\\n)(?:##[ \\t]+(${names})[ \\t]*(?:\\n|$)|(${names})[：:][ \\t]*)`, 'g');
  const matches = [...body.matchAll(pattern)];
  const section = (label: string, prefix: string, raw: string): FeedbackEditorSection => {
    const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw)!;
    return { label, prefix, leading: parts[1]!, value: parts[2]!, trailing: parts[3]! };
  };
  if (!matches.length) return [section('反馈正文', '', body)];
  const result: FeedbackEditorSection[] = [];
  if (matches[0]!.index! > 0) result.push(section('反馈正文', '', body.slice(0, matches[0]!.index)));
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const start = match.index! + match[0].length;
    const end = matches[i + 1]?.index ?? body.length;
    result.push(section(match[2] ?? match[3]!, match[0], body.slice(start, end)));
  }
  return result;
}

export function joinFeedbackSections(sections: FeedbackEditorSection[]): string {
  return sections.map(item => item.optional && !item.value.trim() ? '' : item.prefix + item.leading + item.value + item.trailing).join('');
}

export function feedbackEditorSections(entry: FeedbackEntry): FeedbackEditorSection[] {
  if (entry.editedBody === undefined) {
    const section = (label: string, prefix: string, value: string, optional = false): FeedbackEditorSection =>
      ({ label, prefix, leading: '', value, trailing: '', ...(optional ? { optional: true } : {}) });
    const mayOmit = (value: string): boolean => !value || !!value.trim();
    return [
      section('类型', '类型：', entry.kind === 'bug' ? '问题' : '改进建议'),
      section('涉及功能', '\n涉及功能：', entry.area, mayOmit(entry.area)),
      section('使用场景', '\n\n使用场景：\n', entry.context, mayOmit(entry.context)),
      section('实际情况', '\n\n实际情况：\n', entry.actual, mayOmit(entry.actual)),
      section('期望', '\n\n期望：\n', entry.expected, mayOmit(entry.expected)),
      section('复现步骤或触发条件', '\n\n复现步骤或触发条件：\n', entry.steps, mayOmit(entry.steps)),
      ...(entry.impact ? [section('影响', '\n\n影响：\n', entry.impact, mayOmit(entry.impact))] : []),
      section('证据与不确定性', '\n\n证据与不确定性：\n', entry.evidence, mayOmit(entry.evidence)),
      section('建议', '\n\n建议：\n', entry.suggestion, mayOmit(entry.suggestion)),
      section('环境', '\n\n环境：', `${PRODUCT_NAME} ${entry.appVersion}${entry.environment ? `\n${entry.environment}` : ''}`, true)
    ];
  }
  const sections = splitFeedbackBody(feedbackReadableBody(entry));
  const optionalExisting = new Set(['涉及功能', '使用场景', '实际情况', '期望', '复现步骤或触发条件', '影响', '证据与不确定性', '建议', '环境']);
  for (const item of sections) if (optionalExisting.has(item.label) && item.value.trim()) item.optional = true;
  if (!sections.some(item => ['类型', '涉及功能', '实际情况', '使用场景'].includes(item.label))) return sections;
  const legacyManual = sections.some(item => item.label === '类型') && sections.some(item => item.label === '反馈正文');
  const optionalLabels = legacyManual
    ? ['涉及功能', '使用场景', '实际情况', '期望', '复现步骤或触发条件', '证据与不确定性', '建议', '环境']
    : ['证据与不确定性', '建议'];
  for (const label of optionalLabels) {
    if (sections.some(item => item.label === label)) continue;
    const environment = sections.findIndex(item => item.label === '环境');
    sections.splice(environment < 0 ? sections.length : environment, 0, { label, prefix: `\n\n${label}：\n`, leading: '', value: '', trailing: '', optional: true });
  }
  return sections;
}
