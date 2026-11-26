/** Browser geometry regression for the real shared path field; deliberately takes no screenshots. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({ entryPoints: [path.join(root, 'test/fixtures/settings-path-layout.tsx')], bundle: true, write: false,
  platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const executable = process.env.CHROME_EXECUTABLE || (process.platform === 'win32' && fs.existsSync(windowsChrome) ? windowsChrome : undefined);
const browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.setContent('<div id="root"></div>');
  for (const file of ['src/renderer/src/styles/base.css', 'src/renderer/src/styles/settings.css',
    'src/renderer/src/components/settings/settings-path-field.css', 'src/renderer/src/components/settings/worker-pane.css', 'src/renderer/src/components/settings/settings-content.css',
    'src/renderer/src/components/settings/capability-management.css', 'src/renderer/src/components/settings/settings-resource.css']) {
    await page.addStyleTag({ path: path.join(root, file) });
  }
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const id of ['resource', 'capability', 'content']) {
    const section = page.locator(`#${id}`);
    await section.locator('.s-path-control > input').waitFor();
    for (const width of [640, 400, 180]) {
      await section.evaluate((node, w) => { node.style.width = `${w}px`; }, width);
      const boxes = await section.locator('.s-path-control').evaluate(node => {
        const input = node.querySelector('input').getBoundingClientRect();
        const button = node.querySelector('button').getBoundingClientRect();
        const container = node.getBoundingClientRect();
        return { input: { left: input.left, top: input.top, right: input.right, bottom: input.bottom },
          button: { left: button.left, top: button.top, right: button.right, bottom: button.bottom },
          container: { left: container.left, right: container.right } };
      });
      if (width > 180) {
        assert.ok(boxes.button.top < boxes.input.bottom && boxes.button.bottom > boxes.input.top, `${id} ${width}px: path and button should share a row`);
        assert.ok(boxes.button.left >= boxes.input.right, `${id} ${width}px: path and button must not overlap`);
      } else assert.ok(boxes.button.top >= boxes.input.bottom, `${id} ${width}px: controls should wrap when space is insufficient`);
      assert.ok(boxes.input.left >= boxes.container.left && boxes.input.right <= boxes.container.right + 1, `${id} ${width}px: path overflows`);
      assert.ok(boxes.button.left >= boxes.container.left && boxes.button.right <= boxes.container.right + 1, `${id} ${width}px: button overflows`);
    }
  }
  console.log('settings-path-layout: ok');
} finally { await browser.close(); }
