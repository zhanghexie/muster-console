import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ChatLinkBoundary } from '../../src/renderer/src/chatSurface/ChatLinkBoundary';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';
import { currentApiMock } from './helpers/api-mock';

vi.mock('../../src/renderer/src/webGatewayEnvironment', () => ({ isWebGateway: () => true }));

it('网页端将会话 URL 留给访问设备，不请求宿主浏览器或应用', () => {
  const onFileLink = vi.fn();
  render(<ChatLinkBoundary active cwd="/workspace" onFileLink={onFileLink} flashTip={vi.fn()} showWorkspace={vi.fn()}>
    <MarkdownBody localImages onFileLink={onFileLink} text="[网页](http://localhost:5173/page)" />
  </ChatLinkBoundary>);
  const link = screen.getByRole('link', { name: '网页' });
  expect(link.getAttribute('href')).toBe('http://localhost:5173/page');
  expect(link.getAttribute('target')).toBe('_blank');
  // jsdom cannot open browser windows; suppress only its native navigation.
  link.addEventListener('click', event => event.preventDefault());
  fireEvent.click(link);
  fireEvent.contextMenu(link);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(currentApiMock().mockOf('browser.open')).not.toHaveBeenCalled();
  expect(currentApiMock().mockOf('shell.openExternal')).not.toHaveBeenCalled();
  expect(currentApiMock().mockOf('shell.openPath')).not.toHaveBeenCalled();
  expect(onFileLink).not.toHaveBeenCalled();
});
