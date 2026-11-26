import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ExtensionsManager } from '../../src/renderer/src/panels/ExtensionsManager';
import type { ExtensionPublishingApi, ExtensionSubmission, ExtensionSubmissionReview } from '../../src/shared/extensionPublishing';

const dialogPrototype = HTMLDialogElement.prototype;
const showModal = Object.getOwnPropertyDescriptor(dialogPrototype, 'showModal');
const close = Object.getOwnPropertyDescriptor(dialogPrototype, 'close');
beforeAll(() => Object.defineProperties(dialogPrototype, {
  showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
  close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
}));
afterAll(() => {
  if (showModal) Object.defineProperty(dialogPrototype, 'showModal', showModal);
  else Reflect.deleteProperty(dialogPrototype, 'showModal');
  if (close) Object.defineProperty(dialogPrototype, 'close', close);
  else Reflect.deleteProperty(dialogPrototype, 'close');
});

const item: ExtensionSubmission = { id: 'candidate', extensionId: 'xiangqi', name: '中国象棋', version: '1.0.0',
  repository: 'https://github.com/author/xiangqi', commit: 'a'.repeat(40), status: 'ready' };
function fixture(reviewer: boolean, login: string | null = 'author') {
  const session = { available: true, login: login ?? undefined, reviewer };
  const detail: ExtensionSubmissionReview = { ...item, trialed: false, report: { release: { packageKey: 'author/xiangqi', publisherId: 'author',
    extensionId: item.extensionId, name: item.name, version: item.version, fingerprint: `package-extension:${'a'.repeat(64)}`,
    packageUrl: `${item.repository}/releases/1.0.0.json`, sha256: 'b'.repeat(64) }, fileCount: 9, syntaxChecked: 4,
    permissions: ['data', 'theme'], mcp: [], domainEntry: 'domain.mjs' } };
  const api = { session: vi.fn().mockImplementation(async () => ({ ...session })), signIn: vi.fn().mockImplementation(async () => {
    session.login = 'author';
    return { ...session };
  }),
    connection: vi.fn().mockResolvedValue({ ok: true, origin: 'https://publishing.example.com', local: false }),
    startLocal: vi.fn().mockResolvedValue({ ok: true }), stopLocal: vi.fn().mockResolvedValue({ ok: true }),
    authorizeRepository: vi.fn().mockResolvedValue(undefined), submit: vi.fn().mockResolvedValue(item), mine: vi.fn().mockResolvedValue([]),
    queue: vi.fn().mockResolvedValue([item]), review: vi.fn().mockResolvedValue(detail), previewTarget: vi.fn().mockResolvedValue(null),
    trial: vi.fn().mockImplementation(async () => { detail.trialed = true; }), decide: vi.fn().mockResolvedValue({ ...item, status: 'published' }) } satisfies ExtensionPublishingApi;
  render(<ExtensionsManager workspaceId="w" sourceRootId="r" projectLabel="Test" publishingApi={api} setEnabled={async () => {}}
    listing={{ global: [{ id: 'xiangqi', workspaceId: 'w', directory: '/source/xiangqi', status: 'installed', manifest: {
      id: 'xiangqi', name: '中国象棋', scope: 'global', surface: { kind: 'sidebar' }, data: { workspace: true, shared: false }, permissions: [],
    } }], project: [], problems: [], issues: [] }} />);
  return api;
}

function openPublishingManagement() {
  const tab = screen.getByRole('tab', { name: '扩展中心' });
  for (let i = 0; i < 3; i++) fireEvent.click(tab, { shiftKey: true });
  return screen.findByRole('dialog', { name: '发布管理' });
}

