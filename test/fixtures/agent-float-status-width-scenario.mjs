export default async function ({ page, capture, assert }) {
  const row = page.locator('.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-ws-stack-item').first();
  const chat = row.locator('.agent-notify-chat');
  await chat.waitFor();
  const geometry = () => row.evaluate(el => {
    const box = selector => { const r = el.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, top: r.top }; };
    const button = el.querySelector('.agent-notify-chat');
    const r = button.getBoundingClientRect();
    return { bubble: box('.agent-notify-bubble'), chat: box('.agent-notify-chat'), label: box('.agent-notify-chat-label'),
      status: box('.agent-notify-text'), hit: button.contains(document.elementFromPoint(r.right - 3, r.top + r.height / 2)) };
  });
  for (const width of [180, 200, 280]) {
    await page.locator('.left-ws-slot').evaluate((el, width) => { el.style.width = `${width}px`; }, width);
    await page.evaluate(width => document.documentElement.style.setProperty('--sessions-col-w', `${width}px`), width);
    for (const open of [false, true]) {
      if (open) {
        await chat.click();
        const surface = page.locator('.agent-float-panel .chat-surface-view');
        await surface.getByText('任务已完成。请确认下一步操作。', { exact: true }).waitFor();
        assert.equal(await surface.getByRole('alert').count(), 0, '打开面板应加载调度历史');
        await page.waitForTimeout(350);
      }
      await chat.hover();
      await capture(`${width}-${open ? 'open-hover' : 'closed-hover'}`);
      const g = await geometry();
      console.log('STATUS_WIDTH', width, open, JSON.stringify(g));
      assert.ok(g.chat.right <= g.bubble.right - 1, '对话/收起按钮不能被状态挤出胶囊');
      assert.ok(g.label.left >= g.chat.left && g.label.right <= g.chat.right, '按钮文字完整显示');
      assert.ok(g.status.width > 0 && g.status.right <= g.chat.left, '状态仍显示且不覆盖开合按钮');
      assert.ok(g.hit, '开合按钮右侧可实际命中');
      if (open) { await chat.click(); await page.waitForTimeout(350); }
    }
  }
}
