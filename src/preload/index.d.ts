import type { WorkbenchApi } from './index';

declare global {
  interface Window {
    api: WorkbenchApi;
    replaySession: import('../shared/sessionReplay').ReplaySession;
    demoRecording?: import('../shared/demoReplay').DemoRecordingBridge;
    demoReplay?: { next(): Promise<import('../shared/demoReplay').DemoReplayBatch>; appearance(value: import('../shared/demoReplay').DemoChrome): void };
  }
}

export {};
