import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogWithSettingsPaths } from '../../../src/main/capabilities/catalog/settingsPaths';
import type { CapabilityCatalogInfo } from '../../../src/shared/types';

const catalog: CapabilityCatalogInfo = { version: 'test', tools: [{ name: 'browser.run', description: '', dangerous: false, parameters: {},
  exposure: { kind: 'domain', scheduler: true, workerPresets: [], skillPath: '~/.muster/skills/browser/SKILL.md' } }] };

describe('settings catalog skill paths', () => {
  it.each([
    ['C:\\Users\\me\\.muster\\skills', 'C:\\Users\\me\\.muster\\skills\\browser\\SKILL.md', path.win32.join],
    ['/Users/me/.muster/skills', '/Users/me/.muster/skills/browser/SKILL.md', path.posix.join],
    ['/home/me/.muster/skills', '/home/me/.muster/skills/browser/SKILL.md', path.posix.join]
  ] as const)('projects the declared path under %s without changing the declaration', (root, expected, join) => {
    const projected = catalogWithSettingsPaths(catalog, '~/.muster/skills', root, join);
    expect(projected.tools[0].exposure?.skillPath).toBe('~/.muster/skills/browser/SKILL.md');
    expect(projected.tools[0].exposure?.resolvedSkillPath).toBe(expected);
    expect(catalog.tools[0].exposure?.resolvedSkillPath).toBeUndefined();
  });

  it.each(['~/.muster/skills/../secret', '~/.muster/skills/browser\\secret', '~/.muster/skills-other/browser/SKILL.md'])
    ('does not project a path outside the declared skill root: %s', declared => {
      const tool = catalog.tools[0];
      const input: CapabilityCatalogInfo = { ...catalog, tools: [{ ...tool, exposure: { ...tool.exposure!, skillPath: declared } }] };
      expect(catalogWithSettingsPaths(input, '~/.muster/skills', '/home/me/.muster/skills').tools[0].exposure?.resolvedSkillPath).toBeUndefined();
    });
});
