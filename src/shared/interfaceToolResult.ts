/**
 * Result reductions for the interface-oriented host tools. This runs only at
 * the model boundary, after host consumers have observed the original result.
 * Unknown names, actions and shapes intentionally pass through unchanged.
 */
import { RESULT_MAX_CHARS } from './toolResultBudget';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function actionIs(name: string, args: Readonly<Record<string, unknown>>, domain: string, action: string): boolean {
  return name === `host.${domain}.run` && args.action === action;
}

/** Keep a saved artifact deliverable when escaped smoke diagnostics exceed the model budget. */
function uiRenderReceipt(value: Record<string, unknown>): unknown {
  const knownDiagnostics = (items: unknown): boolean => items === undefined ||
    (Array.isArray(items) && items.every(item => object(item) && typeof item.code === 'string' && typeof item.message === 'string'));
  if (typeof value.link !== 'string' || !value.link || typeof value.markdown !== 'string' ||
      typeof value.usage !== 'string' || typeof value.version !== 'number' || !object(value.receipt) ||
      !['generated', 'mounted', 'rendered', 'degraded', 'failed'].includes(String(value.receipt.status)) ||
      typeof value.receipt.visible !== 'boolean' || typeof value.receipt.updatedAt !== 'number' ||
      !knownDiagnostics(value.diagnostics) || !knownDiagnostics(value.receipt.diagnostics) ||
      (value.warnings !== undefined && (!Array.isArray(value.warnings) || !value.warnings.every(item => typeof item === 'string'))) ||
      (value.presentation !== undefined && (!object(value.presentation) || typeof value.presentation.opened !== 'boolean' || typeof value.presentation.url !== 'string')))
    return value;
  const envelopeLength = (result: unknown) => JSON.stringify({ ok: true, result }).length;
  try {
    const originalLength = envelopeLength(value);
    if (originalLength <= RESULT_MAX_CHARS) return value;
    const candidate = (limit: number): Record<string, unknown> => {
      const fields: string[] = [];
      const text = (input: unknown, pointer: string): unknown => {
        if (typeof input !== 'string' || input.length <= limit) return input;
        fields.push(pointer);
        let prefix = input.slice(0, limit);
        if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
        return `${prefix}…`;
      };
      const detail = (input: Record<string, unknown>, pointer: string) => {
        const result = { ...input };
        for (const key of ['message', 'expression', 'hint']) {
          if (typeof input[key] === 'string') result[key] = text(input[key], `${pointer}/${key}`);
        }
        return result;
      };
      const result = { ...value };
      if (Array.isArray(value.warnings)) result.warnings = value.warnings.map((warning, index) => text(warning, `/warnings/${index}`));
      if (Array.isArray(value.diagnostics)) result.diagnostics = value.diagnostics.map((item, index) => detail(item, `/diagnostics/${index}`));
      const receipt = { ...(value.receipt as Record<string, unknown>) };
      if (typeof receipt.error === 'string') receipt.error = text(receipt.error, '/receipt/error');
      if (Array.isArray(receipt.diagnostics)) receipt.diagnostics = receipt.diagnostics.map((item, index) => detail(item, `/receipt/diagnostics/${index}`));
      result.receipt = receipt;
      if (object(value.presentation)) result.presentation = { ...value.presentation,
        ...(typeof value.presentation.error === 'string' ? { error: text(value.presentation.error, '/presentation/error') } : {}) };
      // Only shorten the known Markdown label; never alter its artifact target.
      const suffix = `](<${(value.link as string).replace(/\\/g, '/')}>)`;
      const markdown = value.markdown as string;
      if (markdown.startsWith('[') && markdown.endsWith(suffix)) {
        result.markdown = `[${text(markdown.slice(1, -suffix.length), '/markdown')}${suffix}`;
      }
      if (fields.length) result.modelReceiptTruncated = { reason: 'tool-result-budget', fields };
      return result;
    };
    let fitted = candidate(0);
    // An unknown oversized field or an oversized locator is not disposable text.
    if (envelopeLength(fitted) > RESULT_MAX_CHARS) return value;
    let low = 0, high = originalLength;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2), next = candidate(mid);
      if (envelopeLength(next) <= RESULT_MAX_CHARS) { low = mid; fitted = next; }
      else high = mid - 1;
    }
    return fitted;
  } catch { return value; }
}

