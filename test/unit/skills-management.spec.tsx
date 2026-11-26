import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CapabilityManagementPane } from '../../src/renderer/src/components/settings/CapabilityManagementPane';
import type { AppConfig } from '../../src/shared/types';
import type { CapabilityScope, ManagedSkill, SkillManagementSnapshot } from '../../src/shared/capabilityManagement';
import type { ManagedMcpEntry, McpManagementInventory } from '../../src/shared/mcpManagement';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { currentApiMock } from './helpers/api-mock';

const projectScope: CapabilityScope = { kind: 'project', projectPath: 'E:/workbench' };
const cfg = { workspaces: [{ id: 'w1', name: 'Workbench', path: 'E:/workbench', openedAt: 1 }], activeWorkspaceId: 'w1', mcp: { enabled: true, servers: [] }, locale: 'zh-CN' } as unknown as AppConfig;
const makeSkill = (id: string, name: string, scope: CapabilityScope, inherited = false): ManagedSkill => ({
  id, name, description: `${name} description`, directoryPath: `${scope.kind === 'global' ? 'C:/Users/test/.agents/skills' : scope.projectPath + '/.agents/skills'}/${name}`,
  filePath: `${scope.kind === 'global' ? 'C:/Users/test/.agents/skills' : scope.projectPath + '/.agents/skills'}/${name}/SKILL.md`,
  hash: id, status: 'valid', scope, inherited, preferred: false, files: ['SKILL.md'],
  sources: [{ path: `${scope.kind === 'global' ? 'C:/Users/test/.agents/skills' : scope.projectPath + '/.agents/skills'}/${name}`, directoryId: `root-${scope.kind}`, scope, label: '.agents/skills', managed: true }]
});
const snapshot = (): SkillManagementSnapshot => ({
  scope: projectScope, revision: 1,
  skills: [makeSkill('project-skill', 'project-skill', projectScope), makeSkill('global-skill', 'global-skill', { kind: 'global' }, true)],
  directories: [
    { id: 'global-root', path: 'C:/Users/test/.agents/skills', label: '通用技能目录', scope: { kind: 'global' }, custom: false, exists: true },
    { id: 'project-root', path: 'E:/workbench/.agents/skills', label: '通用技能目录', scope: projectScope, custom: false, exists: true }
  ], conflicts: [], errors: []
});

describe('universal skill roots settings', () => {
  beforeEach(() => {
    applyLocaleSetting('zh-CN');
    const api = currentApiMock();
    api.override('inboundMcp.status', () => ({ ok: true, engines: [] }));
    api.override('capabilityManagement.skillsList', () => snapshot());
    api.override('capabilityManagement.mcpList', () => ({ enabled: true, servers: [] }));
    api.override('capabilityManagement.refresh', () => snapshot());
    api.override('capabilityManagement.createSkill', () => snapshot());
    api.override('capabilityManagement.usageList', () => ({ revision: 0, resources: [], runtimes: [], categories: { skill: { enabled: true, globalEnabled: true, harnessEnabled: true, workspaceEnabled: true }, mcp: { enabled: true, globalEnabled: true, harnessEnabled: true, workspaceEnabled: true } } }));
  });
  it('renders only the two universal roots and removes association/directory controls', async () => {
    render(<CapabilityManagementPane cfg={cfg}/>);
    await screen.findByRole('button', { name: /^查看 project-skill / });
    expect(currentApiMock().mockOf('capabilityManagement.skillsList')).toHaveBeenCalledWith(projectScope);
    expect(screen.queryByRole('button', { name: /^查看 global-skill / })).toBeNull();
    fireEvent.click(screen.getByText('来自全局'));
    await screen.findByRole('button', { name: /^查看 global-skill / });
    expect(screen.queryByRole('button', { name: '按入口筛选' })).toBeNull();
    expect(screen.queryByRole('button', { name: '发现目录' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^查看 project-skill / }));
    const detail = screen.getByRole('complementary', { name: '能力详情' });
    expect(within(detail).getByText('通用目录来源')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: '保存关联' })).toBeNull();
    expect(within(detail).queryByRole('checkbox')).toBeNull();
  });

  it('collapses inherited MCP entries and prioritizes project overrides', async () => {
    const project: ManagedMcpEntry = { id: 'project-mcp', scope: 'project', workspaceId: 'w1', revision: 'p1', server: { name: 'project-mcp', enabled: true, transport: 'stdio', command: 'node' } };
    const overridden: ManagedMcpEntry = { id: 'global-overridden', scope: 'global', revision: 'g1', overridden: true, server: { name: 'global-overridden', enabled: true, transport: 'stdio', command: 'node' } };
    const inherited: ManagedMcpEntry = { id: 'global-inherited', scope: 'global', revision: 'g2', server: { name: 'global-inherited', enabled: true, transport: 'stdio', command: 'node' } };
    const inventory: McpManagementInventory = { enabled: true, workspaceId: 'w1', servers: [inherited, overridden, project] };
    currentApiMock().override('capabilityManagement.mcpList', () => inventory);
    render(<CapabilityManagementPane cfg={cfg}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'MCP' }));
    await screen.findByRole('button', { name: '查看 project-mcp' });
    expect(screen.queryByRole('button', { name: '查看 global-inherited' })).toBeNull();
    expect(screen.getByText('来自全局')).toBeTruthy();
    fireEvent.click(screen.getByText('来自全局'));
    const globalRows = await screen.findAllByRole('button', { name: /查看 global-/ });
    expect(globalRows[0].getAttribute('aria-label')).toBe('查看 global-overridden');
    expect(within(globalRows[0]).getByText('项目已覆盖')).toBeTruthy();
  });

  it('explains the selected universal root when creating a project skill', async () => {
    render(<CapabilityManagementPane cfg={cfg}/>);
    await screen.findByRole('button', { name: /^查看 project-skill / });
    fireEvent.click(screen.getByRole('button', { name: '新建技能' }));
    const dialog = await screen.findByRole('dialog', { name: '新建技能' });
    expect(within(dialog).getByText('新技能保存在当前项目的 .agents/skills。')).toBeTruthy();
    expect(within(dialog).queryByText(/建立链接/)).toBeNull();
  });
});
