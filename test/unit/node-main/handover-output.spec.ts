import { expect, it } from 'vitest';
import { truncateToolOutput, truncateToolPayload } from '../../../src/main/handover/output';

it('按 JSON 转义后的 16 KiB 边界截断，并按原文 UTF-8 字节统计省略量', () => {
  expect(truncateToolOutput('a'.repeat(16 * 1024 - 2)).truncated).toBe(false);
  expect(truncateToolOutput('a'.repeat(16 * 1024 - 1)).truncated).toBe(true);
  expect(truncateToolOutput('\0'.repeat(3000)).truncated).toBe(true);
  const output = `开始${'🚀'.repeat(6000)}结束`;
  const result = truncateToolOutput(output);
  expect(result.truncated).toBe(true);
  const parts = result.value.match(/^([\s\S]*)\n\n\[交接快照：工具输出已截断，原始 (\d+) 字节，省略 (\d+) 字节（UTF-8）\]\n\n([\s\S]*)$/)!;
  expect(parts[1]).toMatch(/^开始/);
  expect(parts[4]).toMatch(/结束$/);
  expect(parts[1] + parts[4]).not.toContain('�');
  expect(Number(parts[2])).toBe(Buffer.byteLength(output));
  expect(Number(parts[3])).toBe(Buffer.byteLength(output) - Buffer.byteLength(parts[1]) - Buffer.byteLength(parts[4]));
  expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThan(16 * 1024);
});

it('短结构化结果保持原样，过长结果明确标识其序列化格式', () => {
  const small = [{ type: 'text', text: '原始内容' }];
  expect(truncateToolPayload(small)).toEqual({ value: small, truncated: false });
  const large = [{ type: 'text', text: `头${'x'.repeat(20000)}尾` }];
  const result = truncateToolPayload(large);
  expect(result.truncated).toBe(true);
  expect(result.value).toContain('原工具输出为 JSON');
  expect(result.value).toContain('工具输出已截断');
  expect(large[0].text).toHaveLength(20002);
});
