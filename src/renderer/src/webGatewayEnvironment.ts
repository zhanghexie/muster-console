let active = false;

/** 是否运行在浏览器网关；可由预览读取，不触发 WebSocket/手机判定初始化。 */
export function isWebGateway(): boolean { return active; }
export function markWebGatewayActive(): void { active = true; }
