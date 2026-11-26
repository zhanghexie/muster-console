import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppConfig } from '../../../../shared/types';
import { parseHhmm, type NotifyPrefs } from '../../../../shared/notifyDecision';
import { usePresence } from '../motion';
import { SettingRow, SettingsRows, SettingsSection, Switch } from './shared';

/** 免打扰默认时段（夜间；支持跨零点，inDndWindow 按「含 start 不含 end」判定） */
const DEFAULT_DND = { start: '22:00', end: '08:00' };

/** 时段草稿是否可写入 prefs：两侧合法且不相等（相等=无效窗口，见 inDndWindow） */
function validDnd(start: string, end: string): boolean {
  const s = parseHhmm(start);
  const e = parseHhmm(end);
  return s !== null && e !== null && s !== e;
}

/**
 * 「通知」页（T1.4）：看板翻转推送（通知总线）的用户偏好。
 * - 按 phase 开关：needs_you 锁定开（产品规则：不可关）、done/error 可关（默认开）；
 * - 免打扰时段：启用开关 + acc 手风琴展开起止时间，只拦 done/error，needs_you 照推；
 * 草稿随设置页「保存」生效（cfg/set 管线，与 MCP 等页一致）。
 */
export function NotifyPane({
  cfg,
  set
}: {
  cfg: AppConfig;
  set: (patch: Partial<AppConfig>) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const prefs: NotifyPrefs = cfg.notify ?? {};
  // F-01 应用内兜底：系统 toast 是唯一通知出口，本机无通知能力（Linux 无 libnotify、
  // 组策略禁用等）时在此节顶部提示一次——needs_you 依赖左栏胶囊与看板列。
  // 探测失败按有能力处理（不误报），能力在本机不会动态变化，取值一次即可。
  const [noSystemNotify, setNoSystemNotify] = useState(false);
  useEffect(() => {
    let alive = true;
    window.api.notify.capability().then(ok => { if (alive) setNoSystemNotify(!ok); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const patchPrefs = (patch: Partial<NotifyPrefs>): void => {
    set({ notify: { ...cfg.notify, ...patch } });
  };

  // 时间草稿：挂载时 cfg 已就绪（设置页在 cfg 加载后才渲染页签），初值取现存窗口
  const [startDraft, setStartDraft] = useState(prefs.dnd?.start ?? DEFAULT_DND.start);
  const [endDraft, setEndDraft] = useState(prefs.dnd?.end ?? DEFAULT_DND.end);
  const dndOn = prefs.dnd != null;

  /** 免打扰已启用时，时间草稿一变就同步进 prefs（保证保存不丢输入）；
   *  无效窗口（任一侧非法 / 起止相同）只留草稿不同步，等合法再写。 */
  const syncDndDraft = (nextStart: string, nextEnd: string): void => {
    if (!dndOn) return;
    if (validDnd(nextStart, nextEnd)) patchPrefs({ dnd: { start: nextStart, end: nextEnd } });
  };

  const toggleDnd = (on: boolean): void => {
    if (on) {
      // 开启时用当前草稿；无效（如起止相同）回退默认夜间窗口
      const start = validDnd(startDraft, endDraft) ? startDraft : DEFAULT_DND.start;
      const end = validDnd(startDraft, endDraft) ? endDraft : DEFAULT_DND.end;
      setStartDraft(start);
      setEndDraft(end);
      patchPrefs({ dnd: { start, end } });
    } else {
      patchPrefs({ dnd: null });
    }
  };

  // 手风琴展开（grid-rows 过渡，acc 骨架；presence 延迟卸载保收拢动画）
  const dndPresence = usePresence(dndOn);

  return (
    <div className="settings-section notify-pane">
      {noSystemNotify && (
        <p className="settings-hint" role="note">
          {t('本机无系统通知能力，桌面通知无法显示；「需要你」提醒请依赖左栏胶囊与看板列。')}
        </p>
      )}
      <SettingsSection title={t('什么时候提醒')} item="notify-phases">
        <SettingsRows>
          <SettingRow
            title={t('需要你')}
            tag={<span className="s-tag warn">{t('始终开启')}</span>}
            desc={t('等待回答或需要处理问题时，始终提醒。')}
          >
            <Switch
              label={t('需要你')}
              checked
              disabled
              title={t('产品规则：「需要你」必须能到达你，不可关闭')}
              onChange={() => {}}
            />
          </SettingRow>
          <SettingRow title={t('已完成')}>
            <Switch
              label={t('已完成')}
              checked={prefs.done !== false}
              onChange={(v) => patchPrefs({ done: v })}
            />
          </SettingRow>
          <SettingRow title={t('出错')}>
            <Switch
              label={t('出错')}
              checked={prefs.error !== false}
              onChange={(v) => patchPrefs({ error: v })}
            />
          </SettingRow>
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title={t('安静时段')} item="notify-dnd">
        <SettingsRows>
          <SettingRow
            title={t('免打扰')}
            desc={t('这段时间不提醒「已完成 / 出错」，「需要你」照常提醒。可以跨零点，起止不能相同')}
          >
            <Switch label={t('免打扰')} checked={dndOn} onChange={toggleDnd} />
          </SettingRow>
          {/* 手风琴展开（grid-rows 过渡，acc 骨架；presence 延迟卸载：收起时
              内容保至收拢完再卸载，隐藏期不可聚焦） */}
          <div className={`acc s-row-acc${dndPresence.mounted ? ' is-open' : ''}`}>
            <div className="acc-body">
              {dndPresence.mounted ? (
                <div className="s-row">
                  <div className="s-row-l">
                    <div className="s-row-t">{t('时段')}</div>
                  </div>
                  <div className="s-row-r notify-dnd-times">
                    <input
                      type="time"
                      className="s-input mono"
                      aria-label={t('免打扰开始')}
                      value={startDraft}
                      onChange={(e) => {
                        setStartDraft(e.target.value);
                        syncDndDraft(e.target.value, endDraft);
                      }}
                    />
                    <span className="s-muted">{t('到')}</span>
                    <input
                      type="time"
                      className="s-input mono"
                      aria-label={t('免打扰结束')}
                      value={endDraft}
                      onChange={(e) => {
                        setEndDraft(e.target.value);
                        syncDndDraft(startDraft, e.target.value);
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </SettingsRows>
      </SettingsSection>

    </div>
  );
}
