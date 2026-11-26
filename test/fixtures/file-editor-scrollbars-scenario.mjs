import assert from 'node:assert/strict';
export default async function run({ page, capture }) {
  const pageInsets = await page.evaluate(() => {
    const shell = document.createElement('div');
    shell.className = 'right-workspace-split';
    shell.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;display:block;visibility:hidden';
    shell.innerHTML = '<div class="right-workspace-content"><div class="right-content-page files-panel"></div><div class="right-content-page browser-fixture"></div></div>';
    document.body.append(shell);
    const host = shell.firstElementChild;
    const gap = el => host.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
    const result = { file: gap(host.children[0]), browser: gap(host.children[1]), collapsed: 0 };
    shell.classList.add('resources-collapsed');
    result.collapsed = gap(host.children[0]);
    shell.remove();
    return result;
  });
  assert.deepEqual(pageInsets, { file: 4, browser: 0, collapsed: 0 }, 'only file pages reserve the divider inset');
  await page.locator('.file-editor-preview-md').waitFor();
  await page.locator('.file-editor-preview-md').hover();
  const preview = await page.locator('.file-editor-preview-md').boundingBox();
  await capture('preview');
  await page.getByRole('tab', { name: '编辑', exact: true }).click();
  await page.locator('.file-editor-cm .cm-scroller').hover();
  await page.waitForTimeout(250);
  const geometry = await page.evaluate(() => {
    const scroller = document.querySelector('.cm-scroller'), host = document.querySelector('.file-editor-cm');
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    return { scroll: rect(scroller), host: rect(host), gutterX: scroller.offsetWidth - scroller.clientWidth, gutterY: scroller.offsetHeight - scroller.clientHeight,
      overflowX: getComputedStyle(scroller).overflowX, overflowY: getComputedStyle(scroller).overflowY,
      scrollbarWidth: getComputedStyle(scroller).scrollbarWidth };
  });
  await capture('edit');
  console.log(JSON.stringify({ preview, ...geometry }));
  assert.ok(geometry.scroll.right <= geometry.host.right + .5, 'vertical scrollbar stays inside host');
  assert.ok(geometry.scroll.bottom <= geometry.host.bottom + .5, 'horizontal scrollbar stays inside host');
  assert.ok(Math.abs(geometry.scroll.right - preview.x - preview.width) < 1, 'edit/preview right edges match');
  const editorSpacing = await page.locator('.cm-editor').evaluate(el => {
    const css = getComputedStyle(el);
    return { padding: css.padding, margin: css.margin };
  });
  assert.equal(editorSpacing.padding, '0px', 'settings textarea styling must not leak into CodeMirror');
  assert.equal(editorSpacing.margin, '0px');
  const sizing = await page.locator('.cm-scroller').evaluate(el => {
    const css = getComputedStyle(el);
    return { minHeight: css.minHeight, minWidth: css.minWidth, width: css.scrollbarWidth };
  });
  assert.equal(sizing.minHeight, '0px', 'editor viewport can shrink with horizontal scrollbar present');
  assert.equal(sizing.minWidth, '0px');
  assert.equal(sizing.width, 'auto', 'custom track styling is enabled in Chromium');
  await page.locator('.cm-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; el.scrollLeft = el.scrollWidth; });
  await capture('edit-bottom-right');
  await page.getByRole('tab', { name: '预览', exact: true }).click();
  await page.getByRole('tab', { name: '编辑', exact: true }).click();
  await page.waitForTimeout(250);
  const stillContained = await page.locator('.cm-scroller').evaluate(el => el.getBoundingClientRect().bottom <= el.closest('.file-editor-cm').getBoundingClientRect().bottom + .5);
  assert.ok(stillContained, 'switching modes preserves unclipped scrollbar geometry');
  // Stress the legacy Chromium scrollbar fallback even when headless uses overlays.
  await page.addStyleTag({ content: `.cm-scroller { scrollbar-width: auto !important; scrollbar-gutter: stable !important; }
    .file-editor-cm .cm-scroller::-webkit-scrollbar-thumb { background: #888 !important; }` });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const legacy = await page.locator('.cm-scroller').evaluate(el => ({
    x: el.offsetWidth - el.clientWidth, y: el.offsetHeight - el.clientHeight,
    bottom: el.getBoundingClientRect().bottom, hostBottom: el.closest('.file-editor-cm').getBoundingClientRect().bottom,
    track: getComputedStyle(el, '::-webkit-scrollbar').width,
    inner: el.innerHTML.slice(0, 50)
  }));
  console.log('legacy', JSON.stringify(legacy));
  await capture('legacy-tracks');
  assert.equal(legacy.x, 8, 'legacy vertical track uses preview-sized 8px width');
  assert.equal(legacy.y, 8, 'full legacy horizontal track is allocated');
  assert.ok(legacy.bottom <= legacy.hostBottom + .5);
}
