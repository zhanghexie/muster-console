export default async function ({ page, capture, assert }) {
  const trigger = page.getByRole('button', { name: '用户待办提醒', exact: true });
  await trigger.waitFor();
  await page.getByText('调度 Agent').waitFor();
  const shell = page.locator('.chat-input-shell');
  const toolbar = page.locator('.agent-composer-toolbar');
  const editor = page.getByRole('textbox');
  await editor.click();
  await page.keyboard.insertText('这是一段还没有发送的草稿');
  const shellBefore = await shell.boundingBox();
  const triggerBox = await trigger.boundingBox();
  const toolbarBox = await toolbar.boundingBox();
  assert.ok(triggerBox.x >= toolbarBox.x && triggerBox.x + triggerBox.width <= toolbarBox.x + toolbarBox.width, 'the reminder is inside the bottom toolbar');
  assert.ok(triggerBox.y >= toolbarBox.y && triggerBox.y + triggerBox.height <= toolbarBox.y + toolbarBox.height, 'the reminder is vertically inside the bottom toolbar');
  await capture('composer-closed');
  const before = await page.locator('.reminder-visual-header').boundingBox();
  await trigger.click();
  const panel = page.getByRole('dialog', { name: '用户待办提醒' });
  await panel.waitFor();
  const after = await page.locator('.reminder-visual-header').boundingBox();
  assert.deepEqual(after, before, 'opening the overlay never changes the top bar geometry');
  const panelTrigger = await trigger.boundingBox();
  const parent = await page.locator('.reminder-visual-surface').boundingBox();
  const box = await panel.boundingBox();
  assert.ok(Math.abs(box.x - panelTrigger.x) <= 1, 'the reminder panel aligns its left edge with the trigger');
  assert.ok(box.x >= parent.x && box.x + box.width <= parent.x + parent.width + 1, 'the panel remains inside the conversation');
  assert.ok(box.y + box.height <= parent.y + parent.height + 1, 'the panel fits the conversation height');
  assert.ok(box.y < shellBefore.y + shellBefore.height && box.y + box.height > shellBefore.y,
    'the reminder panel can overlap the input shell');
  assert.deepEqual(await shell.boundingBox(), shellBefore, 'opening the panel does not resize or move the input');
  assert.ok((await editor.innerText()).includes('这是一段还没有发送的草稿'), 'opening the reminder preserves the draft');
  const actions = await page.locator('.agent-composer-tb-right').boundingBox();
  assert.ok(triggerBox.x + triggerBox.width <= actions.x, 'the reminder does not overlap the right toolbar actions');
  await page.getByRole('button', { name: '工作流' }).waitFor();
  const workflowLabel = await page.locator('.agent-composer-workflow .bg-capsule-text').boundingBox();
  assert.ok(workflowLabel.height <= 18, 'the workflow label stays on one line alongside reminders');
  for (const button of await page.locator('.agent-composer-tb-left button:visible').all()) {
    if (await button.evaluate(element => !!element.closest('.session-reminder-panel'))) continue;
    const bounds = await button.boundingBox();
    assert.ok(bounds.x + bounds.width <= actions.x + 1, 'left toolbar buttons do not overlap the right toolbar actions');
  }
  await capture('composer-open');
  await panel.getByRole('button', { name: '删除提醒：确定提醒入口的位置' }).click();
  await panel.getByText('已完成 · 0').waitFor();
  await capture('deleted');
  await panel.getByRole('checkbox', { name: '标记完成：确认提醒入口的样式' }).click();
  await panel.getByRole('checkbox', { name: '重新打开：确认提醒入口的样式' }).waitFor();
  assert.ok((await trigger.innerText()).includes('1'));
  await capture('completed');
  await panel.getByRole('checkbox', { name: '标记完成：确认改动合并的目标分支' }).click();
  await panel.getByText('当前没有待处理的提醒').waitFor();
  assert.equal(await trigger.locator('.session-reminder-count').count(), 0, 'zero pending does not show a count');
  assert.equal(await panel.getByText('当前会话', { exact: true }).count(), 1);
  await capture('no-pending');
}
