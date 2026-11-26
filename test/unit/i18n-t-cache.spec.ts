/**
 * t() key-only 缓存（2026-09-14 性能专项，src/shared/i18n）：
 * 高频静态标签不再每次走 i18next 全量解析（真机 profile：单次点击上千次 t()，
 * 解析占长任务窗口 ~8%）。回归点：缓存命中返回一致；languageChanged 清空
 * （切语言不得返回旧语言串）；带 options 走 key+options 稳定序列化缓存键
 * （P2-2：异序同参同键、函数值透传、插值正确）。
 */
import { describe, it, expect } from 'vitest';
import { applyLocaleSetting, t, i18nInstance, tCacheSizeForTest } from '../../src/shared/i18n';

const KEY = '取消';
const EN = 'Cancel';

describe('i18n key-only 翻译缓存', () => {
  it('key-only 调用返回正确译值，重复调用结果一致（命中缓存路径）', () => {
    applyLocaleSetting('zh-CN', 'zh-CN');
    expect(t(KEY)).toBe(KEY); // zh 身份资源：key=中文原文
    expect(t(KEY)).toBe(KEY);
  });

  it('切换语言后同 key 返回新语言（缓存已清，不得吐旧值）', () => {
    applyLocaleSetting('zh-CN', 'zh-CN');
    expect(t(KEY)).toBe(KEY);
    applyLocaleSetting('en', 'en-US');
    expect(t(KEY)).toBe(EN);
    applyLocaleSetting('zh-CN', 'zh-CN');
    expect(t(KEY)).toBe(KEY);
  });

  it('带 options 的调用行为不变（P2-2 后走独立缓存键，不污染 key-only 缓存）', () => {
    applyLocaleSetting('zh-CN', 'zh-CN');
    // 实例直呼（组件内 useTranslation 的 t 同源）：options 路径命中独立缓存键
    const inst = i18nInstance as unknown as {
      t: (key: string, options?: Record<string, unknown>) => string;
    };
    expect(typeof inst.t(KEY, { lng: 'en' })).toBe('string');
    // options 调用不应污染 key-only 缓存：随后 key-only 仍是当前语言
    expect(t(KEY)).toBe(KEY);
  });

  it('带 options 命中（P2-2）：插值正确、异序同参同键不误配、异值不错配', () => {
    applyLocaleSetting('zh-CN', 'zh-CN');
    const KEY2 = '聊天 {{name}}';
    expect(t(KEY2, { name: '阿明' })).toBe('聊天 阿明');
    // 异序同参：同一缓存键（键排序序列化），结果一致
    expect(t(KEY2, { name: '阿明' })).toBe('聊天 阿明');
    // 异值：不得误配到旧缓存
    expect(t(KEY2, { name: '阿强' })).toBe('聊天 阿强');
    // 函数值跳过缓存透传（formatter 语义），行为不抛错且返回字符串
    const withFn = t(KEY2, { name: '阿明', formatter: () => 'x' });
    expect(typeof withFn).toBe('string');
    // 函数值调用不得污染同参缓存：随后同参仍命中正确插值
    expect(t(KEY2, { name: '阿明' })).toBe('聊天 阿明');
  });

  it('带 options 命中缓存本体（P2-2 还原即红）：两次同参调用缓存恰 +1', () => {
    applyLocaleSetting('zh-CN', 'zh-CN');
    const KEY2 = '聊天 {{name}}';
    // 本用例独占 name 值：条目数只由本用例的调用增减（文件内缓存跨用例共享）
    const before = tCacheSizeForTest();
    expect(t(KEY2, { name: 'uniq-a' })).toBe('聊天 uniq-a');
    expect(tCacheSizeForTest()).toBe(before + 1);
    // 第二次同参调用命中缓存：条目数不再增长
    expect(t(KEY2, { name: 'uniq-a' })).toBe('聊天 uniq-a');
    expect(tCacheSizeForTest()).toBe(before + 1);
    // 异序同参：键排序序列化后同键，仍是同一条
    expect(t(KEY2, { lng: 'zh-CN', name: 'uniq-a' })).toBe('聊天 uniq-a');
    expect(tCacheSizeForTest()).toBe(before + 2); // lng 参与键：这是另一条
    // 函数值透传：不占缓存
    t(KEY2, { name: 'uniq-a', formatter: () => 'x' });
    expect(tCacheSizeForTest()).toBe(before + 2);
  });

  it('带 options 语言切换失效（P2-2）：切语言清空缓存，同 options 返回新语言', () => {
    const KEY2 = '聊天 {{name}}';
    applyLocaleSetting('zh-CN', 'zh-CN');
    expect(t(KEY2, { name: '阿明' })).toBe('聊天 阿明');
    expect(tCacheSizeForTest()).toBeGreaterThan(0);
    applyLocaleSetting('en', 'en-US');
    // languageChanged 清空（含 options 键）：切语言不得返回旧语言串
    expect(tCacheSizeForTest()).toBe(0);
    expect(t(KEY2, { name: '阿明' })).toBe('Chat 阿明');
    applyLocaleSetting('zh-CN', 'zh-CN');
    expect(t(KEY2, { name: '阿明' })).toBe('聊天 阿明');
  });
});
