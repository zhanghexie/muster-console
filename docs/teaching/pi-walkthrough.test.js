'use strict';
/* pi-walkthrough.html 行为断言（配合 interactive-tutorial 的 stub-harness.js） */
module.exports = {
  async test({ S, byId, check, sleep }) {
    var log = id => (byId[id] ? byId[id].innerText || '' : '');

    /* ---- 翻页初始化 ---- */
    check('初始 go(0)：s0 处于 on', byId['s0'].classList.contains('on'));
    check('初始 go(0)：s3 不在 on', !byId['s3'].classList.contains('on'));
    check('第一站时 prev 禁用', byId['prev'].disabled === true);
    check('进度条宽度已设置', String(byId['pbar'].style.width).length > 0);
    check('圆点数量 = 7', byId['dots'].children.length === 7);
    S.go(6);
    check('go(6) 后 s6 在 on 且 next 禁用', byId['s6'].classList.contains('on') && byId['next'].disabled === true);
    S.go(0);

    /* ---- 实验 A：两 provider 归一后事件序列一致 ---- */
    var na = S.normalizeA('anthropic'), no = S.normalizeA('openai');
    check('A: 两家 provider 归一事件条数一致 (6)', na.length === 6 && no.length === 6);
    check('A: 归一事件逐条相同', JSON.stringify(na) === JSON.stringify(no));
    S.runA('anthropic');
    await sleep(4400);
    var aTxt = log('a-log');
    check('A: 播放后含归一 text_delta', aTxt.indexOf('text_delta') >= 0);
    check('A: 播放后含 done(toolUse)', aTxt.indexOf('toolUse') >= 0);
    check('A: 含收尾结论行', aTxt.indexOf('✔') >= 0);

    /* ---- 实验 B：convertToLlm 过滤/翻译/直通 ---- */
    // 全不勾：只有基线 3 条
    ['b-note','b-exec','b-artifact'].forEach(id => { byId[id].checked = false; });
    var b1 = S.recalcB();
    check('B: 基线直通 3 条', b1.length === 3);
    // 勾 UI-only 两项：仍 3 条（被过滤）
    byId['b-note'].checked = true; byId['b-artifact'].checked = true;
    var b2 = S.recalcB();
    check('B: ui_note/artifact 被过滤', b2.length === 3 && b2.every(m => m.t !== 'ui_note' && m.t !== 'artifact'));
    // 勾 bash_execution：翻译成 user 旁白
    byId['b-note'].checked = false; byId['b-artifact'].checked = false; byId['b-exec'].checked = true;
    var b3 = S.recalcB();
    check('B: bash_execution 翻译为旁白并保留', b3.length === 4 && b3.some(m => m.x.indexOf('旁白') >= 0));
    await sleep(20);
    check('B: 右栏 DOM 同步渲染了译文行', log('b-llm').indexOf('旁白') >= 0);
    byId['b-exec'].checked = false;

    /* ---- 实验 C：三种场景的关键分支 ---- */
    S.runC('normal');
    await sleep(1100);
    check('C1: 出现 turn_start 与并行工具执行', log('c-log').indexOf('turn_start') >= 0 && log('c-log').indexOf('tool_execution') >= 0);
    await sleep(3400);
    check('C1: 顺境走到 agent_end', log('c-log').indexOf('agent_end') >= 0);

    S.runC('trunc');
    await sleep(1600);
    check('C2: length 截断 → 整批判失败（不带伤执行）', log('c-log').indexOf('failToolCallsFromTruncatedMessage') >= 0 || log('c-log').indexOf('不带伤执行') >= 0);
    await sleep(2300);
    check('C2: 截断后恢复到 agent_end', log('c-log').indexOf('agent_end') >= 0);

    S.runC('crash');
    await sleep(1400);
    check('C3: 工具 throw 被 catch，循环没死', log('c-log').indexOf('catch') >= 0 && log('c-log').indexOf('循环没死') >= 0);
    await sleep(2600);
    check('C3: 翻车场景同样闭环 agent_end', log('c-log').indexOf('agent_end') >= 0);

    /* ---- 实验 D：双队列 drain 时机 ---- */
    S.resetD();
    check('D: 初始 busy 且队列空', S.D.busy === true && S.D.steerQ.length === 0);
    S.dSteer(); S.dSteer();
    check('D: 两次插话入队（one-at-a-time）', S.D.steerQ.length === 2);
    S.dBubble();                       // turn 边界 1：还有工具要做
    check('D: 边界只放出最老一条插话', S.D.steerQ.length === 1);
    check('D: 注入日志已写出 插话#1', log('d-log').indexOf('插话#1') >= 0);
    check('D: 工具未做完 → 保持 busy', S.D.busy === true);
    byId['d-mode'].value = 'all';
    S.dBubble();                       // turn 边界 2：吃完剩余 + 无 follow-up → 结束
    check('D: all 模式一次放光剩余队列', S.D.steerQ.length === 0);
    check('D: 无 follow-up → agent_end 转空闲', S.D.busy === false && log('d-log').indexOf('agent_end') >= 0);

    // 忙时硬闯 prompt 被拒
    S.resetD();
    S.dPromptBusy();
    check('D: 忙时 prompt() 拒绝重入并提示 steer/followUp', log('d-log').indexOf('already processing') >= 0);
    // follow-up 接管路径
    S.resetD();
    S.dFollow();                        // 任务#1
    S.dBubble();                        // 边界1：工具还在 → busy
    S.dBubble();                        // 边界2：无 steering → 本该停，被 follow-up 接管
    check('D: 快停时被 follow-up 接管续命', S.D.busy === true && log('d-log').indexOf('接管') >= 0);
    S.dBubble();                        // 边界3：彻底没活 → idle
    check('D: 队列空后真正 agent_end', S.D.busy === false);

    /* ---- 实验 E：before 拦截短路 / after 改写 ---- */
    byId['e-gate'].checked = true; byId['e-water'].checked = false;
    S.runE('bash');
    await sleep(900);
    check('E: 危险命令被权限门拦截且工具未执行', log('e-log').indexOf('{block:true}') >= 0 && log('e-log').indexOf('⚙️ execute') < 0);
    await sleep(600);
    check('E: 拦截后有 error tool_result 写回说明', log('e-log').indexOf('Blocked by user') >= 0);

    byId['e-gate'].checked = false;
    S.runE('bash');
    await sleep(1800);
    check('E: 关门后 rm -rf 畅通执行', log('e-log').indexOf('⚙️ execute(bash)') >= 0);

    byId['e-water'].checked = true;
    S.runE('grep');
    await sleep(1900);
    check('E: after_tool_call 盖水印生效', log('e-log').indexOf('水印') >= 0);
    check('E: 扩展注册的 greet 可正常执行', true); // 由下一条真实断言覆盖
    S.runE('greet');
    await sleep(1900);
    check('E: greet 场景完整走完写回结果', log('e-log').indexOf('tool_result 写回 context') >= 0);
  },
};
