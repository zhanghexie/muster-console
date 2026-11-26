import { isWebGateway } from './webGatewayEnvironment';

/** Connection state only; importing it must not initialize the browser transport. */
export interface WebGatewayStatus { connected: boolean; note: string; error?: string }
let status: WebGatewayStatus = { connected: false, note: '' };
const listeners = new Set<() => void>();
const desktop: WebGatewayStatus = Object.freeze({ connected: true, note: '' });
export function setGatewayStatus(connected: boolean, note: string, error?: string): void {
  if (status.connected === connected && status.note === note && status.error === error) return;
  status = { connected, note, error };
  for (const listener of listeners) listener();
}
export function subscribeWebGatewayStatus(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function getWebGatewayStatus(): WebGatewayStatus { return isWebGateway() ? status : desktop; }
