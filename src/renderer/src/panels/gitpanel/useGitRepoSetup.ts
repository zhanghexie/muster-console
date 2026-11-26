import { useScopedGit } from './GitWorkspaceScope';
/**
 * GitPanel 初始化仓库流程（2026-09-26 GitPanel.tsx → gitpanel/ 拆分）：
 * runInitRepo（在目录初始化并加入工作区）。原 runAddRepo（选目录导入外部仓）
 * 已随「添加外部仓库」功能移除（2026-10-10，多文件夹工作区已原生支持）。
 * 错误文案与刷新时序保持不变。
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export type GitRepoSetupApi = {
  runInitRepo: (dirPath?: string) => Promise<void>;
};

export function useGitRepoSetup({
  setBusy,
  setError,
  refreshList,
  setSelectedPath
}: {
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setError: (e: string | null) => void;
  refreshList: (quiet?: boolean, forceRescan?: boolean) => Promise<void>;
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>;
}): GitRepoSetupApi {
  const { t } = useTranslation();
  const git = useScopedGit();

  const runInitRepo = useCallback(
    async (dirPath?: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await git.initRepo(dirPath);
        if (!res.ok) {
          setError(res.message ?? t('初始化失败'));
          return;
        }
        await refreshList();
        if (res.path) setSelectedPath(res.path);
        if (res.message) setError(res.message);
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [git, refreshList, setBusy, setError, setSelectedPath, t]
  );

  return {
    runInitRepo
  };
}
