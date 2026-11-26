export default async function ({ page, capture, assert }) {
  const host = page.locator('[data-case=mailbox] .chat-msg');
  await host.waitFor();
  assert.equal(await host.locator('.chat-msg-avatar').getAttribute('data-avatar-sender'), 'host');
  assert.equal(await host.locator('h1,h2,h3,h4,h5,h6').count(), 0);
  const metrics = await page.evaluate(() => {
    const font = s => { const c = getComputedStyle(document.querySelector(s)); return parseFloat(c.fontSize); };
    return { host: font('[data-case=mailbox] .chat-text'), normal: font('[data-case=normal] .chat-text'),
      overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.ok(metrics.host <= metrics.normal, '收信提醒不能放大为标题');
  assert.equal(metrics.overflow, false);
  await capture('mailbox-host-identity');
}
