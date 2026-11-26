const { chromium } = require('playwright');
const path = require('path');

const fileUrl = () => 'file:///' + path.resolve(__dirname, 'extension-agent-examples.html').replace(/\\/g, '/');

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await page.goto(fileUrl());

    await page.locator('[data-task-toggle="d1"]').click();
    assert((await page.locator('#agent-context').innerText()).includes('人 · 已完成'), 'human action did not update agent state');

    await page.locator('#prompt').fill('给我加个明天的待办：写接口说明');
    await page.locator('#send').click();
    assert((await page.locator('#surface').innerText()).includes('写接口说明'), 'agent todo did not update main surface');

    await page.locator('[data-app="gomoku"]').click();
    await page.locator('[data-cell="4,4"]').click();
    assert((await page.locator('#agent-context').innerText()).includes('moves:1'), 'human move did not update agent state');

    await page.locator('#prompt').fill('帮我下两步');
    await page.locator('#send').click();
    assert((await page.locator('#agent-context').innerText()).includes('moves:3'), 'agent moves did not update main surface');

    await page.locator('[data-app="books"]').click();
    await page.locator('#prompt').fill('整理下我的书架，按类型分类');
    await page.locator('#send').click();
    assert(await page.locator('.metric').nth(1).locator('b').innerText() === '0', 'agent book organization did not update main surface');

    await page.locator('#toggle-agent').click();
    assert((await page.locator('#layout').getAttribute('class')).includes('closed'), 'agent sidebar did not close');
    await page.locator('#toggle-agent').click();
    assert(!(await page.locator('#layout').getAttribute('class')).includes('closed'), 'agent sidebar did not reopen');

    console.log('extension-agent-examples smoke: PASS');
  } finally {
    await browser.close();
  }
})();
