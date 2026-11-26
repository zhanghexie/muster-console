import { afterEach, expect, it } from 'vitest';
import { confirmActionLabel } from '../../src/shared/confirmDialog';
import { applyLocaleSetting } from '../../src/shared/i18n';

afterEach(() => { applyLocaleSetting('zh-CN'); });

it('translates known confirmation actions while retaining unknown action text', () => {
  applyLocaleSetting('en');
  expect(confirmActionLabel('启用')).toBe('Confirm Enable');
  expect(confirmActionLabel('停用')).toBe('Confirm Disable');
  expect(confirmActionLabel('外部操作')).toBe('Confirm 外部操作');
  applyLocaleSetting('zh-CN');
  expect(confirmActionLabel('启用')).toBe('确认启用');
});
