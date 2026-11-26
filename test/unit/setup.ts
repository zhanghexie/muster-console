/**
 * 组件单测全局装配：
 * 1. 挂 renderer 的 i18n 实例（react-i18next 需要 initReactI18next 已接线；
 *    模块加载只读 localStorage，不触 window.api）；
 * 2. 每个用例前重装 window.api Proxy mock（隔离调用记录与事件监听）；
 * 3. RTL cleanup。
 */
import { beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { dismissTip } from '../../src/renderer/src/tips';
import { TransformStream } from 'node:stream/web';
import '../../src/renderer/src/i18n';
import { installApiMock } from './helpers/api-mock';
import { resetGlobalPanelGlowForTest } from '../../src/renderer/src/panelGlow';
import { resetNeedsReadForTest } from '../../src/renderer/src/panels/needsReadStore';

// jsdom 不实现这三个浏览器/流 API，而产品 hook 与 MCP SDK 依赖它们。
// 只在缺失时补 no-op/minimal 实现：真实浏览器与已自行 mock 的用例不受影响。
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true, writable: true,
    value: class { observe(): void {} unobserve(): void {} disconnect(): void {} }
  });
}
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  // writable: 允许个别用例在元素实例上再覆盖自己的 spy（否则赋值会抛 read only）。
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: () => {} });
}
if (typeof (globalThis as { TransformStream?: unknown }).TransformStream === 'undefined') {
  Object.defineProperty(globalThis, 'TransformStream', { configurable: true, writable: true, value: TransformStream });
}

beforeEach(() => {
  installApiMock();
  resetGlobalPanelGlowForTest(true);
  resetNeedsReadForTest();
});

afterEach(() => {
  cleanup();
  dismissTip();
});
