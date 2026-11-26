import { describe, expect, it } from 'vitest';
import {
  PageMapCoordinator,
  type PagePayload
} from '../../src/renderer/src/chatSurface/pageMapCoordinator';

type Row = { text: string };

function page(
  generation: number,
  start: number,
  rows: Array<[string, string]>,
  cursor?: PagePayload<Row>['cursor']
): PagePayload<Row> {
  return {
    generation,
    range: { start, end: start + rows.length },
    messages: rows.map(([messageId, text]) => ({ messageId, payload: { text } })),
    ...(cursor ? { cursor } : {})
  };
}

describe('page map coordinator', () => {
  it('sorts out-of-order pages and deduplicates overlapping stable message ids', () => {
    const map = new PageMapCoordinator<Row>({ generation: 4, total: 4 });

    expect(map.applyPage(page(4, 2, [['m2', 'old'], ['m3', 'three']])).status).toBe('accepted');
    expect(map.applyPage(page(4, 0, [['m0', 'zero'], ['m1', 'one'], ['m2', 'new']])).status).toBe('accepted');

    const snapshot = map.getSnapshot();
    expect(snapshot.pages.map(item => item.range)).toEqual([
      { start: 0, end: 3 },
      { start: 2, end: 4 }
    ]);
    expect(snapshot.messages.map(item => item.messageId)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(snapshot.messages.find(item => item.messageId === 'm2')?.payload).toEqual({ text: 'new' });
    expect(snapshot.loadedRanges).toEqual([{ start: 0, end: 4 }]);
  });

  it('treats an identical page response as a no-op and keeps one id', () => {
    const map = new PageMapCoordinator<Row>({ generation: 2 });
    const response = page(2, 0, [['m0', 'zero'], ['m1', 'one']]);

    expect(map.applyPage(response).status).toBe('accepted');
    expect(map.applyPage(response).status).toBe('duplicate');
    expect(map.getSnapshot().messages.map(item => item.messageId)).toEqual(['m0', 'm1']);
    expect(map.getSnapshot().pages).toHaveLength(1);
  });

  it('replaces a same-range page while retaining the stable message id', () => {
    const map = new PageMapCoordinator<Row>({ generation: 1 });
    expect(map.applyPage(page(1, 0, [['m0', 'old']])).status).toBe('accepted');
    expect(map.applyPage(page(1, 0, [['m0', 'fresh']])).status).toBe('replaced');

    const [message] = map.getSnapshot().messages;
    expect(message?.messageId).toBe('m0');
    expect(message?.payload).toEqual({ text: 'fresh' });
  });

  it('rejects a late page from a cleared generation without resurrecting it', () => {
    const map = new PageMapCoordinator<Row>({ generation: 8 });
    const late = page(8, 0, [['m0', 'old']]);
    expect(map.applyPage(late).status).toBe('accepted');

    expect(map.reset()).toBe(9);
    expect(map.applyPage(late).status).toBe('stale-generation');
    expect(map.getSnapshot().pages).toEqual([]);
    expect(map.getSnapshot().messages).toEqual([]);
  });

  it('invalidates a stale load completion together with its generation', () => {
    const map = new PageMapCoordinator<Row>({ generation: 5 });
    const token = map.startLoad('earlier', 'request-5');
    expect(map.getSnapshot().loadState.earlier).toMatchObject({ status: 'loading', generation: 5 });

    map.reset();
    expect(map.finishLoad(token)).toBe(false);
    expect(map.getSnapshot().loadState.earlier).toMatchObject({ status: 'idle', generation: 6 });
  });

  it('evicts by absolute range while retaining page metadata and stable ids', () => {
    const map = new PageMapCoordinator<Row>({ generation: 3, total: 6 });
    map.applyPage(page(3, 4, [['m4', 'four'], ['m5', 'five']], { before: 4, total: 6, hasEarlier: true }));
    map.applyPage(page(3, 0, [['m0', 'zero'], ['m1', 'one']], { before: 0, total: 6, hasEarlier: false }));
    map.applyPage(page(3, 2, [['m2', 'two'], ['m3', 'three']], { before: 2, total: 6, hasEarlier: true }));

    const result = map.evict({ keep: { start: 2, end: 4 }, maxPages: 1, anchorIndex: 3 });
    expect(result.pages.map(item => item.range)).toEqual([{ start: 2, end: 4 }]);
    expect(result.pages[0]?.cursor).toEqual({ before: 2, total: 6, hasEarlier: true });
    expect(result.evictedBefore.map(item => item.range)).toEqual([{ start: 0, end: 2 }]);
    expect(result.evictedAfter.map(item => item.range)).toEqual([{ start: 4, end: 6 }]);
    expect(map.getSnapshot().messages.map(item => item.messageId)).toEqual(['m2', 'm3']);
    expect(map.getSnapshot().loadedRanges).toEqual([{ start: 2, end: 4 }]);
  });

  it('does not mutate the map for an eviction request from an old generation', () => {
    const map = new PageMapCoordinator<Row>({ generation: 2, total: 2 });
    map.applyPage(page(2, 0, [['m0', 'zero'], ['m1', 'one']]));
    map.reset();
    map.applyPage(page(3, 0, [['new', 'new']]));

    const result = map.evict({ generation: 2, keep: { start: 0, end: 1 } });
    expect(result.evicted).toEqual([]);
    expect(map.getSnapshot().messages.map(item => item.messageId)).toEqual(['new']);
  });

  it('locates a loaded message at its absolute page index and returns nothing after eviction', () => {
    const map = new PageMapCoordinator<Row>({ generation: 7, total: 8 });
    map.applyPage(page(7, 4, [['m4', 'four'], ['m5', 'five']]));
    map.applyPage(page(7, 0, [['m0', 'zero'], ['m1', 'one']]));
    expect(map.locateMessage('m5')).toMatchObject({
      messageId: 'm5',
      index: 5,
      range: { start: 4, end: 6 }
    });
    expect(map.locateMessage('missing')).toBeUndefined();

    map.evict({ keep: { start: 0, end: 2 }, maxPages: 1, anchorIndex: 1 });
    expect(map.locateMessage('m5')).toBeUndefined();
  });
});
