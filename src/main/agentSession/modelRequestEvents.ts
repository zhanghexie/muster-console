import type { AppContext } from '../context';

export function publishModelRequestRecording(ctx: AppContext, sessionId: string, enabled: boolean): void {
  const payload = { sessionId, enabled };
  try { ctx.getWindow()?.webContents.send('modelRequests:recordingChanged', payload); }
  catch (error) { console.warn('[model-requests] main window notification failed:', error); }
  try { ctx.sendToAuxiliaryRenderers?.('modelRequests:recordingChanged', payload); }
  catch (error) { console.warn('[model-requests] auxiliary window notification failed:', error); }
}
