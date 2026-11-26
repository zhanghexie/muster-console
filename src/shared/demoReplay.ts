export interface DemoVisualEvent { type: number; timestamp: number; data: unknown }
export type DemoChrome = import('./resolvedAppearance').ResolvedAppearance['nativeChrome'];
export interface DemoRecordingBridge {
  start(): { id?: string; error?: string };
  append(id: string, events: DemoVisualEvent[]): { ok?: boolean; error?: string };
  surface(id: string, rect: { x: number; y: number; width: number; height: number }): Promise<string>;
}
export interface DemoReplayBatch {
  events: DemoVisualEvent[];
  done: boolean;
  speed: number;
  from: number;
  width: number;
  height: number;
}
