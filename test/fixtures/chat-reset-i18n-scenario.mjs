export default async function ({ page, capture, assert, width }) {
  const dialog = page.getByRole('dialog', { name: 'Reset dispatcher conversation?' });
  await dialog.waitFor();
  await page.getByRole('button', {name:'Fill memory prompt'}).waitFor();
  const metrics = await dialog.evaluate(el => { const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,scroll:el.scrollWidth,width:el.clientWidth}; });
  assert.ok(metrics.left >= 8 && metrics.right <= width - 8, `dialog must fit viewport: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.scroll <= metrics.width + 1, 'dialog must not overflow horizontally');
  await capture('reset-en');
  await page.getByRole('button', {name:'Cancel'}).click();
}
