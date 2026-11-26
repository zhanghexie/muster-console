import { ErrorTip } from './ErrorTip';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pathKey } from '../../../shared/pathKey';
import { sourceRootsFor } from '../../../shared/workspaceRoots';
import { preparationCommands, repositoryPreparations, repositoryExclusions, type WorktreePreparationSnapshot, type WorktreeRepoPreparation, type WorktreeRepoExclusion } from '../../../shared/worktreePreparation';
import { workspaceRepositoryChoices, type WorkspaceRepositoryChoice } from '../../../shared/worktreeSelection';
import { CustomSelect } from './CustomSelect';
import { usePresence } from './motion';

function recipeKey(recipe: Pick<WorktreeRepoPreparation, 'rootId' | 'relativePath'>): string {
  return JSON.stringify([recipe.rootId, pathKey(recipe.relativePath)]);
}

function CommandFields({ label, commands, disabled, onChange }: {
  label: string; commands: string[]; disabled: boolean; onChange: (commands: string[]) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return <div className="worktree-preparation-commands">
    {commands.map((command, index) => <div key={index} className="worktree-preparation-command">
      <label>{t('{{label}}：命令 {{n}}', { label, n: index + 1 })}
        <textarea value={command} disabled={disabled} rows={3} spellCheck={false}
          onChange={event => onChange(commands.map((value, i) => i === index ? event.target.value : value))} />
      </label>
      <button type="button" className="ui-btn" disabled={disabled}
        aria-label={t('删除 {{label}} 命令 {{n}}', { label, n: index + 1 })}
        onClick={() => onChange(commands.filter((_, i) => i !== index))}>{t('删除命令')}</button>
    </div>)}
    <button type="button" className="ui-btn" disabled={disabled}
      aria-label={t('为 {{label}} 添加命令', { label })} onClick={() => onChange([...commands, ''])}>{t('添加命令')}</button>
  </div>;
}

/** Independent, explicit save: cancelling the workspace form does not undo saved commands. */
export function WorktreePreparationSettings({ workspaceId, active, busy }: {
  workspaceId: string; active: boolean; busy?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const presence = usePresence(active && expanded);
  const [snapshot, setSnapshot] = useState<WorktreePreparationSnapshot>();
  const [commands, setCommands] = useState<string[]>([]);
  const [recipes, setRecipes] = useState<WorktreeRepoPreparation[]>([]);
  const [exclusions, setExclusions] = useState<WorktreeRepoExclusion[]>([]);
  const [exclusionSelection, setExclusionSelection] = useState('');
  const [choices, setChoices] = useState<WorkspaceRepositoryChoice[]>([]);
  const [selection, setSelection] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const loadedRequest = useRef<{ workspaceId: string; reload: number } | undefined>(undefined);
  const operation = useRef(false);
  const currentScope = useRef({ workspaceId, active });
  currentScope.current = { workspaceId, active };

  useEffect(() => {
    epoch.current++;
    loadedRequest.current = undefined;
    setExpanded(false); setSnapshot(undefined); setChoices([]); setSelection('');
    setCommands([]); setRecipes([]); setExclusions([]); setExclusionSelection(''); setError(''); setWarning(''); setNotice('');
    setLoading(false); setSaving(false); setRefreshing(false); operation.current = false;
  }, [workspaceId, active]);

  useEffect(() => {
    if (!active || !expanded) return;
    if (loadedRequest.current?.workspaceId === workspaceId && loadedRequest.current.reload === reload) return;
    const ticket = ++epoch.current;
    let cancelled = false;
    setLoading(true); setError(''); setWarning(''); setNotice('');
    const valid = (): boolean => !cancelled && ticket === epoch.current
      && currentScope.current.active && currentScope.current.workspaceId === workspaceId;
    void (async () => {
      const [config, repositories] = await Promise.allSettled([
        window.api.workspaces.getWorktreePreparation(workspaceId), window.api.git.listRepoLocations(false, workspaceId)
      ]);
      if (!valid()) return;
      if (config.status === 'rejected') {
        setSnapshot(undefined); setError(String(config.reason?.message ?? config.reason)); return;
      }
      const next = config.value;
      if (next.workspaceId !== workspaceId) { setSnapshot(undefined); setError(t('工作区源文件夹已变化，请刷新仓库。')); return; }
      loadedRequest.current = { workspaceId, reload };
      setSnapshot(next); setCommands([...next.commands]); setRecipes(next.recipes.map(recipe => ({ ...recipe, commands: [...recipe.commands] })));
      setExclusions(repositoryExclusions(next.exclusions ?? [])); setExclusionSelection('');
      setSelection(''); setChoices([]);
      if (repositories.status === 'rejected') { setWarning(String(repositories.reason?.message ?? repositories.reason)); return; }
      if (repositories.value.workspaceId !== workspaceId || repositories.value.rootsRevision !== next.rootsRevision) {
        setWarning(t('工作区源文件夹已变化，请刷新仓库。')); return;
      }
      setChoices(workspaceRepositoryChoices(next.workspace, repositories.value.repos));
      if (repositories.value.issueCount) setWarning(t('仓库扫描未完成（{{n}} 处）', { n: repositories.value.issueCount }));
    })().catch(reason => { if (valid()) setError(String(reason?.message ?? reason)); })
      .finally(() => { if (valid()) setLoading(false); });
    return () => {
      cancelled = true;
      if (ticket === epoch.current) setLoading(false);
    };
  }, [workspaceId, active, expanded, reload, t]);

  const scoped = snapshot?.workspaceId === workspaceId && active;
  const locked = !!busy || !active || loading || saving || refreshing;
  const edit = (update: () => void): void => { update(); setNotice(''); };
  const save = async (): Promise<void> => {
    if (locked || !scoped || !snapshot || operation.current) return;
    const ticket = epoch.current;
    const valid = (): boolean => ticket === epoch.current && currentScope.current.active && currentScope.current.workspaceId === workspaceId;
    try {
      const validatedCommands = preparationCommands(commands), validatedRecipes = repositoryPreparations(recipes);
      operation.current = true; setSaving(true); setError(''); setNotice('');
      const result = await window.api.workspaces.saveWorktreePreparation({ workspaceId, rootsRevision: snapshot.rootsRevision,
        controlKey: snapshot.controlKey, sourceKeys: snapshot.sourceKeys, configVersion: snapshot.configVersion,
        commands: validatedCommands, recipes: validatedRecipes, exclusions: repositoryExclusions(exclusions) });
      if (!valid()) return;
      setSnapshot(result); setNotice(t('准备命令已保存，创建隔离任务时执行。'));
    } catch (reason) {
      if (valid()) setError(t('准备命令未保存：{{error}}', { error: String((reason as Error)?.message ?? reason) }));
    } finally { if (valid()) { operation.current = false; setSaving(false); } }
  };

  const refreshRepositories = async (): Promise<void> => {
    if (locked || !scoped || !snapshot || operation.current) return;
    operation.current = true; setRefreshing(true);
    const ticket = epoch.current;
    const valid = (): boolean => ticket === epoch.current && currentScope.current.active && currentScope.current.workspaceId === workspaceId;
    try {
      const result = await window.api.git.listRepoLocations(true, workspaceId);
      if (!valid()) return;
      if (result.workspaceId !== workspaceId || result.rootsRevision !== snapshot.rootsRevision) throw new Error(t('工作区源文件夹已变化，请刷新仓库。'));
      setChoices(workspaceRepositoryChoices(snapshot.workspace, result.repos)); setSelection(''); setExclusionSelection('');
      setWarning(result.issueCount ? t('仓库扫描未完成（{{n}} 处）', { n: result.issueCount }) : '');
    } catch (reason) { if (valid()) setWarning(String((reason as Error)?.message ?? reason)); }
    finally { if (valid()) { operation.current = false; setRefreshing(false); } }
  };

  const available = choices.filter(choice => !recipes.some(recipe => recipeKey(recipe) === recipeKey(choice)));
  const exclusionChoices = choices.filter(choice => !!choice.relativePath && !exclusions.some(exclusion => recipeKey(exclusion) === recipeKey(choice)));
  return <section className="create-ws-field worktree-preparation">
    <button type="button" className="ui-btn" aria-expanded={expanded && active} aria-controls="worktree-preparation-body"
      disabled={locked} onClick={() => setExpanded(value => !value)}>{t('隔离准备命令')}</button>
    <div className={`acc${presence.stage === 'in' ? ' is-open' : ''}`} {...presence.spread} aria-hidden={!active || !expanded}
      {...(!active || !expanded ? { inert: '' } : {})}><div className="acc-body">
      {presence.mounted ? <div id="worktree-preparation-body" className="worktree-preparation-body">
        <p className="create-ws-codeindex-hint">{t('全部隔离仓建好后执行。工作区命令在主容器执行一次，仓级命令只在选中的隔离仓执行。')}</p>
        <p className="create-ws-codeindex-hint">{t('每个输入框是一条完整命令，可包含多行。命令独立保存；保存不会执行，取消工作区设置不会撤销已保存命令。')}</p>
        {loading ? <span>{t('正在读取准备命令…')}</span> : null}
        {scoped && !loading ? <>
          <strong>{t('自动隔离排除')}</strong>
          <p className="create-ws-codeindex-hint">{t('参考仓及其子仓可排除出自动隔离，仍可在 Git 中浏览。显式选仓可覆盖排除。')}</p>
          {exclusions.map((exclusion, index) => {
            const root = sourceRootsFor(snapshot!.workspace).find(root => root.id === exclusion.rootId);
            const label = `${root?.label || root?.path || exclusion.rootId} / ${exclusion.relativePath || t('（源文件夹根）')}`;
            return <div key={recipeKey(exclusion)} className="worktree-preparation-recipe">
              <strong>{label}</strong>
              {root ? <small className="worktree-preparation-source">{root.path}</small> : null}
              <button type="button" className="ui-btn" disabled={locked} aria-label={t('取消排除 {{label}}', { label })}
                onClick={() => edit(() => setExclusions(exclusions.filter((_, i) => i !== index)))}>{t('取消排除')}</button>
            </div>;
          })}
          <CustomSelect value={exclusionSelection} onChange={setExclusionSelection} disabled={locked || !exclusionChoices.length}
            ariaLabel={t('自动隔离排除仓库')} placeholder={t('选择参考仓')}
            menuClassName="task-source-options" options={exclusionChoices.map(choice => ({ value: choice.key, label: `${choice.sourceLabel} / ${choice.name} · ${choice.path}` }))} />
          <button type="button" className="ui-btn" disabled={locked || !exclusionChoices.some(choice => choice.key === exclusionSelection)} onClick={() => {
            const choice = exclusionChoices.find(choice => choice.key === exclusionSelection); if (!choice) return;
            edit(() => setExclusions([...exclusions, { rootId: choice.rootId, relativePath: choice.relativePath }])); setExclusionSelection('');
          }}>{t('添加排除仓库')}</button>
          <strong>{t('工作区准备命令')}</strong>
          <CommandFields label={t('工作区')} commands={commands} disabled={locked} onChange={next => edit(() => setCommands(next))} />
          <strong>{t('仓库准备命令')}</strong>
          {recipes.map((recipe, index) => {
            const root = sourceRootsFor(snapshot!.workspace).find(root => root.id === recipe.rootId);
            const label = `${root?.label || root?.path || recipe.rootId} / ${recipe.relativePath || t('（源文件夹根）')}`;
            return <div key={recipeKey(recipe)} className="worktree-preparation-recipe">
              <strong>{label}</strong>
              {root ? <small className="worktree-preparation-source">{root.path}</small> : null}
              {!root ? <span role="alert">{t('该源文件夹已移除，请删除对应准备命令。')}</span> : null}
              <CommandFields label={label} commands={recipe.commands} disabled={locked}
                onChange={next => edit(() => setRecipes(recipes.map((value, i) => i === index ? { ...value, commands: next } : value)))} />
              <button type="button" className="ui-btn" disabled={locked} aria-label={t('删除 {{label}} 仓库配置', { label })}
                onClick={() => edit(() => setRecipes(recipes.filter((_, i) => i !== index)))}>{t('删除仓库配置')}</button>
            </div>;
          })}
          <CustomSelect value={selection} onChange={setSelection} disabled={locked || !available.length}
            ariaLabel={t('准备命令目标仓库')} placeholder={t('选择要配置的仓库')}
            menuClassName="task-source-options" options={available.map(choice => ({ value: choice.key, label: `${choice.sourceLabel} / ${choice.name} · ${choice.path}` }))} />
          <div className="worktree-preparation-actions">
            <button type="button" className="ui-btn" disabled={locked || !available.some(choice => choice.key === selection)} onClick={() => {
              const choice = available.find(choice => choice.key === selection); if (!choice) return;
              edit(() => setRecipes([...recipes, { rootId: choice.rootId, relativePath: choice.relativePath, commands: [] }])); setSelection('');
            }}>{t('添加仓库配置')}</button>
            <button type="button" className="ui-btn" disabled={locked} onClick={() => void refreshRepositories()}>{t('刷新仓库')}</button>
          </div>
          <button type="button" className="ui-btn" disabled={locked} onClick={() => void save()}>{saving ? t('保存中…') : t('保存准备命令')}</button>
        </> : null}
        {warning ? <p role="status">{warning}</p> : null}
        {error ? <ErrorTip message={error} /> : null}
        {notice ? <p role="status">{notice}</p> : null}
        <button type="button" className="ui-btn" disabled={locked} title={t('丢弃未保存的准备命令，重新读取配置')}
          onClick={() => setReload(value => value + 1)}>{t('重新加载配置')}</button>
      </div> : null}
    </div></div>
  </section>;
}
