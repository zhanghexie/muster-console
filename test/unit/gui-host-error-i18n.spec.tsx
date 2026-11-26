import { renderWithAppTips as render } from './helpers/app-tips';
import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { applyLocaleSetting, t } from '../../src/shared/i18n';
import { GUI_HOST_ERROR_KEYS, GUI_HOST_ERROR_TEMPLATES, GUI_HOST_ERROR_FRAMES, GUI_HOST_ERROR_SUFFIXES, GUI_HOST_TIMEOUT_LABELS, localizeGuiHostError } from '../../src/shared/guiHostError';
import { parseRuntimeDeliveryResult } from '../../src/shared/runtimeCommunication';
import { assertLaunchModel, parseGuiModelArg } from '../../src/shared/guiInheritMeta';
import { externalPiModelKey } from '../../src/shared/externalPiModel';
import { externalPiModels, selectExternalPiModel } from '../../src/main/agentSession/drivers/externalPi/models';
import { SessionPersister } from '../../src/main/sessions/persister';
import { boundedAcpRequest } from '../../src/main/agentSession/processReclamation';
import { selectSubagentCharacter } from '../../src/shared/subagentCharacters';

afterEach(() => { act(() => { applyLocaleSetting('zh-CN'); }); });

it('shows localized host errors while keeping the stored message and retry behavior', () => {
  const message = { id: 'm', role: 'assistant' as const, content: '', createdAt: 1, error: '分叉投递状态无法保存：原始磁盘错误' };
  const retry = vi.fn();
  const view = render(<ChatMessageView message={message} onRetry={retry} quiet />);
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
  expect(screen.getByText('分叉投递状态无法保存：原始磁盘错误')).toBeTruthy();
  act(() => { applyLocaleSetting('en'); });
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));
  expect(screen.getByText('Could not save the fork delivery state: 原始磁盘错误')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(retry).toHaveBeenCalledOnce();
  expect(message.error).toBe('分叉投递状态无法保存：原始磁盘错误');
  expect(localizeGuiHostError('模型原始错误')).toBe('模型原始错误');
  view.unmount();
});

it('shows the strict session-reset conflict in the selected language', () => {
  const message = { id: 'reset', role: 'assistant' as const, content: '', createdAt: 1, error: '该会话正在清空，请稍后再试' };
  act(() => { applyLocaleSetting('en'); });
  render(<ChatMessageView message={message} quiet/>);
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));
  expect(screen.getByText('This session is being cleared. Try again shortly.')).toBeTruthy();
  expect(message.error).toBe('该会话正在清空，请稍后再试');
});

it('translates an invalid legacy character ID while retaining the original diagnostic', () => {
  let raw!: Error;
  try { selectSubagentCharacter('', 'invalid-character'); } catch (error) { raw = error as Error; }
  const message = { id: 'character', role: 'assistant' as const, content: '', createdAt: 1, error: raw.message };
  act(() => { applyLocaleSetting('en'); });
  render(<ChatMessageView message={message} quiet/>);
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));
  expect(screen.getByText('Unknown subagent character ID: invalid-character')).toBeTruthy();
  expect(raw.message).toBe('未知子代理角色 characterId: invalid-character');
});

it('translates both host clauses when strict session persistence and requeue fail', async () => {
  const persister = new SessionPersister({ saveSessionsStrict: async () => { throw new Error('原始磁盘错误'); }, saveSessions: () => { throw new Error('原始重排错误'); } } as any, () => []);
  let raw!: Error;
  try { await persister.flushStrict(() => {}); } catch (error) { raw = error as Error; }
  persister.cancel();
  const message = { id: 'persist', role: 'assistant' as const, content: '', createdAt: 1,
    error: `会话清空未完成，已停止自动续写：${raw.message}；请检查本地历史后再处理` };
  act(() => { applyLocaleSetting('en'); });
  render(<ChatMessageView message={message} quiet/>);
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));
  expect(screen.getByText('The session was not fully cleared and automatic continuation stopped: Could not write the session registry: Error: 原始磁盘错误; could not requeue it: Error: 原始重排错误; check local history before proceeding.')).toBeTruthy();
  expect(raw.message).toBe('会话注册表严格写入失败：Error: 原始磁盘错误；重新排队失败：Error: 原始重排错误');
  const ambiguous = '会话注册表严格写入失败：原始错误；重新排队失败：嵌套信息；重新排队失败：其他信息';
  expect(localizeGuiHostError(ambiguous)).toBe(ambiguous);
});