it('submits the selected local extension with the single repository field and hides the review queue from authors', async () => {
  const api = fixture(false, null);
  fireEvent.click(await screen.findByRole('button', { name: '提交到扩展中心' }));
  const dialog = await screen.findByRole('dialog', { name: '提交到扩展中心' });
  fireEvent.change(within(dialog).getByLabelText('公开 GitHub 仓库地址'), { target: { value: item.repository } });
  fireEvent.click(within(dialog).getByRole('button', { name: '提交审核' }));
  await waitFor(() => expect(api.submit).toHaveBeenCalledWith('xiangqi', item.repository));
  expect(api.signIn).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('tab', { name: '扩展中心' }));
  expect(screen.queryByRole('button', { name: '待审核' })).toBeNull();
  const management = await openPublishingManagement();
  expect(await within(management).findByText(/当前账号无审核权限/)).toBeTruthy();
  expect(within(management).queryByRole('button', { name: '待审核' })).toBeNull();
  expect(api.queue).not.toHaveBeenCalled();
});

it('presents the checked package to a reviewer and only enables approval after trial install', async () => {
  const api = fixture(true);
  const tab = screen.getByRole('tab', { name: '扩展中心' });
  for (let i = 0; i < 3; i++) fireEvent.click(tab);
  expect(screen.queryByRole('dialog', { name: '发布管理' })).toBeNull();
  expect(screen.queryByRole('button', { name: '待审核' })).toBeNull();
  fireEvent.click(tab, { shiftKey: true });
  fireEvent.click(tab, { shiftKey: true });
  expect(screen.queryByRole('dialog', { name: '发布管理' })).toBeNull();
  fireEvent.click(tab);
  const management = await openPublishingManagement();
  const queue = await within(management).findByRole('button', { name: '待审核' });
  await waitFor(() => expect(queue).toHaveProperty('disabled', false));
  fireEvent.click(queue);
  const dialog = await screen.findByRole('dialog', { name: '待审核' });
  fireEvent.click(await within(dialog).findByRole('button', { name: /中国象棋/ }));
  const approve = await within(dialog).findByRole('button', { name: '批准并发布' });
  expect(approve).toHaveProperty('disabled', true);
  fireEvent.click(within(dialog).getByRole('button', { name: '试装' }));
  await waitFor(() => expect(approve).toHaveProperty('disabled', false));
  expect(api.trial).toHaveBeenCalledWith(item.id);
  fireEvent.click(approve);
  await waitFor(() => expect(api.decide).toHaveBeenCalledWith(item.id, 'approve', undefined));
});

it('starts and stops the owned service and keeps startup failures in publishing management', async () => {
  const api = fixture(false, null);
  api.connection.mockResolvedValue({ ok: true, local: false });
  api.session.mockResolvedValue({ available: false, reviewer: false });
  api.startLocal.mockResolvedValueOnce({ ok: false, error: '端口已占用' }).mockImplementationOnce(async () => {
    api.connection.mockResolvedValue({ ok: true, origin: 'http://127.0.0.1:8791', local: true });
    api.session.mockResolvedValue({ available: true, reviewer: false });
    return { ok: true };
  });
  api.stopLocal.mockImplementationOnce(async () => {
    api.connection.mockResolvedValue({ ok: true, local: false });
    api.session.mockResolvedValue({ available: false, reviewer: false });
    return { ok: true };
  });
  const dialog = within(await openPublishingManagement());
  const start = await dialog.findByRole('button', { name: '启动本机服务…' });
  await waitFor(() => expect(start).toHaveProperty('disabled', false));
  fireEvent.click(start);
  expect(await dialog.findByRole('alert')).toHaveProperty('textContent', '端口已占用');
  fireEvent.click(start);
  const stop = await dialog.findByRole('button', { name: '停止本机服务' });
  await waitFor(() => expect(stop).toHaveProperty('disabled', false));
  expect(dialog.getByText('http://127.0.0.1:8791')).toBeTruthy();
  expect(dialog.getByRole('button', { name: '登录 GitHub' })).toHaveProperty('disabled', false);
  expect(dialog.queryByRole('button', { name: '待审核' })).toBeNull();
  fireEvent.click(stop);
  await waitFor(() => expect(dialog.getByRole('button', { name: '启动本机服务…' })).toHaveProperty('disabled', false));
  expect(api.stopLocal).toHaveBeenCalledOnce();
});
