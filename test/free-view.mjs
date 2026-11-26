/**
 * 自由视图（全局看板画布）纯逻辑：自动布局不重叠、会话集同步修剪、对齐吸附、适配缩放、连线几何。
 * Run: node test/free-view.mjs（npm test 自动包含）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'free-view-'));

const entry = path.join(root, 'src', 'renderer/src/panels', 'freeViewGeom.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'freeViewGeom.mjs');
fs.writeFileSync(out, outputText, 'utf8');
const geom = await import(pathToFileURL(out).href);
const {
  autoPlace,
  syncLayoutNodes,
  snapDrag,
  fitToRect,
  edgeAnchors,
  bezierPath,
  bezierMidpoint,
  groupBoxOf,
  nodeRect,
  rectsIntersect,
  bboxOf,
  clampZoom,
  convexHull,
  offsetConvex,
  roundedHullPath,
  workspaceHullOf,
  parseFreeViewLayout,
  nodeHeightOf,
  resolveArrangeHeights,
  estimateNoteLines,
  portAnchor,
  nearestPort,
  edgeKindOf,
  stickyRect,
  autoArrange,
  FREE_NODE_W,
  FREE_NODE_H,
  FREE_NODE_GAP,
  FREE_NODE_NOTE_LINE,
  FREE_NODE_NOTE_MAX_LINES,
  FREE_STICKY_W,
  FREE_STICKY_H,
  FREE_GRID_X,
  FREE_GRID_Y,
  FREE_ZOOM_MIN,
  FREE_ZOOM_MAX,
  HULL_PADDING,
  AUTO_LAYER_GAP,
  AUTO_CLUSTER_GAP,
  AUTO_ARRANGE_ROW_W,
  AUTO_STACK_GAP,
  emptyFreeViewLayout
} = geom;

/* ---------- autoPlace：顺序网格、无重叠、不占已有位 ---------- */
{
  const add = autoPlace({}, ['a', 'b', 'c']);
  assert.equal(add.a.x, 0);
  assert.equal(add.a.y, 0);
  assert.equal(add.b.x, FREE_GRID_X);
  assert.equal(add.c.x, FREE_GRID_X * 2);
  const rects = Object.values(add).map((p) => nodeRect(p));
  assert.ok(!rects.some((r, i) => rects.some((o, j) => i !== j && rectsIntersect(r, o))));

  // 已有节点占了 (0,0)：新节点跳到下一格
  const add2 = autoPlace({ keep: { x: 0, y: 0 } }, ['n1']);
  assert.equal(add2.n1.x, FREE_GRID_X);
  assert.equal(add2.n1.y, 0);
}

/* ---------- syncLayoutNodes：补位 / 修剪连线 / 修剪分组 / 空组清除 / 稳定返回 null ---------- */
{
  const l0 = emptyFreeViewLayout();
  l0.nodes = { a: { x: 0, y: 0 }, dead: { x: 500, y: 500 } };
  l0.edges = [
    { id: 'e1', from: 'a', to: 'b' }, // b 缺位 → e1 保留（b 会被补位）
    { id: 'e2', from: 'dead', to: 'a' } // dead 消失 → 剪掉
  ];
  l0.groups = [
    { id: 'g1', label: 'G1', members: ['a', 'dead'] }, // dead 剔除后剩 a
    { id: 'g2', label: 'G2', members: ['dead'] } // 剔光 → 整组清除
  ];
  l0.notes = { a: 'keep', dead: 'gone' };
  const next = syncLayoutNodes(l0, ['a', 'b']);
  assert.ok(next, '应产生变化');
  assert.ok(next.nodes.a, 'a 保留');
  assert.ok(!next.nodes.dead, 'dead 剪掉');
  assert.ok(next.nodes.b, 'b 补位');
  assert.equal(next.notes.a, 'keep');
  assert.equal(next.notes.dead, undefined, '消失会话的备注一并修剪');
  assert.deepEqual(
    next.edges.map((e) => e.id).sort(),
    ['e1'],
    '只留两端都在的连线'
  );
  assert.deepEqual(
    next.groups.map((g) => g.id),
    ['g1'],
    '空组清除，g1 留成员 a'
  );
  assert.deepEqual(next.groups[0].members, ['a']);
  // 稳定后不再变化
  assert.equal(syncLayoutNodes(next, ['a', 'b']), null);
}

/* ---------- snapDrag：阈值内吸附到边/中线，阈值外不动，xy 独立 ---------- */
{
  const stat = { x: 0, y: 0, w: 100, h: 60 };
  // 拖拽块左边 x=103，静态右边 x=100：阈值 6 内 → dx=-3，出 x 向参考线（y 已错开，不牵连）
  let r = snapDrag({ x: 103, y: 200, w: 50, h: 40 }, [stat], 6);
  assert.equal(r.dx, -3);
  assert.equal(r.dy, 0);
  assert.equal(r.guides.length, 1);
  assert.equal(r.guides[0].axis, 'x');
  assert.equal(r.guides[0].at, 100);

  // 已完全同边对齐（y 都是 0）：dy=0 也算吸附、出参考线（拖拽保持对齐的反馈）
  r = snapDrag({ x: 103, y: 0, w: 50, h: 40 }, [stat], 6);
  assert.equal(r.dy, 0);
  assert.equal(r.guides.filter((g) => g.axis === 'y' && g.at === 0).length, 1);

  // 超阈值：不吸附
  r = snapDrag({ x: 110, y: 200, w: 50, h: 40 }, [stat], 6);
  assert.equal(r.dx, 0);
  assert.equal(r.guides.length, 0);

  // 中线对中线：静态 cy=30，拖拽块 cy=28 → dy=+2
  r = snapDrag({ x: 500, y: 8, w: 50, h: 40 }, [stat], 6);
  assert.equal(r.dy, 2);
  assert.equal(r.dx, 0);

  // 同一轴多候选取最近；差值并列时先遍历者胜（这里命中：拖拽左 52 对 s1 中线 50）
  const s1 = { x: 0, y: 0, w: 100, h: 60 };
  const s2 = { x: 104, y: 200, w: 100, h: 60 };
  r = snapDrag({ x: 52, y: 400, w: 50, h: 40 }, [s1, s2], 6);
  assert.equal(r.dx, -2);
  assert.equal(r.guides[0].at, 50);
}

