module.exports = {
  async test({ byId, check }) {
    check('A/初始页面', byId.s0.className.includes('on'));
    byId['bind-ui'].onclick(); byId['bind-agent'].onclick(); byId['bind-tool'].onclick();
    check('A/扩展贡献面可累积', byId['bind-count'].innerText.trim() === '3');
    byId['bind-data'].onclick();
    check('A/四个面绑定完成', byId['bind-status'].innerText.trim() === 'ready' && byId['bind-kind'].innerText.trim() === 'complete');
    byId['turn-send'].onclick(); byId['turn-tool'].onclick(); byId['turn-crash'].onclick(); byId['turn-rebuild'].onclick();
    check('B/事件追加和重建', byId['turn-log'].innerText.includes('projection restored'));
    byId['ctx-small'].onclick(); byId['ctx-large'].onclick();
    check('C/上下文预算', byId['ctx-log'].innerText.includes('admitted') && byId['ctx-log'].innerText.includes('budget exceeded'));
    byId['proposal'].onclick(); byId['approve'].onclick(); byId['apply'].onclick(); byId['disable'].onclick();
    check('D/提案审批和实例回收', byId['mutation-log'].innerText.includes('state.changed') && byId['mutation-log'].innerText.includes('abort pending calls'));
  }
};