it('localizes the real external model catalog cancellation without changing its original error', async () => {
  const controller = new AbortController(); controller.abort();
  const original = await boundedAcpRequest(Promise.resolve(), 100, '外部 Pi 模型目录', controller.signal)
    .then(() => { throw new Error('expected cancellation'); }, error => error as Error);
  expect(original.message).toBe('外部 Pi 模型目录 已取消');
  const message = { id: 'catalog-cancel', role: 'assistant' as const, content: '', createdAt: 1, error: original.message };
  act(() => { applyLocaleSetting('en'); });
  render(<ChatMessageView message={message} quiet/>);
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));
  expect(screen.getByText('External Pi model catalog was cancelled.')).toBeTruthy();
  expect(original.message).toBe('外部 Pi 模型目录 已取消');
});

it('has English resources for each known host diagnostic', () => {
  act(() => { applyLocaleSetting('en'); });
  for (const key of GUI_HOST_ERROR_KEYS) expect(t(key), key).not.toBe(key);
  for (const label of GUI_HOST_TIMEOUT_LABELS) {
    expect(localizeGuiHostError(`${label} 超时`), label).not.toMatch(/[\u3400-\u9fff]/);
    expect(localizeGuiHostError(`${label} 已取消`), label).not.toMatch(/[\u3400-\u9fff]/);
  }
  expect(localizeGuiHostError('外部未知错误 超时')).toBe('外部未知错误 超时');
  for (const item of GUI_HOST_ERROR_TEMPLATES) expect(localizeGuiHostError(`${item.prefix}original`)).toContain('original');
  for (const item of GUI_HOST_ERROR_FRAMES) expect(localizeGuiHostError(`${item.prefix}original${item.suffix}`)).toContain('original');
  for (const item of GUI_HOST_ERROR_SUFFIXES) expect(localizeGuiHostError(`original${item.suffix}`)).toContain('original');
  expect(localizeGuiHostError('分叉期间源会话已变化，请重试（已创建原生会话 native-1）')).toBe('The source session changed during the fork. Try again. (Native session native-1 was created)');
  expect(localizeGuiHostError('分叉数据准备失败：原始错误；清理临时数据失败：原始权限错误（会话 native-1）')).toBe('Could not prepare fork data: 原始错误; temporary data cleanup failed: 原始权限错误 (session native-1)');
  expect(localizeGuiHostError('会话正在分叉，请稍后再试；保护记录无法保存：原始错误')).toBe('The session is being forked. Try again shortly; the protection record could not be saved: 原始错误');
  expect(localizeGuiHostError("Error invoking remote method 'gui:history': Error: 原生分叉索引格式损坏")).toBe('The native fork index is corrupted.');
  expect(localizeGuiHostError('Error: 模型原始错误')).toBe('Error: 模型原始错误');
});

it('shows a translated memory processing failure without altering the chat message', () => {
  const message = { id: 'memory', role: 'assistant' as const, content: '', createdAt: 1, error: '专用记忆Pi会话尚未配置' };
  act(() => { applyLocaleSetting('en'); });
  const view = render(<ChatMessageView message={message} quiet />);
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));
  expect(screen.getByText('The dedicated memory Pi session is not configured.')).toBeTruthy();
  expect(message.error).toBe('专用记忆Pi会话尚未配置');
  view.unmount();
});

it('translates an attachment recovery error without changing its stored text', () => {
  const message = { id: 'attachment', role: 'assistant' as const, content: '', createdAt: 1, error: '当前协议无法发送历史原生附件，请切回原模型或开启新会话' };
  act(() => { applyLocaleSetting('en'); });
  render(<ChatMessageView message={message} quiet />);
  fireEvent.click(screen.getByRole('button', { name: 'View details' }));
  expect(screen.getByText('This protocol cannot send a previous native attachment. Switch back to the original model or start a new session.')).toBeTruthy();
  expect(message.error).toBe('当前协议无法发送历史原生附件，请切回原模型或开启新会话');
});