/* ---------- fitToRect：居中、上限 1、空内容回落 ---------- */
{
  const f = fitToRect({ x: 0, y: 0, w: 1000, h: 500 }, 800, 600, 80);
  assert.ok(f.zoom < 1 && f.zoom >= FREE_ZOOM_MIN);
  // 内容居中：屏幕中心对应内容中心
  const cx = (0 + 500) * f.zoom + f.pan.x;
  assert.ok(Math.abs(cx - 400) < 1e-6, `x 中心贴合（got ${cx}）`);
  const fy = (0 + 250) * f.zoom + f.pan.y;
  assert.ok(Math.abs(fy - 300) < 1e-6, `y 中心贴合（got ${fy}）`);

  // 小内容不放大超过 1
  const f2 = fitToRect({ x: 0, y: 0, w: 100, h: 80 }, 800, 600, 80);
  assert.equal(f2.zoom, 1);

  // 空内容：回落为居中原点、zoom 1
  const f3 = fitToRect({ x: 0, y: 0, w: 0, h: 0 }, 800, 600);
  assert.equal(f3.zoom, 1);
  assert.equal(f3.pan.x, 400);
}

/* ---------- 连线几何：相对侧锚点 + 贝塞尔路径 ---------- */
{
  // 左右相邻：a 右缘 → b 左缘
  const ra = { x: 0, y: 0, w: FREE_NODE_W, h: FREE_NODE_H };
  const rb = { x: 500, y: 0, w: FREE_NODE_W, h: FREE_NODE_H };
  const an = edgeAnchors(ra, rb);
  assert.equal(an.a.x, FREE_NODE_W);
  assert.equal(an.b.x, 500);
  assert.equal(an.aOut.x, 1);
  assert.equal(an.bOut.x, -1);

  const d = bezierPath(an.a, an.aOut, an.b, an.bOut);
  const midY = FREE_NODE_H / 2;
  assert.ok(d.startsWith(`M ${FREE_NODE_W} ${midY} C`), `路径起点/控制点朝外（got ${d.slice(0, 24)}…）`);
  assert.ok(d.trim().endsWith(`500 ${midY}`));

  // 上下相邻：a 下缘 → b 上缘
  const rc = { x: 0, y: 400, w: FREE_NODE_W, h: FREE_NODE_H };
  const an2 = edgeAnchors(ra, rc);
  assert.equal(an2.a.y, FREE_NODE_H);
  assert.equal(an2.b.y, 400);
}

/* ---------- 备注估高 + 四缘锚点 ---------- */
{
  assert.equal(nodeHeightOf(''), FREE_NODE_H);
  assert.equal(nodeHeightOf(undefined), FREE_NODE_H);
  assert.equal(nodeHeightOf('   '), FREE_NODE_H, '空白备注不抬高');
  assert.equal(nodeHeightOf('hello'), FREE_NODE_H + FREE_NODE_GAP + FREE_NODE_NOTE_LINE);
  assert.equal(nodeHeightOf('a\nb'), FREE_NODE_H + FREE_NODE_GAP + 2 * FREE_NODE_NOTE_LINE);
  assert.equal(nodeHeightOf('', false, true), FREE_NODE_H + FREE_NODE_GAP + FREE_NODE_NOTE_LINE, '编辑空备注仍占 1 行');
  assert.ok(nodeHeightOf('有分支', true) > nodeHeightOf('有分支', false));
  const capped = nodeHeightOf(Array.from({ length: 20 }, () => '一行备注').join('\n'));
  assert.equal(capped, FREE_NODE_H + FREE_NODE_GAP + FREE_NODE_NOTE_MAX_LINES * FREE_NODE_NOTE_LINE);
  assert.equal(estimateNoteLines(''), 0);
  assert.equal(estimateNoteLines(Array.from({ length: 20 }, () => 'x').join('\n')), FREE_NODE_NOTE_MAX_LINES);

  const ra = { x: 0, y: 0, w: FREE_NODE_W, h: FREE_NODE_H };
  const rb = { x: 500, y: 0, w: FREE_NODE_W, h: FREE_NODE_H };
  const east = portAnchor(ra, 'e');
  assert.equal(east.p.x, FREE_NODE_W);
  assert.equal(east.p.y, FREE_NODE_H / 2);
  assert.deepEqual(east.out, { x: 1, y: 0 });
  assert.equal(nearestPort(ra, { x: ra.x + ra.w / 2, y: ra.y - 8 }), 'n');
  assert.equal(nearestPort(ra, { x: ra.x + ra.w + 8, y: ra.y + ra.h / 2 }), 'e');
  assert.equal(nearestPort(ra, { x: ra.x + ra.w / 2, y: ra.y + ra.h + 8 }), 's');
  assert.equal(nearestPort(ra, { x: ra.x - 8, y: ra.y + ra.h / 2 }), 'w');

  const pinned = edgeAnchors(ra, rb, 's', 'n');
  assert.equal(pinned.a.y, FREE_NODE_H);
  assert.equal(pinned.a.x, FREE_NODE_W / 2);
  assert.equal(pinned.b.y, 0);
  assert.equal(pinned.b.x, 500 + FREE_NODE_W / 2);
  assert.deepEqual(pinned.aOut, { x: 0, y: 1 });
  assert.deepEqual(pinned.bOut, { x: 0, y: -1 });
}

