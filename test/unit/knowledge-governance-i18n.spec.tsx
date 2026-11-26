import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgeGovernance } from '../../src/renderer/src/components/KnowledgeGovernance';
import { applyLocaleSetting } from '../../src/shared/i18n';
import type { KnowledgeRecord } from '../../src/shared/knowledge';

const record: KnowledgeRecord = {
  schema: 1, id: 'current', revision: 2, kind: 'reusable_lesson', namespace: 'worker', status: 'active', origin: 'worker',
  summary: '当前记忆原文', problem: '', action: '', rationale: '', expectedFutureUse: '',
  applicability: ['新条件'], exceptions: [], evidence: [], createdAt: 1, updatedAt: 2, decisionReason: '', history: []
};
const target: KnowledgeRecord = { ...record, id: 'target', revision: 3, summary: '原始对照内容', applicability: ['旧条件'] };

it('switches the comparison interface between English and Chinese without changing user data or the action', async () => {
  const user = userEvent.setup(), onSubmit = vi.fn();
  try {
    act(() => { applyLocaleSetting('en'); });
    render(<KnowledgeGovernance record={record} targets={[target]} busy={false} onSubmit={onSubmit} />);
    expect(screen.getByRole('region', { name: 'Knowledge comparison' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Compare with knowledge' }));
    await user.click(await screen.findByRole('option', { name: '原始对照内容' }));
    expect(screen.getByText('Conditions added: 新条件; removed: 旧条件')).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Reason for decision' }), 'reviewed');
    await user.click(screen.getByRole('button', { name: 'Merge evidence' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: 'current', revision: 2, action: 'merge', reason: 'reviewed', targetId: 'target', targetRevision: 3 }));
    act(() => { applyLocaleSetting('zh-CN'); });
    await waitFor(() => expect(screen.getByRole('region', { name: '治理对照' })).toBeTruthy());
    expect(screen.getByText('新增条件：新条件；移除条件：旧条件')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '治理理由' }) as HTMLTextAreaElement).value).toBe('reviewed');
  } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
});
