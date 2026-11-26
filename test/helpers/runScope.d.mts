export declare const AGENT_ENV_MARKERS: string[];
export declare function detectAgent(env: NodeJS.ProcessEnv): string | null;
export declare function fullForced(argv: string[], env: NodeJS.ProcessEnv): boolean;
export declare function resolveRunScope(
  argv: string[],
  env: NodeJS.ProcessEnv,
  opts: { hasFilters: boolean }
): { scope: 'full' | 'changed' | 'changed-files' | 'filter'; downgradedBy?: string };
export declare function vitestWholeSuiteByAgent(argv: string[], env: NodeJS.ProcessEnv): string | null;
export declare function downgradeNotice(agent: string, what: string): string;
