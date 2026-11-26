/**
 * markdown 解析链预热（P2-3②）：boot 后空闲跑一遍真实渲染链，把
 * react-markdown/remark-gfm/micromark 的首次初始化与 JIT 移出首帧。
 * 行为合同：渲染进游离节点——不进文档（body 零变化）、不拉 IPC（window.api
 * 零访问）、300ms 卸载定时器触发后不残留；main.tsx boot 链必须保留预热调用。
 * 还原即红：删掉 main.tsx 的 warmMarkdownParser() 接线 → 接线锚转红；
 * 改成直接挂进文档/拉 IPC → 对应断言转红。
 * 运行: npx vitest run test/unit/markdown-warmup.spec.tsx
 */
import { describe, it, expect, vi } from 'vitest';
import { act } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { warmMarkdownParser } from '../../src/renderer/src/components/MarkdownBody';

describe('markdown 解析链预热（P2-3②）', () => {
  it('游离节点渲染：不进文档（body 零变化）、不拉 IPC、300ms 后卸载无残留', () => {
    vi.useFakeTimers();
    try {
      const bodyBefore = document.body.innerHTML;
      const apiCalls: string[] = [];
      const realApi = (window as unknown as { api: unknown }).api;
      // 包一层记录代理：预热期间对 window.api 的任何顶层访问都记账
      (window as unknown as { api: unknown }).api = new Proxy(realApi as object, {
        get(target, prop, receiver) {
          apiCalls.push(String(prop));
          return Reflect.get(target, prop, receiver);
        }
      });
      try {
        expect(() =>
          act(() => {
            warmMarkdownParser();
          })
        ).not.toThrow();
      } finally {
        (window as unknown as { api: unknown }).api = realApi;
      }
      // 不进文档：游离渲染，body 与 .md-body 查询都无变化
      expect(document.body.innerHTML).toBe(bodyBefore);
      expect(document.querySelector('.md-body')).toBeNull();
      // 不拉 IPC：预热期间 window.api 零访问
      expect(apiCalls).toEqual([]);
      // 卸载定时器已排（300ms）；触发后无残留定时器（游离根已卸载）
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('接线锚：main.tsx boot 完成后空闲调用 warmMarkdownParser（回滚摘除即红）', () => {
    const mainSrc = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer/src/main.tsx'),
      'utf8'
    );
    expect(mainSrc.includes('warmMarkdownParser()')).toBe(true);
    expect(mainSrc.includes("from './components/MarkdownBody'")).toBe(true);
  });
});
