export default async function ({ page, capture, assert }) {
  await page.getByText('管理消息渠道', { exact: true }).click();
  await page.getByText('生产线状态助手', { exact: true }).waitFor();
  await page.locator('.muster-messaging-settings').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.dim-channelTooltip').first().evaluate(node => getComputedStyle(node).visibility), 'hidden');
  assert.equal(await page.getByRole('tab', { name: '邮箱' }).count(), 1);
  assert.equal(await page.getByRole('tab', { name: 'AI Office 任务连接器' }).count(), 1);
  await capture('channel-list');

  await page.getByRole('tab', { name: '微信', exact: true }).click();
  await page.getByRole('button', { name: '扫码接入微信机器人' }).click();
  const qr = page.getByRole('img', { name: /一次性二维码/ });
  await qr.waitFor();
  await qr.scrollIntoViewIfNeeded();
  assert.equal(await qr.evaluate(image => image.complete && image.naturalWidth > 0), true);
  assert.ok((await qr.boundingBox()).width <= 270, 'the scan code is sized by its channel card');
  const scanCard = page.locator('.dim-qrLayout').first();
  assert.equal(await scanCard.evaluate(node => getComputedStyle(node).display), 'grid');
  await capture('wechat-qr');

  await page.evaluate(() => window.__uiFixture.approveWeixin());
  const account = page.locator('article[data-bot-id="fixture-wechat"]');
  await account.getByText('运行正常').waitFor();
  await account.getByRole('button', { name: '展开账号管理' }).click();
  await account.getByText('尚未绑定用户').waitFor();
  assert.doesNotMatch(await account.textContent(), /工作目录|上下文增强|思考强度|Agent 预设|private-agent-workspace/);
  await account.getByRole('button', { name: '生成绑定码' }).click();
  await account.getByText('123456', { exact: true }).waitFor();
  await account.getByText(/此绑定码将于/).waitFor();
  await account.getByRole('button', { name: '复制绑定码' }).waitFor();
  let dimensions = await page.locator('.muster-messaging-settings').evaluate(node => [node.scrollWidth, node.clientWidth]);
  assert.ok(dimensions[0] <= dimensions[1] + 1, 'the expanded WeChat account fits its container');
  await capture('wechat-pairing');

  await page.evaluate(() => window.__uiFixture.redeemWeixin());
  await account.getByText('已授权的微信用户').waitFor();
  await account.getByRole('button', { name: '解除绑定 已授权的微信用户' }).waitFor();
  await account.getByRole('button', { name: '移除接入' }).waitFor();
  assert.equal(await account.getByText('123456', { exact: true }).count(), 0);
  await capture('wechat-authorized');

  const collapse = account.getByRole('button', { name: '收起账号管理' });
  const disclosure = await collapse.getAttribute('aria-controls');
  await collapse.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(id => {
    const node = document.getElementById(id);
    return node.hasAttribute('inert') && !node.contains(document.activeElement);
  }, disclosure), true);

  await page.getByRole('tab', { name: 'iMessage' }).click();
  await page.getByText('iMessage 仅在 macOS 上通过「信息」应用连接。').waitFor();
  assert.equal(await page.evaluate(() => window.__uiFixture.calls.some(([name]) => name === 'imessage')), false);
  dimensions = await page.locator('.muster-messaging-settings').evaluate(node => [node.scrollWidth, node.clientWidth]);
  assert.ok(dimensions[0] <= dimensions[1] + 1, 'the channel picker fits its container');
  await capture('platform-unavailable');
}
