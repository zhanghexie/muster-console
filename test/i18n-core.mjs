/**
 * i18n 核心行为回归：中文插值、英文翻译、缺词条回退、系统语言解析。
 * 背景：i18next 对 missing-key 回退的 key 不做插值，所以 shared/i18n 给 zh-CN
 * 注册身份资源（key→key）让中文走正常翻译命中；这里锁死该行为。
 * 运行: node test/i18n-core.mjs（需仓库 node_modules 里的 i18next，助手自带 shim）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-core-'));
const compile = createSharedCompiler(root, tmp);
const mod = await import(pathToFileURL(compile('shared/i18n/index.ts')).href);
const { t, applyLocaleSetting, resolveSystemLocale, getResolvedLocale } = mod;

// 1) 默认中文：key 即中文，插值正常替换（身份资源路径）
assert.equal(t('归档 · {{n}}', { n: 3 }), '归档 · 3', 'zh 插值');

// 2) 英文：词条命中
applyLocaleSetting('en');
assert.equal(getResolvedLocale(), 'en');
assert.equal(t('归档 · {{n}}', { n: 3 }), 'Archived · 3', 'en 翻译');
assert.equal(t('技能归并未完成，请检查恢复清单：{{path}}', { path: '/fixture/manifest' }), 'Skill consolidation is incomplete. Check the recovery manifest: /fixture/manifest');
assert.equal(t('滚动{{name}}列表', { name: 'Inbox' }), 'Scroll the Inbox list');
assert.equal(t('交互状态保存失败'), 'Failed to save interactive state');

// 3) en 缺词条 → 回退中文（身份资源），插值仍替换
assert.equal(t('这句没词条 {{n}}', { n: 7 }), '这句没词条 7', 'en 缺词条回退中文并插值');

// 4) 两边都没有的 key → 返回 key 本身（显示中文）
assert.equal(t('完全不存在的东西'), '完全不存在的东西');

// 5) 系统语言解析
assert.equal(resolveSystemLocale('zh-CN'), 'zh-CN');
assert.equal(resolveSystemLocale('zh-TW'), 'zh-CN');
assert.equal(resolveSystemLocale('en-US'), 'en');
assert.equal(resolveSystemLocale('ja'), 'en');
assert.equal(applyLocaleSetting('system', 'zh-CN'), 'zh-CN');
assert.equal(applyLocaleSetting('system', 'en-US'), 'en');

// 6) count 选项禁用：传 count 会触发 i18next 复数后缀（key_other 查不到即裸 key），
//    全仓规约是改用 {{n}}（test/i18n-coverage 扫 count 之外，这里锁运行时行为）
applyLocaleSetting('zh-CN');
assert.notEqual(t('归档 · {{n}}', { count: 3 }), '归档 · {{count}}', '不应出现未插值的占位符');

console.log('i18n-core: all assertions passed');
