/**
 * 自由视图画布 · 手势纯函数回归（拆分自 panels/FreeCanvas.tsx → panels/freeCanvas/canvasOps.ts）：
 * 框选命中、拖拽吸附位移、同对连线去重。语义与拆分前 FreeCanvas.tsx 内联实现一致，
 * 还原任一实现（改回内联或改动本模块）时以下断言锁定行为。
 */
import { describe, it, expect } from 'vitest';
import {
  dragMovePositions,
  findDuplicateEdge,
  marqueeHits,
  rectHits
} from '../../src/renderer/src/panels/freeCanvas/canvasOps';
import {
  FREE_NODE_W,
  FREE_STICKY_H,
  FREE_STICKY_W,
  stickyRect,
  type FreeSticky
} from '../../src/renderer/src/panels/freeViewGeom';

describe('rectHits（框选相交判定）', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };

  it('相交为真', () => {
    expect(rectHits({ x: 50, y: 50, w: 100, h: 100 }, rect)).toBe(true);
    expect(rectHits({ x: -50, y: -50, w: 60, h: 60 }, rect)).toBe(true);
    expect(rectHits(rect, rect)).toBe(true);
  });

  it('贴边（严格小于）不算命中', () => {
    expect(rectHits({ x: 100, y: 0, w: 10, h: 10 }, rect)).toBe(false);
    expect(rectHits({ x: 0, y: 100, w: 10, h: 10 }, rect)).toBe(false);
    expect(rectHits({ x: -10, y: 0, w: 10, h: 10 }, rect)).toBe(false);
  });

  it('完全不相交为假', () => {
    expect(rectHits({ x: 500, y: 500, w: 10, h: 10 }, rect)).toBe(false);
  });
});

describe('marqueeHits（框选命中筛选）', () => {
  const sticky1: FreeSticky = { id: 'sticky1', x: 50, y: 50, text: 'idea' };

  function makeOpts(hOfHeight: number) {
    return {
      visibleIdSet: new Set(['a', 'b', 'sticky1']),
      stickyById: new Map<string, FreeSticky>([['sticky1', sticky1]]),
      hOf: () => hOfHeight
    };
  }

  it('按会话卡矩形命中、便签按便签尺寸命中、顺序保持', () => {
    const candidates = [
      ['a', { x: 0, y: 0 }],
      ['b', { x: 1000, y: 1000 }],
      ['sticky1', { x: 50, y: 50 }]
    ] as const;
    const hits = marqueeHits(candidates, { x: 0, y: 0, w: 200, h: 200 }, makeOpts(70));
    expect(hits).toEqual(['a', 'sticky1']);
  });

  it('不可见节点（过滤隐藏）不命中', () => {
    const opts = { ...makeOpts(70), visibleIdSet: new Set(['a']) };
    const hits = marqueeHits(
      [
        ['a', { x: 0, y: 0 }],
        ['hidden', { x: 0, y: 0 }]
      ],
      { x: 0, y: 0, w: 200, h: 200 },
      opts
    );
    expect(hits).toEqual(['a']);
  });

  it('会话卡高度来自 hOf：框选下缘只压到 70 高的卡底，50 高则不命中', () => {
    const rect = { x: 0, y: 60, w: 300, h: 10 };
    expect(marqueeHits([['a', { x: 0, y: 0 }]], rect, makeOpts(70))).toEqual(['a']);
    expect(marqueeHits([['a', { x: 0, y: 0 }]], rect, makeOpts(50))).toEqual([]);
  });
});

