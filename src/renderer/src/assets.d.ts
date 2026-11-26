declare module '*.webp' {
  const url: string;
  export default url;
}
declare module '*.png' { const url: string; export default url; }
declare module '*.svg' { const url: string; export default url; }
declare module '*?raw' { const source: string; export default source; }

interface ImportMeta {
  glob<T = unknown>(pattern: string | string[], options?: { eager?: boolean; import?: string; query?: string }): Record<string, T>;
}
