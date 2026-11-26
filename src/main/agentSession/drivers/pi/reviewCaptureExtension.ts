import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { nativeWritePaths } from '../../../turnChanges/pathCapture';

export interface PiReviewCapture {
  start(event: { toolCallId: string; toolName: string; input: Record<string, unknown> }): Promise<void>;
  end(event: { toolCallId: string; ok: boolean }): Promise<void>;
}

/** Pi awaits each callback; observation-only adapters must not use this contract. */
export function createPiReviewCaptureExtension(capture: PiReviewCapture, log: (message: string) => void) {
  return (api: ExtensionAPI) => {
    const captured = new Set<string>();
    api.on('tool_call', async event => {
      if (!nativeWritePaths(event.toolName, event.input).length) return;
      try {
        await capture.start({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
        captured.add(event.toolCallId);
      } catch (error) { log(`文件审阅写前采集失败：${(error as Error).message}`); }
    });
    api.on('tool_result', async event => {
      if (!captured.delete(event.toolCallId)) return;
      try { await capture.end({ toolCallId: event.toolCallId, ok: !event.isError }); }
      catch (error) { log(`文件审阅写后采集失败：${(error as Error).message}`); }
    });
  };
}
