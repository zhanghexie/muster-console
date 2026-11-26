import React, { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  parseUiFontId,
  uiFontSansStack,
  type UiFontScale
} from '../../../../shared/appearanceFonts';
import { getUiFont, setUiFont, subscribeUiFont } from '../../uiFont';
import { CustomSelect } from '../CustomSelect';
import { Segmented, SettingRow } from './shared';

/** 字体预览样本（固定内容，不翻） */
const PREVIEW_SAMPLE = '敏捷的棕色狐狸跳过懒狗 The quick brown fox 0123456789';

const SCALE_OPTIONS: { id: UiFontScale; labelKey: string }[] = [
  { id: 'compact', labelKey: '紧凑' },
  { id: 'standard', labelKey: '标准' },
  { id: 'comfortable', labelKey: '宽松' }
];

/**
 * 通用页「字体」设置行：字体族四档（OPPO Sans 默认 / MiSans / HarmonyOS Sans / 跟随系统）
 * + 字号三档（紧凑/标准/宽松，整体平移字阶 token）+ 预览。选中即生效并落盘，不随表单草稿回写。
 * 输出若干 SettingRow，由调用方放进 SettingsCard。
 */
export function FontSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const { font, scale } = useSyncExternalStore(subscribeUiFont, getUiFont);

  return (
    <>
      <SettingRow item="appearance-font" title={t('字体')} desc={t('中文部分也会用在编辑器和代码块里')}>
        <CustomSelect
          className="s-select"
          value={font}
          ariaLabel={t('字体族')}
          onChange={(v) => setUiFont({ font: parseUiFontId(v), scale })}
          options={[
            { value: 'oppo', label: 'OPPO Sans' },
            { value: 'misans', label: 'MiSans' },
            { value: 'harmonyos', label: 'HarmonyOS Sans' },
            { value: 'system', label: t('跟随系统') }
          ]}
        />
      </SettingRow>
      <SettingRow title={t('字号')} desc={t('整体调整界面字号，终端不跟随')}>
        <Segmented
          label={t('字号')}
          value={scale}
          options={SCALE_OPTIONS.map((s) => ({ value: s.id, label: t(s.labelKey) }))}
          onChange={(v) => setUiFont({ font, scale: v })}
        />
      </SettingRow>
      <div className="s-row s-row-preview">
        <p className="font-preview" style={{ fontFamily: uiFontSansStack(font) }}>
          {PREVIEW_SAMPLE}
        </p>
      </div>
    </>
  );
}
