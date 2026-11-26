import assert from 'node:assert/strict';
import { scanJsxChinese } from './helpers/i18n-jsx-scan.mjs';
const sample = `
const node = <section aria-label="连接" title={t('已翻译')}>
  {t('已翻译')}未翻译<span title="提示">正文</span>
  {/* <p>注释</p> */}
  <a href="https://example.test/中文">{t('链接')}</a>
</section>;
`;
const result = scanJsxChinese(sample, 'sample.tsx');
assert.deepEqual(result.map(item => item.text), ['连接', '未翻译', '提示', '正文']);
assert.ok(result.every(item => item.line > 0));
assert.deepEqual(scanJsxChinese(`const x = <div>{t('已翻译')}<span aria-label={t('标签')}/></div>`, 'ok.tsx'), []);
assert.deepEqual(scanJsxChinese(`const x = <div>{enabled ? '直接文本' : t('已翻译')}<button aria-label={open ? '关闭' : t('打开')}/></div>`, 'branch.tsx').map(item => item.text), ['直接文本', '关闭']);
console.log('i18n-jsx-scan: catches raw JSX text and accessible labels even beside t(), ignores translated strings/comments');
