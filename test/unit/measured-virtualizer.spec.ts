import { describe, expect, it } from 'vitest';
import {
  computeAnchorCompensation,
  computeVirtualWindow,
  evictVirtualPages
} from '../../src/renderer/src/chatSurface/measuredVirtualizer';

describe('measured virtualizer range math', () => {
  it('returns an empty range for an empty projection', () => {
    expect(computeVirtualWindow({ total: 0, viewportHeight: 600 })).toMatchObject({
      total: 0,
      contentHeight: 0,
      scrollOffset: 0,
      visible: { start: 0, end: 0, before: 0, after: 0 },
      window: { start: 0, end: 0, before: 0, after: 0 },
      anchor: null
    });
  });

  it('tracks the tail when no position is supplied', () => {
    const result = computeVirtualWindow({
      total: 100,
      viewportHeight: 200,
      estimatedRowHeight: 20,
      overscan: 2
    });

    expect(result.tail).toBe(true);
    expect(result.scrollOffset).toBe(1800);
    expect(result.visible).toMatchObject({ start: 90, end: 100 });
    expect(result.window).toMatchObject({ start: 88, end: 100, before: 88, after: 0 });
  });

  it('uses measured heights when converting an anchor into a scroll offset', () => {
    const result = computeVirtualWindow({
      total: 5,
      viewportHeight: 50,
      estimatedRowHeight: 20,
      measuredHeights: { '0': 40, '1': 10 },
      anchor: { index: 2, offset: 5 }
    });

    expect(result.scrollOffset).toBe(45);
    expect(result.anchor).toMatchObject({ index: 2, offset: 5 });
    expect(result.contentHeight).toBe(110);
  });

  it('includes the row gap when converting an anchored row into a scroll offset', () => {
    const result = computeVirtualWindow({
      total: 4,
      viewportHeight: 20,
      estimatedRowHeight: 10,
      rowGap: 5,
      anchor: { index: 2, offset: 3 }
    });

    expect(result.scrollOffset).toBe(27);
    expect(result.anchor).toMatchObject({ index: 2, offset: 3 });
  });

  it('includes the containing column gap between adjacent rows', () => {
    const result = computeVirtualWindow({
      total: 3,
      viewport: { offset: 0, height: 30 },
      estimatedRowHeight: 10,
      rowGap: 5
    });

    expect(result.contentHeight).toBe(40);
    expect(result.beforeHeight).toBe(0);
    expect(result.afterHeight).toBe(10);
  });

  it('accounts for a measured row top margin in anchor coordinates', () => {
    const result = computeVirtualWindow({
      total: 3,
      viewportHeight: 20,
      estimatedRowHeight: 10,
      rowGap: 5,
      measuredHeights: { '0': 16, '1': 24 },
      measuredMargins: { '0': 4, '1': -3 },
      anchor: { index: 1, offset: 2 }
    });

    // row 1 starts after row 0's measured outer height, the flex gap, and
    // row 1's own negative top margin.
    expect(result.scrollOffset).toBe(16);
    expect(result.beforeHeight).toBe(16);
  });

  it('adds overscan on both sides while keeping absolute bounds', () => {
    const result = computeVirtualWindow({
      total: 100,
      viewport: { offset: 500, height: 100 },
      estimatedRowHeight: 10,
      overscan: 3
    });

    expect(result.visible).toMatchObject({ start: 50, end: 60 });
    expect(result.window).toMatchObject({ start: 47, end: 63, before: 47, after: 37 });
  });

  it('starts a backward range after the cursor gap and measured margin', () => {
    const result = computeVirtualWindow({
      total: 5,
      before: 2,
      viewportHeight: 20,
      estimatedRowHeight: 10,
      rowGap: 5,
      measuredHeights: { '1': 18 },
      measuredMargins: { '2': 3 },
      direction: 'backward'
    });

    expect(result.scrollOffset).toBe(41);
  });

  it('caps a window without losing the explicit anchor', () => {
    const result = computeVirtualWindow({
      total: 100,
      viewport: { offset: 1000, height: 100 },
      estimatedRowHeight: 10,
      overscan: 20,
      maxWindow: 8,
      anchor: { index: 50, offset: 0 },
      direction: 'forward'
    });

    expect(result.window.end - result.window.start).toBe(8);
    expect(result.window.start).toBeLessThanOrEqual(50);
    expect(result.window.end).toBeGreaterThan(50);
  });

  it('compensates scroll when rows before the anchor settle to new heights', () => {
    const result = computeAnchorCompensation({
      anchor: { index: 3, offset: 12 },
      estimatedRowHeight: 20,
      previousMeasuredHeights: { '0': 20, '1': 20, '2': 20 },
      nextMeasuredHeights: { '0': 40, '1': 10, '2': 25 },
      scrollOffset: 100
    });

    expect(result.deltaBeforeAnchor).toBe(15);
    expect(result.scrollAdjustment).toBe(15);
    expect(result.scrollOffset).toBe(115);
    expect(result.anchor).toEqual({ index: 3, offset: 12 });
  });

  it('keeps intersecting pages and evicts distant pages by the page bound', () => {
    const result = evictVirtualPages({
      pages: [
        { start: 0, end: 20 },
        { start: 20, end: 40 },
        { start: 40, end: 60 },
        { start: 60, end: 80 },
        { start: 80, end: 100 }
      ],
      total: 100,
      keep: { start: 42, end: 58 },
      overscanPages: 1,
      maxPages: 3,
      anchorIndex: 50
    });

    expect(result.pages).toEqual([
      { start: 20, end: 40 },
      { start: 40, end: 60 },
      { start: 60, end: 80 }
    ]);
    expect(result.evictedBefore).toEqual([{ start: 0, end: 20 }]);
    expect(result.evictedAfter).toEqual([{ start: 80, end: 100 }]);
    expect(result.before).toBe(20);
    expect(result.after).toBe(20);
  });

  it('retains the nearest page when the requested range is between pages', () => {
    const result = evictVirtualPages({
      pages: [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 50 }],
      total: 50,
      keep: { start: 31, end: 39 },
      maxPages: 1,
      anchorIndex: 35
    });

    expect(result.pages).toEqual([{ start: 40, end: 50 }]);
    expect(result.evicted).toHaveLength(2);
  });

  it('treats an explicit zero total as an empty projection', () => {
    const result = evictVirtualPages({
      pages: [{ start: 0, end: 10 }],
      total: 0,
      keep: { start: 0, end: 0 }
    });

    expect(result.total).toBe(0);
    expect(result.pages).toEqual([]);
    expect(result.evicted).toEqual([]);
    expect(result.after).toBe(0);
  });
});
