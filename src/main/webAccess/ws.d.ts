/**
 * ws 的最小类型声明：web 网关（WebSocketServer + WebSocket 收发/关闭）与内置浏览器
 * CDP 类型代理（noServer + handleUpgrade 逐连接隧道）用到什么声明什么。
 * 不引 @types/ws（避免为一个依赖扩安装面）。
 */
declare module 'ws' {
  import type { Duplex } from 'node:stream';
  import type { EventEmitter } from 'node:events';
  import type { IncomingMessage, Server as HttpServer } from 'node:http';

  export class WebSocket extends EventEmitter {
    /** 客户端形态：连远端地址（CDP 代理的上游隧道） */
    constructor(address: string);
    readyState: number;
    send(data: string | Buffer, options?: { binary?: boolean }): void;
    close(code?: number, reason?: string): void;
    /** 协议层心跳探活（配合 pong / isAlive 扫僵尸） */
    ping(data?: unknown): void;
    /** 强杀半开/僵尸连接 */
    terminate(): void;
    on(event: 'open', listener: () => void): this;
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this;
    on(event: 'pong', listener: () => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }

  export class WebSocketServer {
    constructor(options: { server?: HttpServer; noServer?: boolean; path?: string; maxPayload?: number });
    on(event: 'connection', listener: (ws: WebSocket, req: IncomingMessage) => void): this;
    /** ws 会把底层 http server 的 error 中继到这里；不挂监听会把 listen 错误变成 uncaughtException */
    on(event: 'error', listener: (err: Error) => void): this;
    /** 手动完成 upgrade（noServer 模式：http server 的 upgrade 事件转发进来） */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WebSocket) => void): void;
    /** 当前连接集合（close 时逐个 terminate） */
    clients: Set<WebSocket>;
    close(callback?: (error?: Error) => void): void;
  }
}