it('translates host failure wrappers while preserving upstream details and the Chinese original', () => {
  const nested = '原生分叉截点保存失败：原生分叉索引格式损坏';
  expect(localizeGuiHostError(nested)).toBe(nested);
  act(() => { applyLocaleSetting('en'); });
  expect(localizeGuiHostError(nested)).toBe('Could not save the native fork point: The native fork index is corrupted.');
  expect(localizeGuiHostError('分叉会话恢复标识无法保存：磁盘错误；请检查本地存储')).toBe('Could not save the forked session resume ID: 磁盘错误; check local storage.');
  expect(localizeGuiHostError('upstream error；消息投递状态未知，已停止自动重发，请检查引擎历史后再决定如何继续')).toBe('upstream error; message delivery is unknown. Automatic resending stopped; check engine history before continuing.');
  expect(localizeGuiHostError('外部错误：用户原文')).toBe('外部错误：用户原文');
  expect(localizeGuiHostError('停止时无法确认引擎资源已回收：无法确认 Windows 进程组的归属与回收：工作进程身份校验失败'))
    .toBe('Could not confirm engine resources were reclaimed while stopping: Could not confirm Windows process group ownership and cleanup: Worker process identity verification failed.');
  expect(localizeGuiHostError('工作进程已先退出，无法安全确认或回收原进程组')).toBe('The worker process already exited; the original process group cannot be safely confirmed or reclaimed.');
});

it('localizes late cleanup and session creation envelopes without altering unknown errors', () => {
  act(() => { applyLocaleSetting('en'); });
  expect(localizeGuiHostError('迟到的引擎连接回收失败：磁盘原始错误'))
    .toBe('Could not reclaim a late engine connection: 磁盘原始错误');
  for (const prefix of ['创建会话失败：', 'Failed to create session: ']) {
    expect(localizeGuiHostError(`${prefix}分叉数据准备失败：原始错误（已创建原生会话 native-1）`))
      .toBe('Failed to create session: Could not prepare fork data: 原始错误 (Native session native-1 was created)');
  }
  expect(localizeGuiHostError('模型原始错误（已创建原生会话 native-1）'))
    .toBe('模型原始错误（已创建原生会话 native-1）');
});

it('explains an invalid runtime delivery receipt in English without changing the protocol error', () => {
  let original!: Error;
  try { parseRuntimeDeliveryResult({ status: 'accepted', method: 'unknown' }); } catch (error) { original = error as Error; }
  expect(original.message).toBe('通信接入返回了无效回执；投递状态未知，未自动切换通道');
  act(() => { applyLocaleSetting('en'); });
  expect(localizeGuiHostError(original.message)).toBe('The communication adapter returned an invalid receipt. Delivery is unknown; no automatic fallback was attempted.');
  expect(original.message).toBe('通信接入返回了无效回执；投递状态未知，未自动切换通道');
});

it('localizes launch metadata validation at the display boundary without rewriting the input error', () => {
  const errors: Error[] = [];
  for (const invoke of [() => parseGuiModelArg(null as any), () => assertLaunchModel('my-cli', { providerId: 'p', modelId: 'm' }, false),
    () => assertLaunchModel('acp', { providerId: 'external', modelId: 'm' }, true)]) {
    try { invoke(); } catch (error) { errors.push(error as Error); }
  }
  expect(errors).toHaveLength(3);
  const originals = errors.map(error => error.message);
  act(() => { applyLocaleSetting('en'); });
  expect(errors.map(error => localizeGuiHostError(error.message))).toEqual([
    'model must be an object containing providerId and modelId.',
    'Runtime my-cli is a CLI integration and does not accept GUI model parameters; use its native model configuration.',
    'Runtime acp requires model.providerId to be acp; received external.'
  ]);
  expect(errors.map(error => error.message)).toEqual(originals);
});

it('localizes external Pi catalog failures while preserving model identities and errors', () => {
  const choices = [{ id: externalPiModelKey('a/b', 'c'), name: 'one' }, { id: externalPiModelKey('a', 'b/c'), name: 'two' }];
  const errors: Error[] = [];
  for (const invoke of [() => externalPiModelKey('', 'm'), () => externalPiModels({}),
    () => externalPiModels({ models: [{ provider: '', id: 'm' }] }), () => selectExternalPiModel(choices, 'a/b/c'),
    () => selectExternalPiModel(choices, 'missing')]) {
    try { invoke(); } catch (error) { errors.push(error as Error); }
  }
  expect(errors).toHaveLength(5);
  const originals = errors.map(error => error.message);
  act(() => { applyLocaleSetting('en'); });
  expect(errors.map(error => localizeGuiHostError(error.message))).toEqual([
    'The external Pi model identity is invalid.',
    'External Pi did not return a complete, valid model catalog.',
    'The external Pi model catalog contains an invalid identity.',
    'The old external Pi model name matches multiple models. Refresh the catalog and select again.',
    'The selected model is not in the current external Pi catalog. Refresh and select again.'
  ]);
  expect(errors.map(error => error.message)).toEqual(originals);
});
