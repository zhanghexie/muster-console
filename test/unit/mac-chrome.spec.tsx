import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMacChrome } from '../../src/renderer/src/macChrome';
import { currentApiMock } from './helpers/api-mock';

const root = document.documentElement;

describe('macOS 顶栏让位（installMacChrome）', () => {
  beforeEach(() => {
    root.classList.remove('is-mac', 'is-native-fullscreen');
  });
  afterEach(() => {
    root.classList.remove('is-mac', 'is-native-fullscreen');
  });

  it('挂载即加 is-mac，并跟随主进程全屏状态收回/恢复让位', () => {
    installMacChrome();
    expect(root.classList.contains('is-mac')).toBe(true);
    expect(root.classList.contains('is-native-fullscreen')).toBe(false);

    const { emit } = currentApiMock();
    emit('window:fullscreen', true);
    expect(root.classList.contains('is-native-fullscreen')).toBe(true);
    emit('window:fullscreen', false);
    expect(root.classList.contains('is-native-fullscreen')).toBe(false);
  });
});
