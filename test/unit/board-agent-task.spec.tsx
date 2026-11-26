import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { currentApiMock } from './helpers/api-mock';

it('会话看板独立于任务表，保留重命名和归档，移除任务挂接', async () => {
  setFilterActiveWorkspace(false); setFreeViewMode('status');
  const mock=currentApiMock(), workspaces=[{id:'w',path:'E:/fixture',name:'Workspace',openedAt:1}];
  mock.override('workspaces.list',()=>Promise.resolve({workspaces,activeWorkspaceId:'w'}));
  mock.override('config.get',()=>Promise.resolve({workspaces,activeWorkspaceId:'w',locale:'zh-CN'}));
  mock.override('sessions.list',()=>Promise.resolve({sessions:[{id:'s',name:'普通会话',type:'terminal',runtime:'pi',createdAt:1,lastUsedAt:1,workspaceId:'w',lifecycle:'idle',status:'running',launchKind:'agent'}],activeId:'s'}));
  const view=render(<StoreProvider><BoardPanel/></StoreProvider>);
  const label=await screen.findByText('普通会话',{selector:'button.board-card-name.session-name-text'});
  fireEvent.contextMenu(label.closest('.board-card')!);
  await waitFor(()=>expect(document.getElementById('ctx-item-rename')).toBeTruthy());
  expect(document.getElementById('ctx-item-link-task')).toBeNull();
  expect(document.getElementById('ctx-item-unlink-task')).toBeNull();
  expect(document.getElementById('ctx-item-archive')).toBeTruthy();
  expect(view.container.querySelector('.board-card-task')).toBeNull();
});
