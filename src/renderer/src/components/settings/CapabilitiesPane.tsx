import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CapabilitiesView } from '../../../../shared/types';
import { SettingsViews } from './SettingsViews';
import type { AgentRule } from '../../../../shared/agentConduct';
import { FieldRow, SettingRow, SettingsRows, SettingsSection, Switch } from './shared';


/** 「调度 Agent」页：调度提示词与全局行为规约可编辑，其余为只读参考，运行信息独立导航 */
export function CapabilitiesPane({
  capView,
  promptDraft,
  promptUsingDefault,
  onPromptChange,
  onPromptReset,
  rules,
  onRulesChange,
  focusItem,
  focusRequest
}: {
  focusItem?: string;
  focusRequest?: number;
  capView: CapabilitiesView | null;
  promptDraft: string;
  promptUsingDefault: boolean;
  onPromptChange: (v: string) => void;
  onPromptReset: () => void;
  rules: AgentRule[];
  onRulesChange: (rules: AgentRule[]) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [showFullPreview, setShowFullPreview] = useState(false);
  // 提示词/规则默认只读展示（一行摘要），点「编辑」才进入编辑态——防误触
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleBackup, setRuleBackup] = useState('');

  if (!capView) return <p className="settings-hint">{t('加载能力信息…')}</p>;

  const promptBody = promptDraft.trim() || capView.dispatcher.defaultBody;

  return (
    <div className="settings-section cap-pane">
      <SettingsViews requestKey={focusRequest} label={t('调度 Agent 配置内容')} requestedView={focusItem && ['cap-injections', 'cap-allowlist', 'cap-init'].includes(focusItem) ? 'reference' : focusItem ? 'behavior' : undefined} views={[{ id: 'behavior', label: t('提示词与规则'), content: <>

      <SettingsSection
        title={t('调度提示词')}
        side={
          <>
            <span className={`s-tag${promptUsingDefault ? '' : ' warn'}`}>
              {promptUsingDefault ? t('使用内置默认') : t('已自定义')}
            </span>
            {editingPrompt ? (
              <>
                <button type="button" className="btn ghost tiny" onClick={() => setShowFullPreview((v) => !v)}>
                  {showFullPreview ? t('隐藏完整预览') : t('查看完整预览')}
                </button>
                <button type="button" className="btn tiny" onClick={onPromptReset}>
                  {t('恢复默认')}
                </button>
                <button type="button" className="btn primary tiny" onClick={() => setEditingPrompt(false)}>
                  {t('完成')}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn ghost tiny" onClick={() => setShowFullPreview((v) => !v)}>
                  {showFullPreview ? t('隐藏完整预览') : t('查看完整预览')}
                </button>
                <button type="button" className="btn tiny" onClick={() => setEditingPrompt(true)}>
                  {t('编辑')}
                </button>
              </>
            )}
          </>
        }
        item="cap-prompt"
      >
        <SettingsRows>
          {editingPrompt ? (
            <>
              <FieldRow label={t('正文')} tip={t('只编辑正文；Catalog 摘要会在运行时自动拼接，无需也不应手写进正文。')}>
                <textarea
                  className="s-input cap-prompt-editor"
                  rows={12}
                  autoFocus
                  value={promptDraft}
                  onChange={(e) => onPromptChange(e.target.value)}
                />
              </FieldRow>
            </>
          ) : (
            <SettingRow
              title={t('提示词正文')}
              desc={<span className="cap-prompt-line" title={promptBody}>{promptBody.split('\n')[0]}</span>}
            >
              {null}
            </SettingRow>
          )}
          {showFullPreview ? (
            <SettingRow stacked title={t('完整预览')}>
              <pre className="cap-preview">
                {`${promptBody}\n\n${capView.dispatcher.catalogAppendix}`}
              </pre>
            </SettingRow>
          ) : null}
        </SettingsRows>
      </SettingsSection>

      <SettingsSection
        title={t('全局行为规约')}
        side={
          <>
            <span className="s-tag">{t('{{n}} 条规则', { n: rules.length })}</span>
            <button
              type="button"
              className="btn tiny"
              onClick={() => {
                // F-02：Date.now() 同毫秒连点会碰撞（React key 冲突 + 按 id 定位误伤两张卡），加随机后缀
                const id = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                onRulesChange([...rules, { id, text: '', enabled: true }]);
                setRuleBackup('');
                setEditingRuleId(id);
              }}
            >
              {t('添加规则')}
            </button>
          </>
        }
        desc={t(
          '应用于调度、内置 Agent 与外部 CLI。'
        )}
        item="cap-rules"
      >
        <SettingsRows>
          {rules.length === 0 && (
            <p className="settings-hint" style={{ margin: '4px 0 0' }}>
              {t('暂无规则。规则删空 = 关闭注入，各 Agent 面不再出现该节。')}
            </p>
          )}
          {rules.map((rule, idx) => {
            const editing = editingRuleId === rule.id;
            return (
              <div className="cap-rule-row" key={rule.id}>
                <SettingRow
                  title={
                    <>
                      {t('规则 {{n}}', { n: idx + 1 })}
                      {!rule.enabled && <span className="s-tag warn">{t('已停用')}</span>}
                    </>
                  }
                  desc={
                    editing ? undefined : (
                      <span className="cap-rule-line" title={rule.text}>
                        {rule.text.trim() ? rule.text.split('\n')[0] : t('（空规则）')}
                      </span>
                    )
                  }
                >
                  {editing ? (
                    <>
                      <button type="button" className="btn ghost tiny" onClick={() => {
                        // F-02：取消时备份为空（新建未输入）直接移除该行——提交前不再残留「（空规则）」卡
                        if (!ruleBackup.trim()) {
                          onRulesChange(rules.filter((r) => r.id !== rule.id));
                        } else {
                          onRulesChange(rules.map((r) => (r.id === rule.id ? { ...r, text: ruleBackup } : r)));
                        }
                        setEditingRuleId(null);
                      }}>
                        {t('取消')}
                      </button>
                      <button type="button" className="btn primary tiny" onClick={() => setEditingRuleId(null)}>
                        {t('完成')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="btn ghost tiny" onClick={() => {
                        setRuleBackup(rule.text);
                        setEditingRuleId(rule.id);
                      }}>
                        {t('编辑')}
                      </button>
                      <button
                        type="button"
                        className="btn ghost tiny"
                        style={{ color: 'var(--status-danger-fg)' }}
                        onClick={() => {
                          if (editing) setEditingRuleId(null);
                          onRulesChange(rules.filter((r) => r.id !== rule.id));
                        }}
                      >
                        {t('删除规则')}
                      </button>
                      <Switch
                        label={t('规则 {{n}}', { n: idx + 1 })}
                        checked={rule.enabled}
                        onChange={(v) =>
                          onRulesChange(rules.map((r) => (r.id === rule.id ? { ...r, enabled: v } : r)))
                        }
                      />
                    </>
                  )}
                </SettingRow>
                {editing ? (
                  <textarea
                    className="s-input"
                    rows={5}
                    autoFocus
                    value={rule.text}
                    onChange={(e) =>
                      onRulesChange(
                        rules.map((r) => (r.id === rule.id ? { ...r, text: e.target.value } : r))
                      )
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </SettingsRows>
      </SettingsSection>

      </> }, { id: 'reference', label: t('运行信息'), content: <>
        <SettingsSection item="cap-injections" title={t('注入清单')}>
          <p className="settings-hint" style={{ margin: '0 0 8px' }}>
            {t(
              'A3 注入注册表：应用当前登记的全部提示词/上下文注入点。新增注入必须先在 src/main/agent/injection-registry.ts 登记。'
            )}
          </p>
          <ul className="cap-tool-list">
            {capView.injections.map((s) => (
              <li key={s.id}>
                <span className="cap-tool-name">{s.id}</span>
                <span className="cap-tool-desc">
                  {t('目标 {{target}} · 通道 {{channel}} · {{mode}} · 压缩后{{survives}}', {
                    target: s.target,
                    channel: s.channel,
                    mode: s.mode === 'always' ? t('恒注入') : t('条件注入'),
                    survives: s.survivesCompact ? t('保留') : t('不保留')
                  })}
                  {' · '}
                  {t(s.note)}
                </span>
              </li>
            ))}
          </ul>
        </SettingsSection>
        <SettingsSection item="cap-allowlist" title={t('Worker 白名单')}>
          <p className="settings-hint" style={{ margin: '0 0 8px' }}>
            {t('Worker 经本机 Shell API 仅可调用下列工具，其余编排能力由调度 Agent 执行。')}
          </p>
          <ul className="cap-tool-list">
            {capView.workerToolAllowlist.map((name) => (
              <li key={name}>
                <span className="cap-tool-name">{name}</span>
              </li>
            ))}
          </ul>
        </SettingsSection>
        <SettingsSection item="cap-init" title={t('Pi 初始化')}>
          <ul className="cap-init-list">
            {capView.dispatcher.initNotes.map((n) => (
              <li key={n}>{t(n)}</li>
            ))}
          </ul>
        </SettingsSection>
      </> }]} />
    </div>
  );
}
