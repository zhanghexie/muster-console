import assert from 'node:assert/strict';

export default async function ({ page, capture }) {
  const paper = page.locator('.file-doc-word section.docx');
  const title = paper.getByText('合成文档 · Word preview');
  await title.waitFor();
  const layout = await paper.evaluate(el => {
    const pageRect = el.getBoundingClientRect();
    const pane = el.closest('.file-doc');
    return {
      connected: el.isConnected,
      left: pageRect.left,
      paneLeft: pane.getBoundingClientRect().left,
      paperWidth: pageRect.width,
      paneWidth: pane.clientWidth,
      alignment: getComputedStyle(el.parentElement).alignItems,
      shadow: getComputedStyle(el).boxShadow
    };
  });
  assert.ok(layout.connected && layout.left >= layout.paneLeft);
  assert.ok(layout.paperWidth > layout.paneWidth);
  assert.equal(layout.alignment, 'flex-start');
  assert.notEqual(layout.shadow, 'none');
  const titleStyle = await title.evaluate(el => ({
    fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
    weight: Number.parseInt(getComputedStyle(el).fontWeight, 10)
  }));
  assert.ok(titleStyle.fontSize >= 24 && titleStyle.weight >= 700);
  await capture('word-page');
}
