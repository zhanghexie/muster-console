/**
 * prime-agent-walkthrough.html 的行为断言（配合 ~/.agents/skills/interactive-tutorial/scripts/stub-harness.js 使用）
 * 运行：node ~/.agents/skills/interactive-tutorial/scripts/stub-harness.js \
 *         docs/teaching/prime-agent-walkthrough.html docs/teaching/prime-agent-walkthrough.test.js
 */
let kcells, rspawns;

module.exports = {
  setup({ registerList, fakeEl }) {
    kcells = ['c1', 'c2', 'c3'].map(v => {
      const b = fakeEl('kcell-' + v); b._v = v;
      b.getAttribute = k => (k === 'data-kcell' ? v : null);
      return b;
    });
    registerList('[data-kcell]', kcells);

    rspawns = ['api-reviewer', 'test-reviewer', 'audit'].map(v => {
      const b = fakeEl('rspawn-' + v); b._v = v;
      b.getAttribute = k => (k === 'data-rspawn' ? v : null);
      return b;
    });
    registerList('[data-rspawn]', rspawns);
  },

  async test({ byId, check, sleep }) {
    /* ── 实验 A：持久 kernel ── */
    kcells.find(b => b._v === 'c1').onclick();
    kcells.find(b => b._v === 'c2').onclick();
    check('A/变量入命名空间', byId['k-vars'].innerText.includes('files') && byId['k-vars'].innerText.includes('big'), byId['k-vars'].innerText);

    byId['k-compact'].onclick();
    check('A/compaction 压对话', byId['k-chat'].innerText.includes('[compaction]'));
    check('A/compaction 保变量', byId['k-vars'].innerText.includes('files'));

    byId['k-restart'].onclick();
    check('A/重启丢命名空间', byId['k-vars'].innerText.includes('（空命名空间）'));

    byId['k-restore'].onclick();
    check('A/restore 从 dill 复活', byId['k-vars'].innerText.includes('files') && byId['k-restore'].innerText.includes('dill') === false);

    /* ── 实验 B：子代理 ── */
    rspawns[0].onclick();
    const rl = byId['r-log'].innerText;
    check('B/handle 立即返回', rl.includes('admission handle') && /sub-\d{3}/.test(rl) && rl.includes('不含答案'), rl);
    check('B/父上下文只有 handle', byId['r-parent'].innerText.includes('handle:') && !byId['r-parent'].innerText.includes('agent_message'));

    rspawns[1].onclick(); rspawns[2].onclick();
    await sleep(6000);   // 等异步 agent_message 到达（最后一个 spawn 延迟 ~5.2s）
    const rp = byId['r-parent'].innerText;
    check('B/结果经 agent_message 到达', rp.includes('agent_message') && rp.includes('report-sub-'), rp);
    check('B/usage 归并进父 turn', byId['r-usage'].innerText.includes('含已归并子代理用量'), byId['r-usage'].innerText);

    /* ── 实验 C：Continual Harness ── */
    byId['h-refine'].onclick();
    check('C/refine 生成小步编辑', byId['h-log'].innerText.includes('小步编辑') && byId['h-log'].innerText.includes('证据'));

    byId['h-apply'].onclick();
    const t1 = byId['h-table'].innerText;
    check('C/应用：新增与更新生效', t1.includes('pnpm test') && t1.includes('type(scope)'), t1);

    byId['h-rollback'].onclick();
    const t2 = byId['h-table'].innerText;
    check('C/回滚恢复旧账本', !t2.includes('pnpm test') && t2.includes('提交信息用中文'), t2);
  },
};
