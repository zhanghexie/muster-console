import { DEFAULT_FEEDBACK_TARGET } from '../../src/shared/feedback';
import { browserHomeUrl, isBrowserHomeUrl } from '../../src/shared/browserHome';
import { uiSessionPageUrl, uiSessionPageId } from '../../src/shared/uiSessionPage';
import { parseWorkspaceFileHref, WORKSPACE_FILE_LINK_SCHEME } from '../../src/shared/linkifyWorkspacePaths';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_APP_ID,
  PRODUCT_BRAND,
  PRODUCT_CLI_EXECUTABLE,
  PRODUCT_CLI_HOME_DIR,
  PRODUCT_CLI_HOME_ENV,
  PRODUCT_CLI_NAME,
  PRODUCT_EASTER_EGG,
  PRODUCT_EXECUTABLE_NAME,
  PRODUCT_INSTANCE_DIR_NAME,
  PRODUCT_NAME,
  PRODUCT_NAME_ZH,
  PRODUCT_PACKAGE_NAME,
  PRODUCT_SLOGAN,
  PRODUCT_STORAGE_DIR
} from '../../src/shared/productIdentity';

describe('Muster product identity', () => {
  it('uses the new product identity and isolated runtime names', () => {
    expect(DEFAULT_FEEDBACK_TARGET).toEqual({ provider: 'github', repository: 'https://github.com/zhanghexie/muster-console' });
    expect(PRODUCT_BRAND).toBe('Muster');
    expect(PRODUCT_NAME_ZH).toBe('集序');
    // 身份名必须纯 ASCII：它进 UA/安装器/日志，中文名只做界面展示（见 asciiUserAgent 注释）
    expect(PRODUCT_NAME).toBe('Muster Console');
    expect(/^[\x20-\x7e]+$/.test(PRODUCT_NAME)).toBe(true);
    expect(PRODUCT_SLOGAN).toBe('多多益善，集序有方。');
    expect(PRODUCT_EASTER_EGG).toContain('Han Xin');
    expect(PRODUCT_PACKAGE_NAME).toBe('muster-console');
    expect(PRODUCT_APP_ID).toBe('com.zhanghexie.muster.console');
    expect(PRODUCT_EXECUTABLE_NAME).toBe('MusterConsole');
    expect(PRODUCT_STORAGE_DIR).toBe('muster-console');
    expect(PRODUCT_INSTANCE_DIR_NAME).toBe('muster-console-instances');
    expect(PRODUCT_CLI_NAME).toBe('muster');
    expect(PRODUCT_CLI_EXECUTABLE).toBe('MusterConsole.exe');
    expect(PRODUCT_CLI_HOME_ENV).toBe('MUSTER_CLI_HOME');
    expect(PRODUCT_CLI_HOME_DIR).toBe('.muster-console-cli');
  });

  it('does not reuse the legacy application identity', () => {
    const values = [PRODUCT_PACKAGE_NAME, PRODUCT_APP_ID, PRODUCT_EXECUTABLE_NAME, PRODUCT_STORAGE_DIR, PRODUCT_INSTANCE_DIR_NAME];
    expect(values.join('\n')).not.toContain('metaagent-workbench');
  });
});


describe('Muster internal protocols', () => {
  it('creates distinct browser surfaces and rejects old product schemes', () => {
    expect(browserHomeUrl('new-tab')).toBe('muster-home://new/new-tab');
    expect(isBrowserHomeUrl(browserHomeUrl('new-tab'))).toBe(true);
    expect(isBrowserHomeUrl('metaagent-home://new/new-tab')).toBe(false);
    expect(uiSessionPageUrl('worker-1')).toBe('muster-ui://session/worker-1');
    expect(uiSessionPageId(uiSessionPageUrl('worker-1'))).toBe('worker-1');
    expect(uiSessionPageId('metaagent-ui://session/worker-1')).toBeNull();
  });

  it('opens new file links without accepting the old file protocol', () => {
    expect(WORKSPACE_FILE_LINK_SCHEME).toBe('muster-file:');
    expect(parseWorkspaceFileHref('muster-file:src%2Fmain.ts?line=42&col=7')).toEqual({ path: 'src/main.ts', line: 42, col: 7 });
    expect(parseWorkspaceFileHref('metaagent-file:src%2Fmain.ts')).toBeNull();
  });
});
