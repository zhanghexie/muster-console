/** themes 组（catalog 拆分：数据自原 catalog.ts 原样搬移，勿在此改动行为） */
import type { ToolDef } from './types';

export const THEMES_TOOL_DEFS: ToolDef[] = [
  // ---------- themes（色彩主题增删改查；UI 与 Agent 同一底座，改动即时刷新界面） ----------
  {
    name: 'themes.list',
    description:
      'List color themes: built-in dark (default dark)/light and user custom themes (JSON files). Returns the global default theme id (globalThemeId), this workspace\'s own theme id (workspaceThemeId, default = follow global), and the actually active theme id (activeId, workspace override beats global)',
    dangerous: false,
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'themes.get',
    description:
      'Read one theme\'s full palette: all color values of colors (UI color tokens) and terminal (xterm 22 colors). Take a copy as the baseline before editing a theme',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Theme id; run themes.list first' }
      },
      required: ['id']
    }
  },
  {
    name: 'themes.create',
    description:
      'Create a custom theme: copies the default dark one (all colors included) and returns the new theme (id derived from the name). Then change colors with themes.update',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Theme display name (e.g. Night Blue)' }
      },
      required: ['name']
    }
  },
  {
    name: 'themes.update',
    summary: 'Patch a custom theme\'s colors (partial colors/terminal keys); built-in themes are immutable',
    description:
      'Edit a custom theme (built-ins are immutable — copy with themes.create first): change name, appearance (dark/light, affects native control look), or pass partial colors/terminal keys to merge in. Color values accept #rrggbb / rgb() / rgba(); unknown keys or invalid colors error. If it is the active theme, the UI refreshes immediately on save. Common keys: in colors, bg-canvas canvas base / bg-panel panel base / bg-raised cards / ink primary text / green|red|yellow|blue|purple status colors; in terminal, background/foreground terminal base and foreground',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Theme id' },
        name: { type: 'string', description: 'Optional; new display name' },
        appearance: { type: 'string', description: "Optional; 'dark' | 'light'" },
        colors: {
          type: 'object',
          description:
            'Optional; UI color deltas (key = token name, value = color string), e.g. {"bg-canvas": "#0b1220"}'
        },
        terminal: {
          type: 'object',
          description: 'Optional; terminal color deltas (xterm key names), e.g. {"background": "#0b1220"}'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'themes.activate',
    description:
      "Switch themes; the UI reskins instantly. scope='global' (default): change the global default theme that every workspace without its own theme follows; scope='workspace': set this workspace's own theme only (effective when you switch to it; pass workspaceId for another open workspace), and followGlobal=true clears the workspace theme and returns to following global (no id needed then). When a workspace has its own theme, changing the global default does not change the current UI",
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: "Theme id; may be omitted when followGlobal=true"
        },
        scope: {
          type: 'string',
          description: "Optional; 'global' (default, global default) | 'workspace' (the given workspace only)"
        },
        workspaceId: {
          type: 'string',
          description: "Optional; the workspace when scope=workspace (default: the active workspace)"
        },
        followGlobal: {
          type: 'boolean',
          description: 'Optional; true with scope=workspace clears the workspace theme and returns to following global'
        }
      }
    }
  },
  {
    name: 'themes.remove',
    summary: 'Delete a custom theme and cascade-clean references (confirm dialog)',
    description:
      'Delete a custom theme (removes its JSON file) and cascade-clean references: the global default falls back to built-in dark if it pointed here, and workspace theme overrides referencing it are cleared (those workspaces return to following global). Built-ins cannot be deleted; user confirmation is required before deletion',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Theme id' }
      },
      required: ['id']
    }
  },

];
