import { expect, it } from 'vitest';
import type { FeedbackEntry } from '../../src/shared/feedback';
import { feedbackEditorSections, feedbackReadableBody, joinFeedbackSections, splitFeedbackBody } from '../../src/shared/feedbackFormatting';

it.each([
  '类型：问题\n涉及功能：会话列表\n\n使用场景：\n切换工作区\n\n实际情况：\n回到顶部\n\n环境：MetaAgent 1',
  '## 类型\n问题\n\n## 涉及功能\n会话\n\n## 实际情况\n回到顶部\n\n## 环境\nMetaAgent 1',
  '自由编辑的正文\n没有标准标题',
  '用户补充前言\n\n使用场景：\n切换工作区\n\n其他内容保留\n\n影响：\n需要重新定位'
])('preserves the complete body when splitting and rejoining sections', body => {
  expect(joinFeedbackSections(splitFeedbackBody(body))).toBe(body);
});

it('edits one section without changing the rest of a previously edited body', () => {
  const body = '类型：问题\n涉及功能：会话\n\n实际情况：\n回到顶部\n\n补充信息\n\n期望：\n恢复位置';
  const sections = splitFeedbackBody(body);
  expect(sections.map(section => section.label)).toEqual(['类型', '涉及功能', '实际情况', '期望']);
  sections.find(section => section.label === '实际情况')!.value = '列表闪烁';
  expect(joinFeedbackSections(sections)).toBe('类型：问题\n涉及功能：会话\n\n实际情况：\n列表闪烁\n\n期望：\n恢复位置');
});

it('offers optional fields without changing the body until they are filled', () => {
  const entry: FeedbackEntry = {
    id: 'feedback-1', revision: 1, status: 'pending', createdAt: 1, updatedAt: 1, sources: [], appVersion: '1.0',
    kind: 'bug', title: '列表位置丢失', area: '会话', context: '切换工作区', actual: '回到顶部',
    expected: '恢复位置', steps: '切换两次', impact: '需要重新定位', evidence: '', suggestion: ''
  };
  const sections = feedbackEditorSections(entry);
  expect(joinFeedbackSections(sections)).toBe(feedbackReadableBody(entry));
  sections.find(section => section.label === '建议')!.value = '保留滚动位置';
  expect(joinFeedbackSections(sections)).toContain('建议：\n保留滚动位置');
});

it('keeps old manual body text and offers separate fields without changing it', () => {
  const entry: FeedbackEntry = { id: 'legacy', revision: 1, status: 'pending', createdAt: 1, updatedAt: 1, sources: [], appVersion: '1',
    kind: 'bug', title: '旧反馈', area: '', context: '', actual: '', expected: '', steps: '', impact: '', evidence: '', suggestion: '',
    editedBody: '类型：问题\n\n反馈正文：\n此前保存的内容' };
  const sections = feedbackEditorSections(entry);
  expect(sections.find(section => section.label === '反馈正文')?.value).toBe('此前保存的内容');
  expect(sections.find(section => section.label === '实际情况')).toBeTruthy();
  expect(sections.find(section => section.label === '期望')).toBeTruthy();
  expect(joinFeedbackSections(sections)).toBe(entry.editedBody);
});

it('keeps text that resembles a field label inside its original structured field', () => {
  const entry: FeedbackEntry = { id: 'structured', revision: 1, status: 'pending', createdAt: 1, updatedAt: 1, sources: [], appVersion: '1',
    kind: 'bug', title: '反馈', area: '列表', context: '切换', actual: '日志内容\n期望：\n这里只是日志',
    expected: '恢复位置', steps: '切换后返回', impact: '影响阅读', evidence: '', suggestion: '', environment: 'Windows 11' };
  const sections = feedbackEditorSections(entry);
  expect(sections.find(section => section.label === '实际情况')?.value).toBe(entry.actual);
  expect(sections.find(section => section.label === '期望')?.value).toBe(entry.expected);
  expect(sections.find(section => section.label === '环境')?.value).toBe('Muster Console 1\nWindows 11');
  expect(joinFeedbackSections(sections)).toBe(feedbackReadableBody(entry));
});

it('omits blank optional fields and impact from the Issue while keeping optional inputs available', () => {
  const entry: FeedbackEntry = { id: 'minimal', revision: 1, status: 'pending', createdAt: 1, updatedAt: 1, sources: [], appVersion: '1',
    kind: 'bug', title: '只填标题', area: '', context: '', actual: '', expected: '', steps: '', impact: '', evidence: '', suggestion: '', environment: '' };
  const sections = feedbackEditorSections(entry);
  expect(feedbackReadableBody(entry)).toBe('类型：问题\n\n环境：Muster Console 1');
  expect(joinFeedbackSections(sections)).toBe(feedbackReadableBody(entry));
  expect(sections.find(section => section.label === '实际情况')?.optional).toBe(true);
  expect(sections.find(section => section.label === '影响')).toBeUndefined();
});

it('removes an optional field from the Issue when its text is cleared', () => {
  const entry: FeedbackEntry = { id: 'clear', revision: 1, status: 'pending', createdAt: 1, updatedAt: 1, sources: [], appVersion: '1',
    kind: 'bug', title: '反馈', area: '列表', context: '切换', actual: '位置丢失', expected: '恢复位置', steps: '切换', impact: '需要重找', evidence: '', suggestion: '' };
  const sections = feedbackEditorSections(entry);
  sections.find(section => section.label === '实际情况')!.value = '';
  sections.find(section => section.label === '影响')!.value = '';
  expect(joinFeedbackSections(sections)).not.toMatch(/实际情况：|影响：/);
  expect(joinFeedbackSections(sections)).toContain('期望：\n恢复位置');
  const legacy = feedbackEditorSections({ ...entry, editedBody: '类型：问题\n\n影响：\n需要重找\n\n环境：MetaAgent 1' });
  legacy.find(section => section.label === '影响')!.value = '';
  expect(joinFeedbackSections(legacy)).toBe('类型：问题\n\n环境：MetaAgent 1');
});
