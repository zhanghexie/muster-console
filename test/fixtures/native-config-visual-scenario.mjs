export default async function ({ page, capture, assert }) {
  const approval = page.locator('.ac-approval');
  await approval.getByRole('button', { name: 'Allow once' }).waitFor();
  await capture('native-approval');
  const trigger = page.locator('.native-config-anchor > button');
  await trigger.click();
  const mode = page.getByRole('button', { name: 'Workspace operating mode' });
  await mode.waitFor();
  assert.match(await mode.innerText(), /Architecture review and exploration/);
  assert.equal(await page.getByText('Select how the engine approaches the next operation.', { exact: true }).count(), 0);
  await capture('native-settings');
  await mode.press('ArrowDown');
  await page.getByRole('option', { name: 'Implementation' }).waitFor();
  assert.equal(await page.getByText('The engine uses its native permission rules for edits.', { exact: true }).count(), 0);
  await capture('native-options');
}
