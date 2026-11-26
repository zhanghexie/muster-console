import { ErrorTip } from '../ErrorTip';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppConfig, TextToolFunction, TextToolsConfig } from '../../../../shared/types';
import {
  DEFAULT_TRANSLATE_FUNCTION,
  TEXT_TOOL_AI_META_PROMPT
} from '../../../../shared/textTools';
import { SettingsViews } from './SettingsViews';
import { SettingsDetailHeader } from './SettingsDetailHeader';
import { CustomSelect, type SelectOption } from '../CustomSelect';
import { FieldRow, SettingRow, SettingsRows, SettingsSection, Switch } from './shared';

/** 下拉 value 里的 provider/model 复合编码（provider id 不含冒号场景足够） */
const MODEL_SEP = '::';

function newToolId(): string {
  return `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 「文本工具」页：划词浮条的自定义 AI 功能（名称 + 提示词 + 模型）。
 * 全部随底部「保存」生效；内置翻译可恢复。功能列表与编辑区分开，切换保留草稿。
 */
export function TextToolsPane({
  cfg,
  set
}: {
  cfg: AppConfig;
  set: (patch: Partial<AppConfig>) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const tt: TextToolsConfig = cfg.textTools ?? { functions: [] };
  const functions = tt.functions;

  const [aiDesc, setAiDesc] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [openId, setOpenId] = useState('');
  const open = functions.find((f) => f.id === openId) ?? null;

  const providers = cfg.llm?.providers ?? [];
  const hasTranslate = functions.some((f) => f.id === DEFAULT_TRANSLATE_FUNCTION.id);

  const update = (updater: (prev: TextToolsConfig) => TextToolsConfig): void => {
    set({ textTools: updater(structuredClone(cfg.textTools ?? { functions: [] })) });
  };

  const patchFunction = (id: string, patch: Partial<TextToolFunction>): void => {
    update((prev) => ({
      ...prev,
      functions: prev.functions.map((f) => (f.id === id ? { ...f, ...patch } : f))
    }));
  };

  const modelOptions = (emptyLabel: string): SelectOption[] => {
    const opts: SelectOption[] = [{ value: '', label: emptyLabel }];
    for (const p of providers) {
      for (const m of p.models) {
        opts.push({
          value: `${p.id}${MODEL_SEP}${m.id}`,
          label: m.name || m.id,
          group: p.name || p.id
        });
      }
    }
    return opts;
  };

  const pairValue = (providerId?: string, modelId?: string): string =>
    providerId && modelId ? `${providerId}${MODEL_SEP}${modelId}` : '';

  /** 把 "provider::model" 复合值写进功能项；空值 = 清空（跟随默认） */
  const setFnPair = (target: TextToolFunction, value: string): TextToolFunction => {
    if (!value) {
      delete target.providerId;
      delete target.modelId;
    } else {
      const [providerId, modelId] = value.split(MODEL_SEP);
      target.providerId = providerId;
      target.modelId = modelId;
    }
    return target;
  };

  const addFunction = (): void => {
    const id = newToolId();
    update((prev) => ({
      ...prev,
      functions: [...prev.functions, { id, name: t('新功能'), prompt: '', enabled: true }]
    }));
    setOpenId(id);
  };

  const restoreTranslate = (): void => {
    update((prev) => ({
      ...prev,
      functions: [...prev.functions, structuredClone(DEFAULT_TRANSLATE_FUNCTION)]
    }));
    setOpenId(DEFAULT_TRANSLATE_FUNCTION.id);
  };

  const removeFunction = (id: string): void => {
    update((prev) => ({ ...prev, functions: prev.functions.filter((f) => f.id !== id) }));
    if (open?.id === id) setOpenId('');
  };

  const handleAiGenerate = async (): Promise<void> => {
    const desc = aiDesc.trim();
    if (!desc || aiBusy) return;
    setAiBusy(true);
    setAiError('');
    try {
      const res = await window.api.textTools.run({
        name: 'AI 助手',
        prompt: TEXT_TOOL_AI_META_PROMPT,
        text: desc
      });
      const raw = res.text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '');
      const parsed = JSON.parse(raw) as { name?: unknown; prompt?: unknown };
      const name = typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 40) : '';
      const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
      if (!name || !prompt) throw new Error(t('AI 返回缺少 name/prompt'));
      const id = newToolId();
      update((prev) => ({
        ...prev,
        functions: [...prev.functions, { id, name, prompt, enabled: true }]
      }));
      setOpenId(id);
      setAiDesc('');
    } catch (e) {
      setAiError(
        (e as Error).message.includes('未配置')
          ? (e as Error).message
          : t('生成失败：{{message}}', { message: (e as Error).message })
      );
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <>
      <SettingsSection title={t('默认模型')}>
        <SettingsRows>
          <SettingRow
            item="textTools-default-model"
            title={t('功能默认模型')}
            desc={t('功能未单独指定模型时用它；仍为空则用「模型服务商」页的全局默认')}
          >
            <CustomSelect
              className="s-select is-wide"
              ariaLabel={t('功能默认模型')}
              value={pairValue(tt.defaultProviderId, tt.defaultModelId)}
              onChange={(v) =>
                update((prev) => {
                  if (!v) {
                    delete prev.defaultProviderId;
                    delete prev.defaultModelId;
                  } else {
                    const [providerId, modelId] = v.split(MODEL_SEP);
                    prev.defaultProviderId = providerId;
                    prev.defaultModelId = modelId;
                  }
                  return prev;
                })
              }
              options={modelOptions(t('跟随全局默认'))}
            />
          </SettingRow>
        </SettingsRows>
      </SettingsSection>

      <SettingsSection
        title={t('功能')}
        side={
          <>
            {!hasTranslate ? (
              <button type="button" className="btn ghost tiny" onClick={restoreTranslate}>
                {t('恢复内置翻译')}
              </button>
            ) : null}
            <button type="button" className="btn tiny" onClick={addFunction}>
              {t('添加功能')}
            </button>
          </>
        }
      >
        {aiError ? <ErrorTip message={aiError} /> : null}


        <SettingsRows>
          <FieldRow
            label={t('AI 帮写')}
            tip={t('描述想要的功能，自动生成名称和提示词')}
          >
            <div className="worktree-storage-row">
              <input
                type="text"
                className="s-input"
                placeholder={t('如：把会议记录整理成要点表格')}
                value={aiDesc}
                onChange={(e) => setAiDesc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleAiGenerate();
                }}
              />
              <button
                type="button"
                className="btn primary tiny"
                disabled={aiBusy || !aiDesc.trim()}
                onClick={() => void handleAiGenerate()}
              >
                {aiBusy ? t('生成中…') : t('AI 帮写')}
              </button>
            </div>
          </FieldRow>
          {functions.length > 0 && <SettingsViews navigation="list" label={t('文本功能')} requestedView={open?.id} views={functions.map(f => ({
            id: f.id, label: f.name || t('(未命名)'), content: <section className="tt-editor" data-testid={`tt-item-${f.id}`}>
                <SettingsDetailHeader title={f.name || t('(未命名)')}/>
                <div className="tt-editor-body">
                  <SettingRow title={t('在浮条显示')} desc={t('关掉后划词浮条不再出现这个功能')}>
                    <Switch
                      label={t('在浮条显示')}
                      checked={f.enabled !== false}
                      onChange={(v) => patchFunction(f.id, { enabled: v })}
                    />
                  </SettingRow>
                  <FieldRow label={t('名称')} tip={t('浮条按钮文字')}>
                    <input
                      type="text"
                      className="s-input"
                      style={{ maxWidth: 280 }}
                      value={f.name}
                      maxLength={20}
                      placeholder={t('如：翻译 / 整理成表格')}
                      onChange={(e) => patchFunction(f.id, { name: e.target.value })}
                    />
                  </FieldRow>
                  <SettingRow title={t('模型')} desc={t('跟随功能默认模型')}>
                    <CustomSelect
                      className="s-select"
                      ariaLabel={t('功能模型')}
                      value={pairValue(f.providerId, f.modelId)}
                      onChange={(v) =>
                        update((prev) => ({
                          ...prev,
                          functions: prev.functions.map((x) =>
                            x.id === f.id ? setFnPair({ ...x }, v) : x
                          )
                        }))
                      }
                      options={modelOptions(t('跟随功能默认模型'))}
                    />
                  </SettingRow>
                  <SettingRow
                    title={t('关闭思考')}
                    desc={t('对支持的模型附加关闭深度思考的参数（通义/GLM/豆包/GPT-5/o 系等）；DeepSeek reasoner 无此开关，请选非思考版模型')}
                  >
                    <Switch
                      label={t('关闭思考')}
                      checked={f.noThinking !== false}
                      onChange={(v) => patchFunction(f.id, { noThinking: v })}
                    />
                  </SettingRow>
                  <FieldRow
                    label={t('提示词（system）')}
                    tip={f.prompt.trim() ? t('选中的文字会作为 user 消息发给模型；提示词描述处理规则，模型只返回处理结果') : t('提示词为空时该功能点击不会生效')}
                  >
                    <textarea
                      className="s-input tt-prompt"
                      rows={6}
                      value={f.prompt}
                      placeholder={t('描述如何处理输入的文字，并要求只输出处理结果。例如：去掉语气词和重复表达，输出精简后的原话。')}
                      onChange={(e) => patchFunction(f.id, { prompt: e.target.value })}
                    />
                  </FieldRow>
                  <SettingRow divided title={<span className="s-muted">{t('删除后浮条里不再出现')}</span>}>
                    <button type="button" className="btn danger tiny" onClick={() => removeFunction(f.id)}>
                      {t('删除功能')}
                    </button>
                  </SettingRow>
                </div>
              </section>
          }))}/>}
          {!functions.length ? (
            <p className="settings-hint" style={{ margin: '8px 0 0' }}>
              {t('还没有功能，点上方「添加功能」或「AI 帮写」')}
            </p>
          ) : null}
        </SettingsRows>
      </SettingsSection>
    </>
  );
}