/* ---------- groupBoxOf：bbox + 边距 + 标签区 ---------- */
{
  const box = groupBoxOf([{ x: 0, y: 0 }, { x: FREE_GRID_X, y: FREE_GRID_Y }]);
  const inner = bboxOf(
    [{ x: 0, y: 0 }, { x: FREE_GRID_X, y: FREE_GRID_Y }].map((p) => nodeRect(p))
  );
  assert.equal(box.w, inner.w + geom.GROUP_PADDING * 2);
  assert.equal(box.h, inner.h + geom.GROUP_PADDING * 2 + geom.GROUP_LABEL_H);
  assert.equal(groupBoxOf([]), null);
}

/* ---------- clampZoom ---------- */
assert.equal(clampZoom(99), FREE_ZOOM_MAX);
assert.equal(clampZoom(0.01), FREE_ZOOM_MIN);
assert.equal(clampZoom(1.234), 1.234);

/* ---------- convexHull / offsetConvex / workspaceHullOf：圆角气泡分区 ---------- */
{
  // 正方形四角 → 4 顶点，内点被丢
  const sq = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 5, y: 5 }
  ];
  const hull = convexHull(sq);
  assert.equal(hull.length, 4, '内点不进凸包');
  assert.ok(
    hull.every((p) => (p.x === 0 || p.x === 10) && (p.y === 0 || p.y === 10)),
    '凸包顶点都是四角'
  );

  assert.deepEqual(convexHull([]), []);
  assert.equal(convexHull([{ x: 1, y: 2 }]).length, 1);
  assert.equal(convexHull([{ x: 0, y: 0 }, { x: 3, y: 4 }]).length, 2);

  function pointInConvex(poly, p) {
    if (poly.length < 3) return false;
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (Math.abs(c) < 1e-6) continue;
      const s = c > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  // 单卡片：外扩后 bbox 比卡片各大 padding；卡片四角仍在外扩多边形内
  const one = workspaceHullOf([{ x: 0, y: 0 }]);
  assert.ok(one, '单卡片应有 hull');
  assert.ok(Math.abs(one.bbox.x - -HULL_PADDING) < 1e-6, `x 外扩 ${one.bbox.x}`);
  assert.ok(Math.abs(one.bbox.y - -HULL_PADDING) < 1e-6, `y 外扩 ${one.bbox.y}`);
  assert.ok(Math.abs(one.bbox.w - (FREE_NODE_W + HULL_PADDING * 2)) < 1e-6);
  assert.ok(Math.abs(one.bbox.h - (FREE_NODE_H + HULL_PADDING * 2)) < 1e-6);
  const cardCorners = [
    { x: 0, y: 0 },
    { x: FREE_NODE_W, y: 0 },
    { x: FREE_NODE_W, y: FREE_NODE_H },
    { x: 0, y: FREE_NODE_H }
  ];
  for (const c of cardCorners) {
    assert.ok(pointInConvex(one.vertices, c), `卡片角 (${c.x},${c.y}) 应在外扩凸包内`);
  }
  assert.ok(one.path.startsWith('M '), '圆角路径以 M 起');
  assert.ok(one.path.trim().endsWith('Z'), '圆角路径闭合');
  assert.ok(!one.path.includes('NaN'));
  assert.equal(one.labelX, one.bbox.x + 10);
  assert.equal(one.labelY, one.bbox.y + 5);

  assert.equal(workspaceHullOf([]), null);

  // 两张并排放的卡片：hull 包住两边
  const two = workspaceHullOf([{ x: 0, y: 0 }, { x: FREE_GRID_X, y: 0 }]);
  assert.ok(two);
  assert.ok(two.bbox.w > FREE_NODE_W + HULL_PADDING * 2);
  assert.ok(pointInConvex(two.vertices, { x: 0, y: 0 }));
  assert.ok(pointInConvex(two.vertices, { x: FREE_GRID_X + FREE_NODE_W, y: FREE_NODE_H }));

  // 拖动后重算：顶点跟着走
  const moved = workspaceHullOf([{ x: 80, y: 40 }]);
  assert.ok(moved);
  assert.ok(Math.abs(moved.bbox.x - (80 - HULL_PADDING)) < 1e-6);

  // offsetConvex 单点 → 正方形
  const off1 = offsetConvex([{ x: 10, y: 10 }], 5);
  assert.equal(off1.length, 4);
  const path = roundedHullPath(off1, 4);
  assert.ok(path.includes('Q'), '圆角用二次贝塞尔');
}

