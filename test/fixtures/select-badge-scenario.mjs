/** 打开运行方式下拉，确认每个选项右侧有 GUI/TUI 胶囊且不挤压名称。 */
export default async function ({ page, capture, assert }) {
  await page.waitForSelector('.c-select-trigger', { timeout: 10000 });
  await page.locator('.c-select-trigger').click();
  await page.waitForSelector('.c-select-item', { timeout: 5000 });
  await page.waitForTimeout(180);

  const badges = await page.evaluate(() =>
    [...document.querySelectorAll('.c-select-item')].map(item => ({
      label: item.querySelector('.c-select-item-label')?.textContent ?? '',
      badge: item.querySelector('.c-select-badge')?.textContent ?? '',
      // 胶囊右缘不得超出选项右缘
      overflow: Math.round(item.getBoundingClientRect().right - (item.querySelector('.c-select-badge')?.getBoundingClientRect().right ?? 0))
    }))
  );
  assert.equal(badges.length, 5, `应有 5 个选项，实际 ${badges.length}`);
  for (const row of badges) {
    assert.ok(row.badge === 'GUI' || row.badge === 'TUI', `选项「${row.label}」缺少 GUI/TUI 胶囊`);
    assert.ok(row.overflow >= 0, `胶囊超出选项右缘 ${row.overflow}px`);
  }
  assert.deepEqual(badges.map(r => r.badge), ['TUI', 'TUI', 'GUI', 'GUI', 'GUI'], '胶囊顺序应与选项一致');

  // 胶囊必须真的"看得出来"：描边与所处方底的对比度、文字与胶囊底的对比度
  const contrast = await page.evaluate(() => {
    const parse = (css) => {
      const n = css.match(/[\d.]+/g).map(Number);
      return { rgb: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 };
    };
    const lum = ([r, g, b]) => {
      const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    // 半透明色要先叠到底上再算亮度，否则 alpha 被忽略
    const over = (fg, bg) => fg.rgb.map((c, i) => Math.round(c * fg.a + bg[i] * (1 - fg.a)));
    const row = document.querySelector('.c-select-item:checked, .c-select-item.is-selected');
    const pill = row?.querySelector('.c-select-badge');
    if (!pill) return null;
    const ps = getComputedStyle(pill);
    const rowBg = getComputedStyle(row).backgroundColor;
    const surface = parse(rowBg === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.body).backgroundColor : rowBg);
    const surfaceRgb = over(surface, [255, 255, 255]);
    return {
      borderVsSurface: Number(ratio(over(parse(ps.borderTopColor), surfaceRgb), surfaceRgb).toFixed(2)),
      textVsFill: Number(ratio(over(parse(ps.color), surfaceRgb), over(parse(ps.backgroundColor), surfaceRgb)).toFixed(2))
    };
  });
  assert.ok(contrast, '缺少胶囊用于对比度测量');
  assert.ok(contrast.borderVsSurface >= 1.25, `胶囊描边与底面对比度过低：${contrast.borderVsSurface}`);
  assert.ok(contrast.textVsFill >= 4.5, `胶囊文字与胶囊底对比度过低：${contrast.textVsFill}`);
  console.log('BADGE_CONTRAST ' + JSON.stringify(contrast));

  await capture('menu-open');
  return { badges, contrast };
}
