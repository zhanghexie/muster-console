/**
 * Custom URL schemes owned by the Muster desktop runtime.
 *
 * Keep these values in one shared module so the Electron protocol handlers,
 * web gateway, and renderer URL builders cannot drift apart.
 */
export const MUSTER_APP_SCHEME = 'muster-app' as const;
export const MUSTER_EXPORT_SCHEME = 'muster-export' as const;
export const MUSTER_ROOT_SCHEME = 'muster-root' as const;
export const MUSTER_WS_SCHEME = 'muster-ws' as const;
export const MUSTER_EXT_SCHEME = 'muster-ext' as const;

export const MUSTER_SCHEMES = [
  MUSTER_APP_SCHEME,
  MUSTER_ROOT_SCHEME,
  MUSTER_WS_SCHEME,
  MUSTER_EXT_SCHEME,
  MUSTER_EXPORT_SCHEME
] as const;
