export const EXTENSION_CENTER_CATEGORIES = ['creative', 'reading', 'productivity', 'games'] as const;
export type ExtensionCenterCategory = typeof EXTENSION_CENTER_CATEGORIES[number];

export interface ExtensionCenterListing {
  source: 'github' | 'remote' | 'file' | 'bundled';
  releases: ExtensionCenterRelease[];
}

export interface ExtensionCenterRelease {
  packageKey: string;
  publisherId: string;
  extensionId: string;
  name: string;
  description?: string;
  category?: ExtensionCenterCategory;
  version: string;
  fingerprint: string;
  previousFingerprints?: string[];
  sourceKind: 'center';
  installed: boolean;
  installedVersion?: string;
  packageUrl?: string;
  sha256?: string;
  minHostVersion?: string;
  publisherName?: string;
  publisherUrl?: string;
  repositoryUrl?: string;
  homepageUrl?: string;
  license?: string;
  releaseNotes?: string;
  readme?: string;
  updatedAt?: string;
  screenshots?: string[];
}

export interface ExtensionCenterCatalog {
  schemaVersion: 1;
  releases: ExtensionCenterCatalogRelease[];
}

export interface ExtensionCenterCatalogRelease {
  packageKey: string;
  publisherId: string;
  extensionId: string;
  name: string;
  description?: string;
  category?: ExtensionCenterCategory;
  version: string;
  fingerprint: string;
  /** Exact official package contents authorized as update baselines. */
  previousFingerprints?: string[];
  packageUrl: string;
  sha256: string;
  minHostVersion?: string;
  publisherName?: string;
  publisherUrl?: string;
  repositoryUrl?: string;
  homepageUrl?: string;
  license?: string;
  releaseNotes?: string;
  readme?: string;
  updatedAt?: string;
  screenshots?: string[];
}

export interface ExtensionCenterPackageArtifact {
  schemaVersion: 1;
  extensionId: string;
  fingerprint: string;
  directories: string[];
  files: Array<{ path: string; bytesBase64: string; executable?: boolean }>;
}

export interface ExtensionCenterInstallResult {
  packageKey: string;
  extensionId: string;
  installed: boolean;
  skipped: boolean;
  updated?: boolean;
  error?: string;
}

export interface ExtensionCenterUninstallResult {
  packageKey: string;
  extensionId: string;
  uninstalled: boolean;
  skipped: boolean;
  error?: string;
}
