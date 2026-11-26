/** Isolated visual fixture: no real credentials, services or application state. */
const calls: string[] = [];
let attempted = false;
(window as any).__uiFixture = { calls, unmocked: [] };
(window as any).api = {
  app: { setChromeTheme: async () => ({ ok: true, material: 'solid' }) },
  on: () => () => {},
  shell: { openExternal: async () => ({ ok: true }) },
  feedback: {
    prepare: async (_id: string, revision: number) => {
      calls.push('prepare');
      if (!attempted) { attempted = true; throw new Error('无法连接反馈仓库，请稍后重试。'); }
      return { reviewId: 'visual-review', revision, copyBody: true, matches: [{ id: '42', title: '切换工作区时列表滚动位置丢失', status: 'opened',
        url: 'https://gitlab.example.test/demo/workbench/-/issues/42', exact: false, source: 'remote' }],
        body: '## 涉及功能\n会话列表\n\n## 实际情况\n切换回来后列表回到顶部。\n\n## 期望\n恢复之前的阅读位置。\n\n## 证据与不确定性\n只在当前环境观察一次。' };
    }
  }
};