/* ---------- parseFreeViewLayout：旧数据缺 filter / notes / port 兼容 ---------- */
{
  const empty = emptyFreeViewLayout();
  assert.equal(empty.filterActiveWorkspace, false);
  assert.deepEqual(empty.notes, {});
  assert.deepEqual(empty.stickies, []);
  assert.equal(empty.version, 1);

  const old = parseFreeViewLayout({
    version: 1,
    view: 'free',
    pan: { x: 1, y: 2 },
    zoom: 1,
    nodes: { a: { x: 0, y: 0 } },
    edges: [{ id: 'e1', from: 'a', to: 'b' }],
    groups: []
  });
  assert.ok(old);
  assert.equal(old.filterActiveWorkspace, false, '旧数据缺字段 → 过滤默认关');
  assert.deepEqual(old.notes, {}, '旧数据缺 notes → 空对象');
  assert.deepEqual(old.stickies, [], '旧数据缺 stickies → 空数组');
  assert.equal(old.edges[0].fromPort, undefined, '旧边无 port 仍可解析');
  assert.equal(old.edges[0].label, undefined, '旧边无 label');
  assert.equal(old.edges[0].kind, undefined, '旧边无 kind');
  assert.equal(old.view, 'free');
  assert.deepEqual(old.nodes.a, { x: 0, y: 0 });

  const withNotes = parseFreeViewLayout({
    version: 1,
    view: 'free',
    pan: { x: 0, y: 0 },
    zoom: 1,
    nodes: { a: { x: 0, y: 0 } },
    edges: [{ id: 'e1', from: 'a', to: 'b', fromPort: 'n', toPort: 's' }],
    groups: [],
    notes: { a: 'hello' }
  });
  assert.ok(withNotes);
  assert.equal(withNotes.notes.a, 'hello');
  assert.equal(withNotes.edges[0].fromPort, 'n');
  assert.equal(withNotes.edges[0].toPort, 's');

  const on = parseFreeViewLayout({
    version: 1,
    view: 'status',
    pan: { x: 0, y: 0 },
    zoom: 1,
    nodes: {},
    edges: [],
    groups: [],
    filterActiveWorkspace: true
  });
  assert.equal(on.filterActiveWorkspace, true);

  const looseTrue = parseFreeViewLayout({
    version: 1,
    view: 'status',
    pan: { x: 0, y: 0 },
    zoom: 1,
    nodes: {},
    edges: [],
    groups: [],
    filterActiveWorkspace: 'true'
  });
  assert.equal(looseTrue.filterActiveWorkspace, false, '非严格 true 不开启');

  assert.equal(parseFreeViewLayout({ version: 2, view: 'status' }), null);
  assert.equal(parseFreeViewLayout(null), null);
  assert.equal(parseFreeViewLayout('nope'), null);

  const withStickies = parseFreeViewLayout({
    version: 1,
    view: 'free',
    pan: { x: 0, y: 0 },
    zoom: 1,
    nodes: { a: { x: 0, y: 0 } },
    edges: [
      {
        id: 'e-fork',
        from: 'a',
        to: 'b',
        kind: 'fork',
        label: '  custom  ',
        fromPort: 'e',
        toPort: 'w'
      },
      { id: 'e-bad-kind', from: 'a', to: 'b', kind: 'note' }
    ],
    groups: [],
    stickies: [
      { id: 'n1', x: 10, y: 20, text: 'idea' },
      { id: 'bad' },
      { id: 'n2', x: 1, y: 2 }
    ]
  });
  assert.ok(withStickies);
  assert.equal(withStickies.stickies.length, 2);
  assert.equal(withStickies.stickies[0].text, 'idea');
  assert.equal(withStickies.stickies[1].text, '');
  assert.equal(withStickies.edges[0].kind, 'fork');
  assert.equal(withStickies.edges[0].label, '  custom  ');
  assert.equal(withStickies.edges[1].kind, undefined, '非法 kind 丢弃');
  assert.equal(edgeKindOf(withStickies.edges[0]), 'fork');
  assert.equal(edgeKindOf(withStickies.edges[1]), undefined);
}

/* ---------- 便签连线不被会话同步剪掉；消失会话仍剪会话端 ---------- */
{
  const l0 = emptyFreeViewLayout();
  l0.nodes = { a: { x: 0, y: 0 } };
  l0.stickies = [{ id: 'n1', x: 400, y: 0, text: 'x' }];
  l0.edges = [
    { id: 'e-note', from: 'a', to: 'n1' },
    { id: 'e-dead', from: 'dead', to: 'n1' }
  ];
  const next = syncLayoutNodes(l0, ['a']);
  assert.ok(next);
  assert.equal(next.stickies.length, 1);
  assert.deepEqual(
    next.edges.map((e) => e.id),
    ['e-note']
  );
  assert.equal(syncLayoutNodes(next, ['a']), null);
}

/* ---------- bezierMidpoint 在两端之间 ---------- */
{
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  const mid = bezierMidpoint(a, { x: 1, y: 0 }, b, { x: -1, y: 0 });
  assert.ok(mid.x > 20 && mid.x < 80, `中点 x 应在两端之间 (got ${mid.x})`);
  const r = stickyRect({ x: 5, y: 7 });
  assert.equal(r.x, 5);
  assert.ok(r.w > 100);
}

