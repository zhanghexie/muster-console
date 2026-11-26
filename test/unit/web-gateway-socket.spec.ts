/**
 * 回归：GatewaySocket 陈旧 socket 竞态（2026-09-23 评审 P1，webApiShim）。
 * 旧行为：wake() 在 CONNECTING 期间也 new WebSocket（被弃 socket 的 handler 仍挂在
 * 共享 this 上），其迟到 onclose 无条件 failPending + scheduleReconnect、迟到 onopen
 * 无守卫抢状态——产生双活连接与事件重复分发（手机锁屏回前台的 wake×CONNECTING 高频窗口）。
 * 还原即红：去掉 wake 的 CONNECTING 判断、onclose/onopen 的陈旧守卫，对应用例即挂。
 */
import { describe, expect, it, vi } from 'vitest';
import { defaultWebCaps } from '../../src/shared/wsProtocol';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalled = false;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closeCalled = true;
    this.readyState = FakeWebSocket.CLOSED;
  }
}

vi.stubGlobal('WebSocket', FakeWebSocket);
// 预占 window.api：webApiShim 模块顶层的 installWebApiShimIfBrowser 由 'api' in window
// 守卫提前返回（jsdom 无 matchMedia，真装 shim 会炸）；本 spec 只直接构造 GatewaySocket
(window as unknown as Record<string, unknown>).api = {};
const { GatewaySocket } = await import('../../src/renderer/src/webApiShim');

const caps = defaultWebCaps({ mobile: false });

function lastSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

describe('GatewaySocket 陈旧 socket 守卫', () => {
  it('wake 在 CONNECTING 在途时不得再建连接（否则双活）', () => {
    FakeWebSocket.instances = [];
    new GatewaySocket('tok', '', caps);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(lastSocket().readyState).toBe(FakeWebSocket.CONNECTING);
    // online 唤醒：已有连接在途 → no-op
    window.dispatchEvent(new Event('online'));
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it('被替换 socket 的迟到 onclose 不得扰动现役连接的 pending 与重连状态', async () => {
    FakeWebSocket.instances = [];
    const sock = new GatewaySocket('tok', '', caps);
    const ws1 = FakeWebSocket.instances[0];
    ws1.onclose?.({ code: 1006 }); // ws1 握手失败 → 清 ws，排重连
    window.dispatchEvent(new Event('online')); // wake：ws 为空 → 立即重连出 ws2
    expect(FakeWebSocket.instances.length).toBe(2);
    // ws2 尚未 open，invoke 帧入 outbox、pending 挂起
    const p = sock.invoke('agent:send', [{ text: 'x' }]);
    let settled = false;
    p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    // ws1 的迟到 onclose（同一 socket 二次派发，模拟被替换后的事件）→ 守卫应直接返回
    ws1.onclose?.({ code: 1006 });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // 还原即红：无守卫时 failPending 会立刻 reject
    // 信息性断言：无新增 socket（scheduleReconnect 只排 ~1s 的 timer，20ms 窗口内
    // 不会触发建连；「不得再排重连」的红由上一行 settled 断言承担）
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it('被替换 socket 的迟到 onopen 被关掉、不发 hello，现役连接正常握手', () => {
    FakeWebSocket.instances = [];
    new GatewaySocket('tok', '', caps);
    const ws1 = FakeWebSocket.instances[0];
    ws1.onclose?.({ code: 1006 });
    window.dispatchEvent(new Event('online'));
    const ws2 = lastSocket();
    ws1.onopen?.(); // 陈旧 socket 迟到 open（服务端延迟接受）
    expect(ws1.closeCalled).toBe(true); // 还原即红：无守卫时迟到 open 会抢状态机
    expect(ws1.sent).toHaveLength(0); // hello 不得发在死连接上
    ws2.onopen?.();
    expect(ws2.closeCalled).toBe(false);
    expect(ws2.sent).toHaveLength(1); // 现役连接正常发 hello
    expect(String(ws2.sent[0])).toContain('hello');
  });
});
