import React from 'react';
import { useTranslation } from 'react-i18next';
import { choiceIncluded } from '../../../shared/worktreeSelection';
import type { useWorktreeSelection } from './useWorktreeSelection';
import { CustomSelect } from './CustomSelect';

export function WorktreeSelectionFields({ selection, disabled }: { selection: ReturnType<typeof useWorktreeSelection>; disabled: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  return <fieldset className="worktree-selection" disabled={disabled}>
    <legend>{t('隔离仓库范围')}</legend><div className="worktree-selection-heading">
      <button type="button" className="git-btn ghost tiny" disabled={disabled || selection.loading} onClick={selection.refresh}>{t('刷新仓库')}</button></div>
    <p className="new-task-note">{selection.preserveCwd ? t('当前工作目录保持不变；选中的仓库在任务 worktree 修改，其他仓库共享。') : t('选中的仓库及其嵌套仓将在独立副本中运行；其他源文件夹保持共享参考。')}</p>
    {selection.loading ? <p role="status">{t('正在读取仓库列表…')}</p> : null}
    {selection.error ? <p role="alert">{selection.error}</p> : null}
    {selection.warning ? <p role="status">{selection.warning}</p> : null}
    {selection.removed ? <p role="alert">{t('所选仓库已失效，请重新选择隔离范围。')}</p> : null}
    <div className="worktree-selection-list">{selection.choices.map(choice => {
      const explicit = selection.selected.some(item => item.rootId === choice.rootId && item.relativePath === choice.relativePath);
      const inherited = !selection.preserveCwd && !explicit && choiceIncluded(choice, selection.selected);
      return <label className="worktree-selection-row" key={choice.key} title={choice.path}>
        <input type="checkbox" checked={explicit || inherited} disabled={disabled || inherited} onChange={event => selection.toggle(choice, event.target.checked)} />
        <span><span className="worktree-selection-path">{choice.path}</span>
          {inherited ? <small>{t('由上级仓库包含')}</small> : null}</span>
      </label>;
    })}</div>
    {!selection.loading && !selection.error && !selection.choices.length ? <p>{t('没有可隔离的源仓库，请添加 Git 源文件夹或刷新仓库。')}</p> : null}
    {!selection.preserveCwd ? <label className="new-task-field">{t('任务运行仓库')}
      <CustomSelect ariaLabel={t('任务运行仓库')} className="task-path-select" menuClassName="task-source-menu" disabled={disabled || selection.loading} value={selection.working} onChange={selection.setWorking}
        options={[{ value: '', label: t('选择运行仓库') }, ...selection.workingChoices.map(choice => ({ value: choice.key, label: choice.path }))]} />
    </label> : null}
  </fieldset>;
}
