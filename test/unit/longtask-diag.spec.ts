/**
 * 长任务诊断环形缓冲纯逻辑（P1-3）：>1s 入环形缓冲（封顶 20、脱敏）、
 * 连续两条 >2s 或累计 >2s 走 report 落盘（落盘后计数清零）。
 * 还原即红：摘掉 recordLongtask 的入环/落盘逻辑（或 main.tsx 的 initLongtaskDiag
 * 接线源码锚被移除）时对应断言转红。
 * 运行: npx vitest run test/unit/longtask-diag.spec.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recordLongtask,
  longtaskRecordsForTest,
  resetLongtaskDiagForTest,
  setLongtaskSessionSummary,
  type LongtaskDeps
} from '../../src/renderer/src/longtaskDiag';

const noopDeps = { memory: () => null, report: () => undefined };

describe('长任务诊断环形缓冲（P1-3）', () => {
  beforeEach(() => {
    resetLongtaskDiagForTest();
  });

  it('≤1s 不入环；>1s 入环并携带脱敏会话摘要与内存快照', () => {
    setLongtaskSessionSummary('abcd1234:Demo');
    recordLongtask(100, 500, noopDeps); // ≤1s 忽略
    expect(longtaskRecordsForTest().length).toBe(0);
    recordLongtask(1000, 1500, {
      memory: () => ({ usedJSHeapSize: 123, jsHeapSizeLimit: 456 }),
      report: () => undefined
    });
    const ring = longtaskRecordsForTest();
    expect(ring.length).toBe(1);
    expect(ring[0]).toMatchObject({
      start: 1000,
      duration: 1500,
      session: 'abcd1234:Demo',
      memory: { usedJSHeapSize: 123, jsHeapSizeLimit: 456 }
    });
  });

  it('环形缓冲封顶 20 条，超限丢最旧', () => {
    for (let i = 0; i < 25; i++) {
      recordLongtask(i * 5000, 1100, noopDeps); // 每条 1.1s：只入环不触发落盘
    }
    const ring = longtaskRecordsForTest();
    expect(ring.length).toBe(20);
    expect(ring[0]!.start).toBe(5 * 5000); // 最旧 5 条被挤出
  });

  it('>2s 单条（冻结级事件）立即 report 落盘；落盘后累计清零', () => {
    const reports: Array<{ label: string; message: string }> = [];
    const deps: LongtaskDeps = { memory: () => null, report: (l, m) => reports.push({ label: l, message: m }) };
    recordLongtask(0, 2100, deps);
    expect(reports.length).toBe(1);
    expect(reports[0]!.label).toBe('longtask.freeze');
    expect(reports[0]!.message).toContain('2100ms');
    // 落盘后累计清零：再一条 >1s 不立即触发
    recordLongtask(5000, 1100, deps);
    expect(reports.length).toBe(1);
  });

  it('累计 >2s 走 report 落盘（两条 >1s 相加越限）', () => {
    const reports: Array<{ label: string; message: string }> = [];
    const deps: LongtaskDeps = { memory: () => null, report: (l, m) => reports.push({ label: l, message: m }) };
    recordLongtask(0, 800, noopDeps); // ≤1s 不计累计
    recordLongtask(1000, 1050, deps);
    expect(reports.length).toBe(0); // 1.05s 未越限
    recordLongtask(2000, 1050, deps); // 累计 2.1s > 2s
    expect(reports.length).toBe(1);
    expect(reports[0]!.message).toContain('累计未落盘 2100ms');
  });

  it('接线锚：main.tsx boot 链调用 initLongtaskDiag（回滚摘除即红）', () => {
    const mainSrc = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer/src/main.tsx'),
      'utf8'
    );
    expect(mainSrc.includes('initLongtaskDiag()')).toBe(true);
    expect(mainSrc.includes("from './longtaskDiag'")).toBe(true);
  });
});
