import type { AppContext } from '../../context';

export const gitHost = {
  'git.refreshRepos': (ctx: AppContext, args?: { workspaceId?: string }) =>
    ctx.git.refreshRepos(args?.workspaceId)
};