export function projectInterfaceToolResult(
  publicName: string,
  args: Readonly<Record<string, unknown>>,
  value: unknown
): unknown {
  if (!object(value) || value.ok === false || 'error' in value) return value;

  if (publicName === 'host.ui.render') return uiRenderReceipt(value);

  if (actionIs(publicName, args, 'browser', 'tabs') && Array.isArray(value.tabs) &&
      value.tabs.every(tab => object(tab) && typeof tab.id === 'string' && typeof tab.url === 'string' &&
        typeof tab.title === 'string' && (tab.favicon === null || typeof tab.favicon === 'string'))) {
    // Tab discovery needs identities, URLs, ownership and navigation state. The
    // renderer's image resource is neither a target nor page-observation evidence.
    return { ...value, tabs: value.tabs.map(tab => {
      const { favicon: _favicon, ...rest } = tab as Record<string, unknown>;
      return rest;
    }) };
  }

  if (publicName === 'host.themes.run' && (args.action === 'create' || args.action === 'update') &&
      typeof value.id === 'string' && typeof value.name === 'string' &&
      (value.appearance === 'dark' || value.appearance === 'light') &&
      object(value.colors) && object(value.terminal)) {
    // A successful save returns identity and resolved appearance. Explicit get
    // remains the palette read, including normalization and inherited defaults.
    const { colors: _colors, terminal: _terminal, ...receipt } = value;
    return receipt;
  }

  if (publicName === 'host.apps.run' && (args.action === 'install' || args.action === 'installFromLibrary') &&
      value.sdkVersion === 1 && typeof value.id === 'string' && typeof value.name === 'string' &&
      typeof value.version === 'number' && Array.isArray(value.collections) &&
      Array.isArray(value.commands) && Array.isArray(value.views)) {
    if (args.action === 'installFromLibrary') {
      // The caller supplied a catalog ID, not the definition. Keep the command
      // and field contracts needed to use it: describe also includes the full
      // HTML and installation metadata, so it may exceed the model budget.
      if (!value.views.every(view => object(view) && typeof view.id === 'string' &&
          (view.html === undefined || typeof view.html === 'string'))) return value;
      const { icon: _icon, description: _description, notificationHint: _hint, ...definition } = value;
      return { ...definition, views: value.views.map(view => {
        const { html: _html, ...metadata } = view as Record<string, unknown>;
        return metadata;
      }) };
    }
    // Direct installation already supplied the command/schema/content. Return
    // the accepted identity and capabilities without repeating that package.
    const { collections: _collections, commands: _commands, views: _views,
      icon: _icon, description: _description, notificationHint: _hint, ...receipt } = value;
    return receipt;
  }

  if (actionIs(publicName, args, 'themes', 'list') &&
      typeof value.activeId === 'string' && Array.isArray(value.themes) &&
      object(value.active) && value.active.id === value.activeId &&
      typeof value.active.name === 'string' &&
      (value.active.appearance === 'dark' || value.active.appearance === 'light') &&
      object(value.active.colors) && object(value.active.terminal)) {
    // The matching full palette is available through themes.get(activeId).
    // IPC / themes:changed still receive the unprojected active theme.
    const { active: _active, ...rest } = value;
    return rest;
  }

  if (actionIs(publicName, args, 'browser', 'screenshot') && value.ok === true &&
      typeof value.path === 'string' && value.path.length > 0 && value.previewPath === value.path) {
    // display.imagePath and GUI evidence consume the original before this
    // projection. Keep path for models and every warning/dialog field intact.
    const { previewPath: _previewPath, ...rest } = value;
    // withAct can replace this note with a file-chooser or dialog warning.
    // Only shorten the two exact built-in translations; preserve other notes.
    const chinese = `截图已保存至 ${value.path}（界面可见；支持读图的模型可直接读取 path 查看画面）`;
    const english = `Screenshot saved to ${value.path} (visible in the UI; vision-capable models can read path directly)`;
    if (rest.note === chinese) rest.note = '界面可见；支持读图的模型可直接读取 path 查看画面';
    else if (rest.note === english) rest.note = 'Visible in the UI; vision-capable models can read path directly';
    return rest;
  }

  return value;
}