/* ---------- autoArrange：分簇 / 分层 / 簇排布 / 确定性 ---------- */
{
  // 空输入
  const empty = autoArrange({
    sessions: [],
    stickies: [],
    edges: [],
    workspaceOrder: []
  });
  assert.deepEqual(empty.nodes, {});
  assert.deepEqual(empty.stickyPos, {});

  // 簇包围盒工具：按输出位置反推每簇的 hull bbox（与渲染同口径，含 28px 外扩）
  function clusterBoxes(result, zoneById, stickyIds2 = []) {
    const stickySet2 = new Set(stickyIds2);
    const byZone = new Map();
    for (const [id, p] of Object.entries(result.nodes)) {
      const z = zoneById[id] ?? '';
      if (!byZone.has(z)) byZone.set(z, { pts: [], hs: [] });
      byZone.get(z).pts.push(p);
      byZone.get(z).hs.push(FREE_NODE_H);
    }
    for (const [id, p] of Object.entries(result.stickyPos)) {
      const z = zoneById[id] ?? '';
      if (!byZone.has(z)) byZone.set(z, { pts: [], hs: [] });
      byZone.get(z).pts.push(p);
      byZone.get(z).hs.push(FREE_STICKY_H);
    }
    return [...byZone.entries()].map(([z, m]) => ({ zone: z, bbox: workspaceHullOf(m.pts, m.hs).bbox }));
  }
  function assertNoClusterOverlap(boxes) {
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].bbox;
        const b = boxes[j].bbox;
        const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
        const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
        const gap = Math.max(gapX, gapY);
        assert.ok(
          gap >= AUTO_CLUSTER_GAP - 1e-6,
          `簇 ${boxes[i].zone} 与 ${boxes[j].zone} 应间隔 ≥ ${AUTO_CLUSTER_GAP}（got ${gap}）`
        );
      }
    }
  }
  // 全部节点矩形（含便签实际尺寸）两两不重叠。heights 缺省按 FREE_NODE_H。
  function assertNoNodeOverlap(result, heights = {}) {
    const rects = [
      ...Object.entries(result.nodes).map(([id, p]) => ({ id, r: nodeRect(p, heights[id]) })),
      ...Object.entries(result.stickyPos).map(([id, p]) => ({ id, r: stickyRect(p) }))
    ];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        assert.ok(
          !rectsIntersect(rects[i].r, rects[j].r),
          `节点 ${rects[i].id} 与 ${rects[j].id} 不应重叠`
        );
      }
    }
  }

  // 1) 链式分层：a→b→c 左→右，层间距 ≥ AUTO_LAYER_GAP
  {
    const r = autoArrange({
      sessions: [
        { id: 'a', zoneId: 'ws1' },
        { id: 'b', zoneId: 'ws1' },
        { id: 'c', zoneId: 'ws1' }
      ],
      stickies: [],
      edges: [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'c' }],
      workspaceOrder: ['ws1']
    });
    assert.ok(r.nodes.a.x < r.nodes.b.x && r.nodes.b.x < r.nodes.c.x, '链式节点应从左到右');
    assert.ok(r.nodes.b.x - (r.nodes.a.x + FREE_NODE_W) >= AUTO_LAYER_GAP - 1e-6, '层间横向间距');
    assertNoNodeOverlap(r);
  }

  // 2) 分簇：两工作区 + 未分区（zoneId 不在 workspaceOrder）垫底；簇间有呼吸间距
  {
    const zoneById = { a: 'ws1', b: 'ws1', c: 'ws2', d: '' };
    const input = {
      sessions: [
        { id: 'a', zoneId: 'ws1' },
        { id: 'b', zoneId: 'ws1' },
        { id: 'c', zoneId: 'ws2' },
        { id: 'd', zoneId: 'wsGone' }
      ],
      stickies: [],
      edges: [{ id: 'e1', from: 'a', to: 'b' }],
      workspaceOrder: ['ws1', 'ws2']
    };
    const r = autoArrange(input);
    const boxes = clusterBoxes(r, zoneById);
    assert.equal(boxes.length, 3, '三个簇');
    assertNoClusterOverlap(boxes);
    const unzoned = boxes.find((b) => b.zone === '');
    assert.ok(unzoned, '已关闭工作区归未分区');
    const ws2 = boxes.find((b) => b.zone === 'ws2');
    assert.ok(
      unzoned.bbox.x > ws2.bbox.x + ws2.bbox.w,
      '未分区簇应排在侧栏工作区之后（垫底）'
    );
    assertNoNodeOverlap(r);
  }

  // 3) 成环不死循环：a→b→a 加出边 b→c，全部落位且 c 在 b 右侧
  {
    const r = autoArrange({
      sessions: [
        { id: 'a', zoneId: 'ws1' },
        { id: 'b', zoneId: 'ws1' },
        { id: 'c', zoneId: 'ws1' }
      ],
      stickies: [],
      edges: [
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'b', to: 'a' },
        { id: 'e3', from: 'b', to: 'c' }
      ],
      workspaceOrder: ['ws1']
    });
    assert.ok(Number.isFinite(r.nodes.a.x) && Number.isFinite(r.nodes.b.x) && Number.isFinite(r.nodes.c.x));
    assert.ok(r.nodes.c.x > r.nodes.b.x + FREE_NODE_W, '环外节点应在环后一层');
    assertNoNodeOverlap(r);
  }

  // 4) 跨区边不参与聚簇/分层：两端各自归簇、层不受对端影响
  {
    const zoneById = { a: 'ws1', b: 'ws2', c: 'ws1' };
    const r = autoArrange({
      sessions: [
        { id: 'a', zoneId: 'ws1' },
        { id: 'b', zoneId: 'ws2' },
        { id: 'c', zoneId: 'ws1' }
      ],
      stickies: [],
      edges: [
        { id: 'cross', from: 'a', to: 'b' },
        { id: 'e1', from: 'a', to: 'c' }
      ],
      workspaceOrder: ['ws1', 'ws2']
    });
    const boxes = clusterBoxes(r, zoneById);
    assert.equal(boxes.length, 2, '跨区边不合并簇');
    assertNoClusterOverlap(boxes);
    assert.ok(r.nodes.c.x > r.nodes.a.x + FREE_NODE_W, '同簇边仍分层');
    assertNoNodeOverlap(r);
  }

  // 5) 便签挂对端会话所在簇；平票取第一条边；无连线便签归未分区
  {
    const r = autoArrange({
      sessions: [
        { id: 'a', zoneId: 'ws1' },
        { id: 'c', zoneId: 'ws2' }
      ],
      stickies: [
        { id: 'n1', x: 0, y: 0, text: '' },
        { id: 'n2', x: 0, y: 0, text: '' },
        { id: 'n3', x: 0, y: 0, text: '' }
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'n1' },
        { id: 'e2', from: 'a', to: 'n2' },
        { id: 'e3', from: 'n2', to: 'c' }
      ],
      workspaceOrder: ['ws1', 'ws2']
    });
    // 簇间互不重叠 ⇒ 同簇成员的 x 都在下一簇之前、未分区垫底在最后：
    // 行序 ws1(a·n1·n2) → ws2(c) → 未分区(n3)
    assert.ok(r.stickyPos.n1.x < r.nodes.c.x, 'n1 挂对端会话 ws1');
    assert.ok(r.stickyPos.n2.x < r.nodes.c.x, 'n2 平票取第一条边 → ws1');
    assert.ok(r.stickyPos.n3.x > r.nodes.c.x + FREE_NODE_W, '无连线便签 n3 归未分区（垫底）');
    assert.ok(
      r.stickyPos.n1.x > r.nodes.a.x + FREE_NODE_W - 1e-6,
      '便签作为图中节点参与分层（a→n1 在 a 右侧一层）'
    );
    assertNoNodeOverlap(r);
  }

  // 6) 纯便签（无会话无连线）：未分区网格补位，不重叠
  {
    const r = autoArrange({
      sessions: [],
      stickies: [
        { id: 'n1', x: 900, y: 900, text: 'x' },
        { id: 'n2', x: -900, y: -900, text: 'y' },
        { id: 'n3', x: 0, y: 0, text: '' }
      ],
      edges: [],
      workspaceOrder: []
    });
    assert.equal(Object.keys(r.stickyPos).length, 3);
    assertNoNodeOverlap(r);
  }

  // 7) 单节点工作区 + 无连线节点簇尾单列竖排补位（在分层内容右侧）
  {
    const r = autoArrange({
      sessions: [
        { id: 'a', zoneId: 'ws1' },
        { id: 'b', zoneId: 'ws1' },
        { id: 'lone', zoneId: 'ws2' }
      ],
      stickies: [],
      edges: [],
      workspaceOrder: ['ws1', 'ws2']
    });
    assertNoNodeOverlap(r);
    assert.equal(r.nodes.a.x, r.nodes.b.x, '无连线节点单列：x 对齐');
    assert.ok(r.nodes.a.y !== r.nodes.b.y, '无连线节点单列：纵向错开');
    // 纯孤立簇（10 个）也应排成一列而非网格
    const r2 = autoArrange({
      sessions: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, zoneId: 'ws1' })),
      stickies: [],
      edges: [],
      workspaceOrder: ['ws1']
    });
    const xs = new Set(Object.values(r2.nodes).map((p) => p.x));
    assert.equal(xs.size, 1, '10 个孤立节点应只有一列');
    assertNoNodeOverlap(r2);
    // 混合簇：孤立列在左（簇首），有层级的分层内容整体在右
    const r3 = autoArrange({
      sessions: [
        { id: 'iso', zoneId: 'ws1' },
        { id: 'p', zoneId: 'ws1' },
        { id: 'q', zoneId: 'ws1' }
      ],
      stickies: [],
      edges: [{ id: 'e', from: 'p', to: 'q' }],
      workspaceOrder: ['ws1']
    });
    assert.equal(r3.nodes.iso.x, 0, '孤立节点列贴簇首');
    assert.ok(
      r3.nodes.iso.x + FREE_NODE_W + AUTO_LAYER_GAP <= r3.nodes.p.x + 1e-6,
      '有层级的分层内容应在孤立列右侧'
    );
    assertNoNodeOverlap(r3);
  }

  // 8) 确定性：同一输入两次调用完全一致（含环、便签、乱序输入）
  {
    const mk = () => ({
      sessions: [
        { id: 's2', zoneId: 'wsB' },
        { id: 's1', zoneId: 'wsA' },
        { id: 's3', zoneId: 'wsA' },
        { id: 'x1', zoneId: 'zzz' }
      ],
      stickies: [
        { id: 'n2', x: 5, y: 5, text: '' },
        { id: 'n1', x: 1, y: 2, text: 'idea' }
      ],
      edges: [
        { id: 'e2', from: 's3', to: 's1' },
        { id: 'e1', from: 's1', to: 's3' },
        { id: 'e3', from: 'n1', to: 's1' },
        { id: 'e4', from: 's2', to: 'n2' }
      ],
      workspaceOrder: ['wsA', 'wsB']
    });
    assert.deepEqual(autoArrange(mk()), autoArrange(mk()), '同输入必须同输出');
  }

  // 9) 备注加高的卡片参与布局不重叠（heights 生效：单列行距随实际高度放大）
  {
    const tall = nodeHeightOf('一行\n两行\n三行\n四行\n五行备注');
    const mk = (heights) =>
      autoArrange({
        sessions: [
          { id: 'a', zoneId: 'ws1' },
          { id: 'b', zoneId: 'ws1' },
          { id: 'c', zoneId: 'ws1' },
          { id: 'd', zoneId: 'ws1' }
        ],
        stickies: [],
        edges: [],
        workspaceOrder: ['ws1'],
        heights
      });
    const def = mk(undefined);
    const ysDef = Object.values(def.nodes).map((p) => p.y).sort((x, y) => x - y);
    assert.equal(
      ysDef[1] - ysDef[0],
      FREE_NODE_H + AUTO_STACK_GAP,
      '缺省高度行距 = 高度 + AUTO_STACK_GAP（与同层堆叠一致）'
    );
    const r2 = mk({ a: tall, b: tall, c: tall, d: tall });
    const ys = Object.values(r2.nodes).map((p) => p.y).sort((x, y) => x - y);
    for (let i = 1; i < ys.length; i++) {
      assert.ok(ys[i] - ys[i - 1] >= tall + AUTO_STACK_GAP - 1e-6, '纵向步距含实际高度');
    }
    // 按实际高度建矩形验证不重叠
    const rects = Object.values(r2.nodes).map((p) => ({ x: p.x, y: p.y, w: FREE_NODE_W, h: tall }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        assert.ok(!rectsIntersect(rects[i], rects[j]), '加高卡片不重叠');
      }
    }
  }

  // 9b) 混高孤立列：矮→高→中，相邻「底→顶」间隙必须是 AUTO_STACK_GAP（不能按统一高度排）
  {
    const heights = { a: 70, b: 140, c: 96, d: 110 };
    const sessions = [
      { id: 'a', zoneId: 'ws1' },
      { id: 'b', zoneId: 'ws1' },
      { id: 'c', zoneId: 'ws1' },
      { id: 'd', zoneId: 'ws1' }
    ];
    const r = autoArrange({
      sessions,
      stickies: [],
      edges: [],
      workspaceOrder: ['ws1'],
      heights
    });
    const ordered = Object.entries(r.nodes).sort((x, y) => x[1].y - y[1].y || (x[0] < y[0] ? -1 : 1));
    for (let i = 1; i < ordered.length; i++) {
      const [prevId, prev] = ordered[i - 1];
      const [, cur] = ordered[i];
      const gap = cur.y - (prev.y + heights[prevId]);
      assert.equal(gap, AUTO_STACK_GAP, `${prevId} 底到下一张顶的间隙必须是 AUTO_STACK_GAP，got ${gap}`);
    }
    assertNoNodeOverlap(r, heights);

    // 对照：不传混高、却按实际高度画矩形 → 必重叠（锁死「按统一高度排」这个 bug）
    const naive = autoArrange({
      sessions,
      stickies: [],
      edges: [],
      workspaceOrder: ['ws1']
    });
    const naiveRects = Object.entries(naive.nodes).map(([id, p]) => nodeRect(p, heights[id]));
    let overlapped = false;
    for (let i = 0; i < naiveRects.length; i++) {
      for (let j = i + 1; j < naiveRects.length; j++) {
        if (rectsIntersect(naiveRects[i], naiveRects[j])) overlapped = true;
      }
    }
    assert.ok(overlapped, '不传混高时按实际高度画必重叠——本用例锁的就是这个问题');
  }

  // 9c) 同层混高（A、B 都指向 C）：层内底→顶间隙 ≥ AUTO_STACK_GAP，矩形不重叠
  {
    const heights = { a: 70, b: 130, c: 90 };
    const r = autoArrange({
      sessions: [
        { id: 'a', zoneId: 'ws1' },
        { id: 'b', zoneId: 'ws1' },
        { id: 'c', zoneId: 'ws1' }
      ],
      stickies: [],
      edges: [
        { id: 'e1', from: 'a', to: 'c' },
        { id: 'e2', from: 'b', to: 'c' }
      ],
      workspaceOrder: ['ws1'],
      heights
    });
    const top = r.nodes.a.y <= r.nodes.b.y ? 'a' : 'b';
    const bot = top === 'a' ? 'b' : 'a';
    const gap = r.nodes[bot].y - (r.nodes[top].y + heights[top]);
    assert.ok(gap >= AUTO_STACK_GAP - 1e-6, `同层混高间隙应 ≥ AUTO_STACK_GAP，got ${gap}`);
    assertNoNodeOverlap(r, heights);
  }

  // 9d) resolveArrangeHeights：全员进表、实测优先、0 回落估算、分支加高
  {
    const notesOnly = resolveArrangeHeights({
      sessionIds: ['a', 'b'],
      notes: { a: '一行备注' }
    });
    assert.equal(Object.keys(notesOnly).sort().join(','), 'a,b', '没备注的卡也要进表');
    assert.equal(notesOnly.b, FREE_NODE_H);
    assert.equal(notesOnly.a, nodeHeightOf('一行备注'));
    const withBranch = resolveArrangeHeights({
      sessionIds: ['x'],
      hasBranch: { x: true }
    });
    assert.equal(withBranch.x, nodeHeightOf(undefined, true));
    assert.ok(withBranch.x > FREE_NODE_H, '有分支应比紧凑底高');
    const measuredWins = resolveArrangeHeights({
      sessionIds: ['a'],
      notes: { a: 'x' },
      measured: { a: 123 }
    });
    assert.equal(measuredWins.a, 123, '实测优先于估算');
    const ignoreZero = resolveArrangeHeights({
      sessionIds: ['a'],
      measured: { a: 0 }
    });
    assert.equal(ignoreZero.a, FREE_NODE_H, '实测 0 回落估算');
  }

  // 11) 重心法降交叉：2×2 叉形边（p1→q2、p2→q1）必须收敛为不交叉（同侧对齐）
  {
    const r = autoArrange({
      sessions: [
        { id: 'p1', zoneId: 'ws1' },
        { id: 'p2', zoneId: 'ws1' },
        { id: 'q1', zoneId: 'ws1' },
        { id: 'q2', zoneId: 'ws1' }
      ],
      stickies: [],
      edges: [
        { id: 'e1', from: 'p1', to: 'q2' },
        { id: 'e2', from: 'p2', to: 'q1' }
      ],
      workspaceOrder: ['ws1']
    });
    // 无论 id 初始序如何，终态必须无交叉：p1/p2 的上下相对序与 q2/q1 一致
    const rel = (a, b) => Math.sign(a.y - b.y);
    assert.equal(
      rel(r.nodes.p1, r.nodes.p2),
      rel(r.nodes.q2, r.nodes.q1),
      '两条叉形边的两端应各自同侧对齐（不交叉）'
    );
    assert.ok(r.nodes.q1.x > r.nodes.p1.x + FREE_NODE_W, '分层左→右不变');
    assertNoNodeOverlap(r);
  }

  // 12) 纵向居中：会话与其便签子节点中心对齐（连线水平拉直）；等高链中心对齐；多子不重叠
  {
    const r = autoArrange({
      sessions: [{ id: 'a', zoneId: 'ws1' }],
      stickies: [{ id: 'n1', x: 0, y: 0, text: '' }],
      edges: [{ id: 'e', from: 'a', to: 'n1' }],
      workspaceOrder: ['ws1']
    });
    const aCy = r.nodes.a.y + FREE_NODE_H / 2;
    const nCy = r.stickyPos.n1.y + FREE_STICKY_H / 2;
    assert.ok(Math.abs(aCy - nCy) < 1e-6, `便签应与会话中心对齐（got ${aCy} vs ${nCy}）`);
    assert.ok(r.stickyPos.n1.x > r.nodes.a.x + FREE_NODE_W, '便签在会话右侧一层');

    const r2 = autoArrange({
      sessions: [
        { id: 'a', zoneId: 'ws1' },
        { id: 'b', zoneId: 'ws1' },
        { id: 'c', zoneId: 'ws1' }
      ],
      stickies: [],
      edges: [
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'b', to: 'c' }
      ],
      workspaceOrder: ['ws1']
    });
    const cyOf = (id) => r2.nodes[id].y + FREE_NODE_H / 2;
    assert.ok(
      Math.abs(cyOf('a') - cyOf('b')) < 1e-6 && Math.abs(cyOf('b') - cyOf('c')) < 1e-6,
      '等高链中心对齐'
    );

    const r3 = autoArrange({
      sessions: [
        { id: 'a', zoneId: 'ws1' },
        { id: 'b', zoneId: 'ws1' },
        { id: 'c', zoneId: 'ws1' }
      ],
      stickies: [],
      edges: [
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'a', to: 'c' }
      ],
      workspaceOrder: ['ws1']
    });
    assertNoNodeOverlap(r3);
  }

  // 10) 行宽预算：大量无连线单工作区簇换行，行距 ≥ AUTO_CLUSTER_GAP
  {
    const n = 40;
    const sessions = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, zoneId: `ws${i}` }));
    const r = autoArrange({
      sessions,
      stickies: [],
      edges: [],
      workspaceOrder: Array.from({ length: n }, (_, i) => `ws${i}`)
    });
    // 每个单节点簇 bbox 宽 = FREE_NODE_W + 2 * HULL_PADDING；每行应放不下超过预算/簇宽 个
    const per = Math.floor((AUTO_ARRANGE_ROW_W + AUTO_CLUSTER_GAP) / (FREE_NODE_W + 2 * HULL_PADDING + AUTO_CLUSTER_GAP));
    assert.ok(per > 1, '预算应容纳多个簇');
    const rowsY = [...new Set(Object.values(r.nodes).map((p) => p.y))].sort((a, b) => a - b);
    assert.ok(rowsY.length > 1, '应发生换行');
    assert.ok(rowsY[1] - rowsY[0] >= FREE_NODE_H + 2 * HULL_PADDING + AUTO_CLUSTER_GAP - 1e-6, '行间呼吸间距');
  }
}

console.log('free-view: all assertions passed');
