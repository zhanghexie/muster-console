import { afterEach, expect, it } from 'vitest';
import { applyLocaleSetting } from '../../../src/shared/i18n';
import { localizeKnowledgeHostText } from '../../../src/shared/knowledgeDisplayText';
import { assertKnowledgeDirectory } from '../../../src/main/memory/layout';
import { localizeKnowledgeUserError } from '../../../src/main/memory/knowledgeUserErrors';

afterEach(() => applyLocaleSetting('zh-CN'));

it('localizes a real memory containment error at the user boundary without changing the cause', () => {
  let original!: Error;
  try { assertKnowledgeDirectory('fixture-root', 'outside'); } catch (error) { original = error as Error; }
  expect(original.message).toBe('记忆目录越界');
  applyLocaleSetting('en');
  let translated: Error | undefined;
  try { localizeKnowledgeUserError(original); } catch (error) { translated = error as Error; }
  expect(translated?.message).toBe('The memory directory is outside its allowed root.');
  expect(translated?.cause).toBe(original);
  expect(localizeKnowledgeHostText('记忆目录不能经过符号链接')).toBe('The memory directory cannot pass through a symbolic link.');
  expect(localizeKnowledgeHostText('记忆控制目录不能是符号链接')).toBe('The memory control directory cannot be a symbolic link.');
  expect(localizeKnowledgeHostText('未知外部错误')).toBe('未知外部错误');
  expect(original.message).toBe('记忆目录越界');
});
