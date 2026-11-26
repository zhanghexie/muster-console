/**
 * 自由视图画布 · 卡片实测高度读取回归（panels/freeCanvas/cardHeights.ts）：
 * 会话卡取 .board-card 内容高（scrollHeight 优先，回落 offsetHeight），
 * 便签跳过、隐藏侧（高 0）不写入。锁住自动布局「实测优先」的高度来源口径。
 */
import { describe, it, expect } from 'vitest';
import { readCanvasCardHeights } from '../../src/renderer/src/panels/freeCanvas/cardHeights';

function defineHeight(el: Element, prop: 'scrollHeight' | 'offsetHeight', value: number): void {
  Object.defineProperty(el, prop, { value, configurable: true });
}

function makeSessionCard(id: string): { node: HTMLDivElement; card: HTMLDivElement } {
  const node = document.createElement('div');
  node.setAttribute('data-cnode', id);
  const card = document.createElement('div');
  card.className = 'board-card';
  node.appendChild(card);
  return { node, card };
}

describe('readCanvasCardHeights（画布卡片测高）', () => {
  it('world 为空返回空表', () => {
    expect(readCanvasCardHeights(null)).toEqual({});
  });

  it('取 .board-card 的 scrollHeight', () => {
    const world = document.createElement('div');
    const { node, card } = makeSessionCard('a');
    defineHeight(card, 'scrollHeight', 123);
    world.appendChild(node);
    expect(readCanvasCardHeights(world)).toEqual({ a: 123 });
  });

  it('scrollHeight 为 0 时回落节点 offsetHeight；仍为 0（隐藏侧）不写入', () => {
    const world = document.createElement('div');
    const visible = makeSessionCard('vis');
    defineHeight(visible.card, 'scrollHeight', 0);
    defineHeight(visible.node, 'offsetHeight', 55);
    const hidden = makeSessionCard('hidden');
    defineHeight(hidden.card, 'scrollHeight', 0);
    defineHeight(hidden.node, 'offsetHeight', 0);
    world.append(visible.node, hidden.node);
    expect(readCanvasCardHeights(world)).toEqual({ vis: 55 });
  });

  it('便签（data-fc-kind=sticky）跳过；无 data-cnode 的元素不进表', () => {
    const world = document.createElement('div');
    const sticky = document.createElement('div');
    sticky.setAttribute('data-cnode', 'n1');
    sticky.setAttribute('data-fc-kind', 'sticky');
    const stickyCard = document.createElement('div');
    stickyCard.className = 'board-card';
    defineHeight(stickyCard, 'scrollHeight', 999);
    sticky.appendChild(stickyCard);
    const stranger = document.createElement('div');
    stranger.setAttribute('data-cnode', '');
    const strangerCard = document.createElement('div');
    strangerCard.className = 'board-card';
    defineHeight(strangerCard, 'scrollHeight', 40);
    stranger.appendChild(strangerCard);
    world.append(sticky, stranger);
    expect(readCanvasCardHeights(world)).toEqual({});
  });

  it('多卡混合：只收会话卡且 id 对齐 data-cnode', () => {
    const world = document.createElement('div');
    const a = makeSessionCard('a');
    defineHeight(a.card, 'scrollHeight', 70);
    const b = makeSessionCard('b');
    defineHeight(b.card, 'scrollHeight', 96);
    const sticky = document.createElement('div');
    sticky.setAttribute('data-cnode', 'n1');
    sticky.setAttribute('data-fc-kind', 'sticky');
    world.append(a.node, b.node, sticky);
    expect(readCanvasCardHeights(world)).toEqual({ a: 70, b: 96 });
  });
});
