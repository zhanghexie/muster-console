export default async function ({ page, capture, assert }) {
  const assertFocusOutlineVisible = async (field) => {
    const metrics = await field.evaluate(el => {
      const viewport = el.closest('.feedback-editor');
      const box = el.getBoundingClientRect(), clip = viewport.getBoundingClientRect();
      const style = getComputedStyle(el);
      const outset = parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset));
      return { style: style.outlineStyle, outset,
        left: box.left - clip.left - viewport.clientLeft,
        right: clip.left + viewport.clientLeft + viewport.clientWidth - box.right,
        top: box.top - clip.top - viewport.clientTop,
        bottom: clip.top + viewport.clientTop + viewport.clientHeight - box.bottom };
    });
    assert.notEqual(metrics.style, 'none', 'the focused field has a visible outline');
    for (const side of ['left', 'right', 'top', 'bottom']) {
      assert.ok(metrics[side] + 0.5 >= metrics.outset, `focus outline is clipped at ${side}: ${JSON.stringify(metrics)}`);
    }
  };
  const dialog = page.getByRole('dialog', { name: '反馈审核' });
  const context = page.getByRole('textbox', { name: '使用场景' });
  await dialog.waitFor();
  await context.waitFor();
  assert.equal(await page.getByRole('button', { name: '审核反馈' }).isEnabled(), true);

  const title = await page.getByRole('textbox', { name: '标题' }).boundingBox();
  const area = await page.getByRole('textbox', { name: '涉及功能' }).boundingBox();
  assert.ok(area.y > title.y + title.height, 'each field has its own input in a single column');
  const rows = page.locator('.feedback-row');
  const rowGeometry = await rows.evaluateAll(items => items.map(item => ({ height: item.getBoundingClientRect().height,
    title: { width: item.querySelector('strong').clientWidth, scroll: item.querySelector('strong').scrollWidth,
      overflow: getComputedStyle(item.querySelector('strong')).textOverflow, whitespace: getComputedStyle(item.querySelector('strong')).whiteSpace },
    status: { overflow: getComputedStyle(item.querySelector('span')).textOverflow, whitespace: getComputedStyle(item.querySelector('span')).whiteSpace } })));
  assert.equal(rowGeometry[0].height, rowGeometry[1].height, 'every feedback row has the same two-line height');
  assert.ok(rowGeometry.some(row => row.title.scroll > row.title.width), 'the long title is actually truncated');
  if (page.viewportSize().width <= 650) {
    const list = await page.locator('.feedback-list').boundingBox();
    const active = await page.locator('.feedback-row[aria-current="true"]').boundingBox();
    assert.ok(active.x >= list.x - 1 && active.x + active.width <= list.x + list.width + 1, 'the selected feedback remains visible in the narrow list');
  }
  for (const row of rowGeometry) {
    assert.equal(row.title.overflow, 'ellipsis'); assert.equal(row.title.whitespace, 'nowrap');
    assert.equal(row.status.overflow, 'ellipsis'); assert.equal(row.status.whitespace, 'nowrap');
  }
  assert.equal(await context.evaluate(el => getComputedStyle(el).resize), 'none');
  const legacyOverride = await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '.feedback-resize-probe textarea { resize: vertical; }';
    const holder = document.createElement('div');
    holder.className = 'feedback-resize-probe';
    const text = document.createElement('textarea');
    holder.append(text); document.head.append(style); document.body.append(holder);
    const value = getComputedStyle(text).resize;
    holder.remove(); style.remove(); return value;
  });
  assert.equal(legacyOverride, 'none', 'global policy also overrides legacy local styles');
  const initial = await context.inputValue();
  const before = await context.boundingBox(), modalBefore = await dialog.boundingBox();
  await context.fill(Array.from({ length: 10 }, (_, i) => `长内容第 ${i + 1} 行`).join('\n'));
  await context.scrollIntoViewIfNeeded();
  const expanded = await context.boundingBox();
  assert.ok(expanded.height > before.height + 80, 'the field grows with its content');
  assert.ok(await context.evaluate(el => el.scrollHeight <= el.clientHeight + 1), 'the field does not internally scroll');
  assert.ok(await page.locator('.feedback-editor').evaluate(el => el.scrollHeight > el.clientHeight), 'the right detail area scrolls');
  await page.mouse.move(expanded.x + expanded.width - 3, expanded.y + expanded.height - 3);
  await page.mouse.down();
  await page.mouse.move(expanded.x + expanded.width - 3, expanded.y + expanded.height + 110, { steps: 5 });
  await page.mouse.up();
  const after = await context.boundingBox(), modalAfter = await dialog.boundingBox();
  assert.ok(Math.abs(after.height - expanded.height) < 1, 'dragging must not resize the textarea');
  assert.ok(Math.abs(modalAfter.height - modalBefore.height) < 1 && Math.abs(modalAfter.width - modalBefore.width) < 1, 'dragging must not resize the panel');
  await capture('long-content');
  await context.fill(initial);
  assert.ok((await context.boundingBox()).height < expanded.height - 80, 'the field shrinks when content is removed');

  const add = page.getByRole('button', { name: '手动添加反馈' });
  const sidebar = page.locator('.feedback-sidebar');
  const addBounds = await add.boundingBox(), sidebarBounds = await sidebar.boundingBox();
  assert.ok(addBounds.y + addBounds.height >= sidebarBounds.y + sidebarBounds.height - 2, 'add button is anchored at the bottom of the sidebar');
  await add.click();
  await page.getByRole('textbox', { name: '标题' }).fill('手动添加的反馈');
  await page.getByRole('combobox', { name: '类型' }).press('Enter');
  const choices = page.locator('select:open');
  await choices.waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.ok((await page.getByRole('combobox', { name: '类型' }).locator('.c-select-button').innerText()).includes('改进建议'));
  assert.ok((await page.getByRole('textbox', { name: '标题' }).locator('..').innerText()).includes('必填'));
  assert.ok((await page.getByRole('combobox', { name: '类型' }).locator('..').innerText()).includes('必填'));
  for (const label of ['涉及功能', '使用场景', '实际情况', '期望', '复现步骤或触发条件', '证据与不确定性', '建议', '环境']) {
    assert.equal(await page.getByRole('textbox', { name: label }).count(), 1, `${label} has its own input`);
    assert.ok((await page.getByRole('textbox', { name: label }).locator('..').innerText()).includes('选填'), `${label} is marked optional`);
  }
  assert.equal(await page.getByRole('textbox', { name: '影响' }).count(), 0);
  assert.equal(await page.getByRole('textbox', { name: '反馈正文' }).count(), 0);
  await page.getByRole('textbox', { name: '涉及功能' }).fill('会话列表');
  await page.getByRole('textbox', { name: '使用场景' }).fill('切换工作区');
  const manualActual = page.getByRole('textbox', { name: '实际情况' });
  await manualActual.fill('使用中发现的问题。\n补充的第二行。');
  await assertFocusOutlineVisible(manualActual);
  await capture('manual-draft');
  if (page.viewportSize().width > 650) {
    const viewport = page.viewportSize();
    await manualActual.fill('窗口宽度变化时输入内容需要跟随换行。'.repeat(10));
    const wideHeight = (await manualActual.boundingBox()).height;
    await page.setViewportSize({ ...viewport, width: 390 });
    await page.waitForFunction(height => document.querySelector('[data-feedback-field="actual"]').getBoundingClientRect().height > height + 10, wideHeight);
    const narrowHeight = (await manualActual.boundingBox()).height;
    await page.setViewportSize(viewport);
    await page.waitForFunction(height => document.querySelector('[data-feedback-field="actual"]').getBoundingClientRect().height < height - 10, narrowHeight);
  }
  const suggestion = page.getByRole('textbox', { name: '建议' });
  await suggestion.fill('保存之前的位置。');
  const manualEnvironment = page.getByRole('textbox', { name: '环境' });
  await manualEnvironment.fill('Windows 11');
  await assertFocusOutlineVisible(manualEnvironment);
  await capture('manual-bottom');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('textbox', { name: '标题' }).focus();
  await assertFocusOutlineVisible(page.getByRole('textbox', { name: '标题' }));
  await page.getByRole('textbox', { name: '证据与不确定性' }).focus();
  await page.keyboard.press('Tab');
  const lastField = page.getByRole('textbox', { name: '建议' });
  assert.equal(await lastField.evaluate(el => document.activeElement === el), true, 'keyboard navigation reaches the last field');
  await assertFocusOutlineVisible(lastField);
  await page.keyboard.press('Tab');
  const finalField = page.getByRole('textbox', { name: '环境' });
  assert.equal(await finalField.evaluate(el => document.activeElement === el), true, 'keyboard navigation reaches the bottom field');
  await assertFocusOutlineVisible(finalField);
  await capture('focus-bottom');

  await page.getByRole('button', { name: '删除反馈' }).click();
  const confirm = page.getByRole('dialog', { name: '删除反馈？' });
  await confirm.waitFor();
  await capture('delete-confirm');
  const confirmBounds = await confirm.boundingBox();
  assert.ok(confirmBounds.x >= 8 && confirmBounds.x + confirmBounds.width <= page.viewportSize().width - 8, 'confirmation stays inside the viewport');
  await confirm.getByRole('button', { name: '取消' }).click();
  await page.getByRole('button', { name: '审核反馈' }).click();
  await page.getByRole('alert').waitFor();
  await capture('repository-unavailable');
  await page.getByRole('button', { name: '审核反馈' }).click();
  const review = page.getByRole('region', { name: '提交前核对' });
  await review.waitFor();
  assert.equal(await page.getByRole('button', { name: '在 GitHub 提交' }).isEnabled(), true);
  assert.equal(await review.getByRole('textbox', { name: '使用场景' }).getAttribute('readonly'), '');
  assert.equal(await review.getByRole('textbox', { name: '使用场景' }).inputValue(), initial);
  assert.equal(await review.evaluate(el => el.scrollTop), 0, 'review starts at the title');
  await capture('review');
  await page.getByRole('button', { name: '返回修改' }).click();
  assert.equal(await page.getByRole('textbox', { name: '使用场景' }).getAttribute('readonly'), null);
  await page.evaluate(() => window.__markFeedbackOpened());
  await dialog.getByRole('button', { name: '核对是否已提交' }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '查看已发送反馈' }).count(), 0);
  await capture('browser-opened');
  await page.evaluate(() => window.__markFeedbackSubmitted());
  const heading = dialog.locator('.feedback-detail-heading');
  await heading.getByText('已提交', { exact: true }).waitFor();
  assert.ok((await heading.innerText()).includes('切换工作区后会话列表滚动位置丢失'));
  assert.ok((await heading.innerText()).includes('已提交'));
  assert.equal(await dialog.getByText(/本地来源/).count(), 0);
  const actions = dialog.locator('.feedback-actions');
  const actionBounds = await actions.boundingBox();
  const openBounds = await actions.getByRole('button', { name: '查看已发送反馈' }).boundingBox();
  const deleteBounds = await actions.getByRole('button', { name: '删除反馈' }).boundingBox();
  assert.ok(openBounds.x + openBounds.width >= actionBounds.x + actionBounds.width - 2, 'submitted actions align right');
  assert.ok(deleteBounds.x > actionBounds.x, 'delete is grouped with the right-aligned action');
  await capture('submitted');
}
