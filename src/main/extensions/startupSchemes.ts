import { app, protocol, type CustomScheme } from 'electron';
import { t } from '../../shared/i18n';
/** Electron accepts one registration call. Startup modules share a synchronous collection. */
export function collectStartupSchemes(load: () => void): void {
  if (app.isReady()) throw new Error(t('协议声明必须在 ready 前汇总'));
  const original = protocol.registerSchemesAsPrivileged, collected = new Map<string, CustomScheme>();
  protocol.registerSchemesAsPrivileged = schemes => {
    const next = structuredClone(schemes);
    if (!Array.isArray(next)) throw new Error(t('协议声明必须为数组'));
    const names = new Set(collected.keys());
    for (const item of next) {
      if (!item || typeof item.scheme !== 'string' || !/^[a-z][a-z0-9+.-]{0,63}$/.test(item.scheme) || names.has(item.scheme)) throw new Error(t('协议名称不合法或与宿主/其他扩展重复'));
      if (item.privileges && Object.values(item.privileges).some(value => typeof value !== 'boolean')) throw new Error(t('协议特权必须为布尔值'));
      names.add(item.scheme);
    }
    for (const item of next) collected.set(item.scheme, item);
  };
  try { load(); }
  finally { protocol.registerSchemesAsPrivileged = original; original.call(protocol, [...collected.values()]); }
}
