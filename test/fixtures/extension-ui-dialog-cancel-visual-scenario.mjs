export default async function ({ page, capture, assert }) {
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  const assertDialogFits = async () => {
    const box = await dialog.boundingBox(), width = page.viewportSize().width;
    assert.ok(box, 'dialog has real layout bounds');
    assert.ok(box.x >= 15 && box.x + box.width <= width - 15, `dialog clipped at ${width}px: ${JSON.stringify(box)}`);
    assert.ok(box.width <= width - 31, 'dialog retains horizontal viewport gutters');
  };
  await assertDialogFits();
  const input = page.getByPlaceholder('项目说明'); await input.press('End'); await input.pressSequentially(' retained');
  await capture('active');
  await page.evaluate(() => window.cancelHostDialog());
  await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => window.dialogResponses), []);
  await capture('cancelled');
  await page.evaluate(() => window.openNextDialog()); await dialog.waitFor();
  await page.getByPlaceholder('下一条说明').pressSequentially('new request');
  await assertDialogFits();
  await capture('next-request');
}
