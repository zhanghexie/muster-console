export default async function ({ page, capture, assert }) {
  const trigger = page.getByRole('button', { name: '用户待办提醒', exact: true });
  const editor = page.locator('.cli-composer-dialog .composer-editable');
  await trigger.waitFor();
  await editor.click();
  await page.keyboard.insertText('CLI 草稿保留');
  await capture('cli-composer-closed');
  const dialog = page.locator('.cli-composer-dialog');
  const before = await dialog.boundingBox();
  await trigger.click();
  const panel = page.getByRole('dialog', { name: '用户待办提醒' });
  await panel.getByText('确认 CLI 操作').waitFor();
  await panel.evaluate(async element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await capture('cli-composer-open');
  const panelBox = await panel.boundingBox();
  const frame = await page.locator('.cli-visual-frame').boundingBox();
  assert.ok(panelBox.y < before.y + before.height && panelBox.y + panelBox.height > before.y,
    `CLI reminder panel can cover the input dialog: ${JSON.stringify({ panelBox, before })}`);
  assert.ok(panelBox.x >= frame.x && panelBox.x + panelBox.width <= frame.x + frame.width + 1,
    'CLI reminder panel stays within the terminal frame');
  assert.deepEqual(await dialog.boundingBox(), before, 'the panel does not resize the CLI composer');
  assert.ok((await editor.innerText()).includes('CLI 草稿保留'));
  await panel.getByRole('button', { name: '关闭用户待办提醒' }).click();
  const dragHandle = dialog.getByRole('button', { name: '拖动输入框' });
  const handleBox = await dragHandle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, frame.y + 12, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.cli-reminder-popover')?.classList.contains('is-below'));
  await trigger.click();
  await panel.getByText('确认 CLI 操作').waitFor();
  await panel.evaluate(async element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
  const upperDialog = await dialog.boundingBox();
  const belowPanel = await panel.boundingBox();
  assert.ok(belowPanel.y >= upperDialog.y && belowPanel.y < upperDialog.y + upperDialog.height,
    'near the top edge the panel flips from within the composer');
  assert.ok(belowPanel.y + belowPanel.height <= frame.y + frame.height + 1, 'the flipped panel stays within the terminal');
  await capture('cli-composer-flipped');
  await panel.getByRole('button', { name: '删除提醒：确认 CLI 操作' }).click();
  await panel.getByText('当前没有待处理的提醒').waitFor();
  assert.equal(await trigger.locator('.session-reminder-count').count(), 0, 'zero pending does not show a count');
  await panel.getByRole('button', { name: '关闭用户待办提醒' }).click();
  await page.getByRole('button', { name: '收起输入框' }).click();
  await page.getByRole('button', { name: '展开输入框' }).click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  assert.ok((await editor.innerText()).includes('CLI 草稿保留'));
}
