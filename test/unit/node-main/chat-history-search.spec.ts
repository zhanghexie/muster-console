import { describe, it, expect } from 'vitest';
import { searchHistoryPages } from '../../../src/main/chatHistorySearch';

describe('paged history search', () => {
  it('finds unloaded early messages with bounded pages and snippet-only results', async () => {
    const requests: number[] = [];
    const total = 10000;
    const result = await searchHistoryPages((before = total, limit) => {
      requests.push(limit);
      const start = Math.max(0, before - limit);
      return { before: start, total, messages: Array.from({ length: before - start }, (_, index) => ({
        id: `m${start + index}`, role: 'assistant' as const,
        content: start + index === 3 || start + index === 9999 ? 'needle ' + 'body'.repeat(500) : 'unrelated'
      })) };
    }, 'needle', { id: 's', name: 'S' }, () => true);
    expect(result.hits.map(hit => hit.messageId)).toEqual(['m3', 'm9999']);
    expect(result.hits.map(hit => hit.messageIndex)).toEqual([3, 9999]);
    expect(Math.max(...requests)).toBe(120);
    expect(JSON.stringify(result).length).toBeLessThan(1000);
  });

  it('stops after cancellation before reading another page', async () => {
    let active = true, reads = 0;
    const result = await searchHistoryPages((before = 1000, limit) => {
      reads++;
      if (reads === 2) active = false;
      return { before: before - limit, total: 1000, messages: [{ id: 'm', role: 'user', content: 'hit' }] };
    }, 'hit', { id: 's', name: 'S' }, () => active);
    expect(reads).toBe(2);
    expect(result.hits).toEqual([]);
  });

  it('reports truncation and refuses ordinal drift after a clear', async () => {
    const result = await searchHistoryPages((before = 1) => ({ before: 0, total: 1,
      messages: before ? [{ id: 'many', role: 'assistant', content: 'hit '.repeat(2100) }] : []
    }), 'hit', { id: 's', name: 'S' }, () => true);
    expect(result.hits).toHaveLength(2000);
    expect(result.truncated).toBe(true);
    let first = true;
    await expect(searchHistoryPages(() => {
      if (first) { first = false; return { before: 999, total: 1000, messages: [] }; }
      return { before: 0, total: 0, messages: [] };
    }, 'hit', { id: 's', name: 'S' }, () => true)).rejects.toThrow(/changed during search/);
  });
});