describe('dragMovePositions（拖拽位移 + 吸附）', () => {
  const noopRectOf = () => null;

  it('整体跟手：所有节点按指针世界位移平移', () => {
    const { moved, guides } = dragMovePositions({
      nodeStarts: {
        a: { x: 10, y: 10 },
        b: { x: 110, y: 10 }
      },
      startWorld: { x: 0, y: 0 },
      cur: { x: 5, y: -3 },
      zoom: 1,
      dragIds: new Set(['a', 'b']),
      layoutNodes: {},
      stickies: [],
      visibleIdSet: new Set(['a', 'b']),
      rectOf: noopRectOf,
      hOf: () => 70
    });
    expect(moved.a).toEqual({ x: 15, y: 7 });
    expect(moved.b).toEqual({ x: 115, y: 7 });
    expect(guides).toEqual([]);
  });

  it('吸附：拖拽块左缘距静态节点右缘 3px（阈值内）→ 修正贴齐并出 x 向参考线', () => {
    const staticPos = { x: 0, y: 200 };
    const { moved, guides } = dragMovePositions({
      nodeStarts: { a: { x: 0, y: 500 } },
      startWorld: { x: 0, y: 500 },
      cur: { x: FREE_NODE_W + 3, y: 500 },
      zoom: 1,
      dragIds: new Set(['a']),
      layoutNodes: { s: staticPos },
      stickies: [],
      visibleIdSet: new Set(['a', 's']),
      rectOf: noopRectOf,
      hOf: () => 60
    });
    expect(moved.a.x).toBe(FREE_NODE_W); // 251 - 3 → 与静态右缘 (0+248) 贴齐
    expect(guides).toHaveLength(1);
    expect(guides[0].axis).toBe('x');
    expect(guides[0].at).toBe(FREE_NODE_W);
  });

  it('吸附候选排除：被拖节点自身、不可见节点不进 statics', () => {
    // 静态里放一张与拖拽完全同位的卡（若是自身则不会产生「差 0 吸附」参考线——已被排除）
    const { guides } = dragMovePositions({
      nodeStarts: { a: { x: 0, y: 0 } },
      startWorld: { x: 0, y: 0 },
      cur: { x: 0, y: 0 },
      zoom: 1,
      dragIds: new Set(['a']),
      layoutNodes: { a: { x: 0, y: 0 }, hidden: { x: 0, y: 0 } },
      stickies: [],
      visibleIdSet: new Set(['a']), // hidden 被过滤隐藏
      rectOf: noopRectOf,
      hOf: () => 70
    });
    expect(guides).toEqual([]);
  });

  it('便签作为静态吸附物：按便签实际尺寸取矩形；被拖的便签排除', () => {
    // 便签 stickyRect 宽 FREE_STICKY_W；拖拽块左缘对齐其右缘
    const sticky: FreeSticky = { id: 'n1', x: 0, y: 300, text: '' };
    const { moved, guides } = dragMovePositions({
      nodeStarts: { a: { x: 0, y: 900 } },
      startWorld: { x: 0, y: 900 },
      cur: { x: FREE_STICKY_W + 2, y: 900 },
      zoom: 1,
      dragIds: new Set(['a']),
      layoutNodes: {},
      stickies: [sticky],
      visibleIdSet: new Set(['a', 'n1']),
      rectOf: noopRectOf,
      hOf: () => 60
    });
    expect(moved.a.x).toBe(FREE_STICKY_W);
    expect(guides[0].axis).toBe('x');
    expect(guides[0].at).toBe(FREE_STICKY_W);

    // 被拖便签自身不进 statics
    const { guides: none } = dragMovePositions({
      nodeStarts: { n1: { x: 0, y: 0 } },
      startWorld: { x: 0, y: 0 },
      cur: { x: 0, y: 0 },
      zoom: 1,
      dragIds: new Set(['n1']),
      layoutNodes: {},
      stickies: [{ ...sticky, y: 0 }],
      visibleIdSet: new Set(['n1']),
      rectOf: noopRectOf,
      hOf: () => 60
    });
    expect(none).toEqual([]);
  });

  it('rectOf 有实测矩形时按实测宽度建拖拽 bbox（右侧吸附走实测缘而非估算宽）', () => {
    // 实测宽 300（>估算 248）：拖到静态左缘右侧 6px（zoom 0.5 → 阈值 12 世界像素）应吸附贴齐
    const measured = { x: 0, y: 0, w: 300, h: 30 };
    const { moved, guides } = dragMovePositions({
      nodeStarts: { a: { x: 0, y: 0 } },
      startWorld: { x: 0, y: 0 },
      cur: { x: -294, y: 0 },
      zoom: 0.5,
      dragIds: new Set(['a']),
      layoutNodes: { s: { x: 0, y: 500 } },
      stickies: [],
      visibleIdSet: new Set(['a', 's']),
      rectOf: (id) => (id === 'a' ? measured : null),
      hOf: () => 60
    });
    expect(moved.a.x).toBe(-300); // 修正量 = 目标 - 当前缘 = 0 - 6 = -6：右缘 (x+300) 贴到静态左缘 0
    expect(guides).toHaveLength(1);
    expect(guides[0].axis).toBe('x');
    expect(guides[0].at).toBe(0);

    // 对照：按估算宽 248 建框时右缘距 46 > 阈值 12，不应吸附
    const noMeasure = dragMovePositions({
      nodeStarts: { a: { x: 0, y: 0 } },
      startWorld: { x: 0, y: 0 },
      cur: { x: -294, y: 0 },
      zoom: 0.5,
      dragIds: new Set(['a']),
      layoutNodes: { s: { x: 0, y: 500 } },
      stickies: [],
      visibleIdSet: new Set(['a', 's']),
      rectOf: () => null,
      hOf: () => 60
    });
    expect(noMeasure.moved.a.x).toBe(-294);
    expect(noMeasure.guides).toEqual([]);
  });
});

describe('findDuplicateEdge（同对连线去重）', () => {
  const edges = [{ id: 'e1', from: 'a', to: 'b' }];

  it('同向命中', () => {
    expect(findDuplicateEdge(edges, 'a', 'b')).toBe(true);
  });

  it('反向（无向）也命中', () => {
    expect(findDuplicateEdge(edges, 'b', 'a')).toBe(true);
  });

  it('新对不命中', () => {
    expect(findDuplicateEdge(edges, 'a', 'c')).toBe(false);
    expect(findDuplicateEdge(edges, 'c', 'a')).toBe(false);
  });

  it('空边集不命中；便签尺寸常量与布局口径一致（防漂移哨兵）', () => {
    expect(findDuplicateEdge([], 'a', 'b')).toBe(false);
    expect(FREE_STICKY_W).toBeGreaterThan(0);
    expect(FREE_STICKY_H).toBeGreaterThan(0);
    expect(stickyRect({ x: 3, y: 4 }).w).toBe(FREE_STICKY_W);
  });
});
