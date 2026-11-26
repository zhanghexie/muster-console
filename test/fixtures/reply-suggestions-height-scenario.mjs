export default async function ({page, capture, assert}) {
  const editor = page.getByRole('textbox');
  async function sampleDuring(action) {
    await page.evaluate(() => {
      window.heightSamples = []; window.samplingHeight = true;
      function sample() {
        const header = document.querySelector('.composer-actions-header');
        const accs = [...header.querySelectorAll(':scope > .acc')];
        const shell = document.querySelector('.chat-input-shell');
        const wrap = document.querySelector('.agent-chat-composer-wrap');
        window.heightSamples.push({header:header.getBoundingClientRect().height,
          acc:Math.max(0,...accs.map(a=>a.getBoundingClientRect().height)),
          shell:shell.getBoundingClientRect().height, wrap:wrap.getBoundingClientRect().height});
        if (window.samplingHeight) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    await action(); await page.waitForTimeout(700);
    return await page.evaluate(() => {window.samplingHeight = false; return window.heightSamples;});
  }
  function checkHeader(samples, label) {
    assert.ok(samples.length >= 8, `${label}: collect animation frames`);
    assert.ok(samples.some(s => s.acc > 2 && s.acc < samples[0].acc - 2), `${label}: accordion actually animated`);
    assert.ok(samples.every(s => Math.abs(s.header - s.acc) < 1), `${label}: no residual header padding`);
    if (label !== 'queue capsule') assert.ok(samples[0].shell - samples.at(-1).shell > 30, `${label}: shell shrinks`);
  }
  const clear = page.getByRole('button', {name:'清除本轮建议'});
  await clear.waitFor(); await page.waitForTimeout(500); await capture('suggestions-open');
  let samples = await sampleDuring(() => clear.click()); checkHeader(samples, 'suggestion');
  assert.ok(samples[0].wrap - samples.at(-1).wrap > 30, 'overlay spring follows content');
  await capture('suggestions-closed');
  await editor.click(); await editor.pressSequentially('/quickInput'); await editor.press('Enter');
  const cancel = page.getByRole('button', {name:'取消命令'});
  await cancel.waitFor(); await page.waitForTimeout(500); await capture('quick-open');
  samples = await sampleDuring(() => cancel.click()); checkHeader(samples, 'quickInput');
  await capture('quick-closed');
  await editor.click(); await editor.pressSequentially('测试队列');
  await page.getByRole('button', {name:'留待确认'}).click();
  await page.getByRole('button', {name:'收起排队面板'}).click();
  const expand = page.getByRole('button', {name:'展开排队面板'});
  await expand.waitFor(); await page.waitForTimeout(600);
  await editor.click(); await editor.pressSequentially('/quickInput'); await editor.press('Enter');
  await cancel.waitFor(); await page.waitForTimeout(500);
  samples = await sampleDuring(() => cancel.click());
  assert.ok(samples.every(s => Math.abs(s.header - s.acc) < 1), 'mixed header follows the tallest remaining fold');
  assert.ok(Math.abs(samples[0].header - samples.at(-1).header) < 1, 'queue keeps its spacing when command closes');
  await page.waitForTimeout(300);
  samples = await sampleDuring(() => expand.click()); checkHeader(samples, 'queue capsule');
  await page.getByRole('button', {name:'取回输入框编辑'}).click();
  await editor.press('Control+a'); await editor.press('Backspace'); await page.waitForTimeout(600);
  const input = page.locator('input[type=file]');
  await input.setInputFiles({name:'test.png', mimeType:'image/png', buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=', 'base64')});
  const remove = page.getByRole('button', {name:'移除图片'});
  await remove.waitFor(); await page.waitForTimeout(500); await capture('attachment-open');
  samples = await sampleDuring(() => remove.click());
  const start=samples[0].shell, end=samples.at(-1).shell;
  assert.ok(start-end > 40, 'attachment tray changes shell height');
  assert.ok(samples.some(s=>s.shell < start-2 && s.shell > end+2), 'attachment tray animates closed');
  await capture('attachment-closed');
}
