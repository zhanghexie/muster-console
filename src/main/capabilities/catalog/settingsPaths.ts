import path from 'node:path';
import type { CapabilityCatalogInfo } from '../../../shared/types';

/** Keep declaration paths unchanged; resolve only recognized host skill paths for the settings UI. */
export function catalogWithSettingsPaths(catalog: CapabilityCatalogInfo, declaredRoot: string, localRoot: string,
  join: (...parts: string[]) => string = path.join): CapabilityCatalogInfo {
  const prefix = `${declaredRoot.replace(/\/+$/, '')}/`;
  return { ...catalog, tools: catalog.tools.map(tool => {
    const declared = tool.exposure?.skillPath;
    if (!declared?.startsWith(prefix)) return tool;
    const parts = declared.slice(prefix.length).split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) return tool;
    return { ...tool, exposure: { ...tool.exposure!, resolvedSkillPath: join(localRoot, ...parts) } };
  }) };
}
