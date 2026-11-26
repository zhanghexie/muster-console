/** 设置页分区重构（2026-10-19）的组件级验收：
 *  - 页头随页面滚动，标题下不画线；
 *  - 节序号：每个页签从 01 起、按 DOM 顺序递增；
 *  - 行组成块：.s-sec > .s-rows 有圆角与描边，块内没有行间分隔线；
 *  - 导航分组：组距 36px、行高 34px。
 * 截图仍需人眼复核，几何断言不等于视觉验收。 */
export default async function ({ page, theme, width, capture, assert }) {
  await page.waitForSelector('.settings-page .settings-col', { timeout: 15000 });
  const activePane = '.settings-tabpane.is-shown';

  const navGap = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.settings-nav-groups')).rowGap
  );
  assert.equal(navGap, '36px', `导航组距应为 36px，实际 ${navGap}`);
  const itemHeight = await page.evaluate(() =>
    Math.round(document.querySelector('.settings-nav-item').getBoundingClientRect().height)
  );
  assert.equal(itemHeight, 34, `导航行高应为 34px，实际 ${itemHeight}`);

  const head = await page.evaluate(() => {
    const el = document.querySelector('.settings-pane-title');
    const sheet = document.querySelector('.settings-sheet').getBoundingClientRect();
    const colRect = document.querySelector('.settings-col').getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      position: getComputedStyle(el).position,
      borderBottom: getComputedStyle(el).borderBottomWidth,
      ruleContent: getComputedStyle(el, '::after').content,
      offsetTop: Math.round(box.top - sheet.top),
      width: Math.round(box.width),
      colWidth: Math.round(colRect.width),
      sheetWidth: Math.round(sheet.width),
      // 负边距把页头铺满列宽（含 .settings-col 的 44px 左右内边距）
      widthDelta: Math.round(box.width - colRect.width),
      leftDelta: Math.round(box.left - colRect.left)
    };
  });
  assert.equal(head.position, 'static', `页头应随页面滚动，实际 ${head.position}`);
  assert.equal(head.borderBottom, '0px', `页头下缘不得有分隔线，实际 ${head.borderBottom}`);
  assert.ok(['none', 'normal'].includes(head.ruleContent), '页头不得通过伪元素画线');
  assert.ok(
    Math.abs(head.widthDelta) <= 1 && Math.abs(head.leftDelta) <= 1,
    `页头应铺满列宽：widthDelta=${head.widthDelta} leftDelta=${head.leftDelta}`
  );
  if (width >= 1440) {
    // 列上限 888（800 内容 + 两侧 44）；页头不得铺满整张仅页卡
    assert.equal(head.width, 888, `1440 宽下页头应为 888，实际 ${head.width}`);
    assert.ok(head.sheetWidth > head.width, `页头应窄于页卡，实际 sheet=${head.sheetWidth}`);
  }
  console.log(`[${theme}/${width}] header`, JSON.stringify(head));

  // 节标题不再带序号（用户裁决 2026-10-19）；只校验节数与标题可读
  const sections = await page.evaluate(pane =>
    [...document.querySelectorAll(`${pane} .s-sec-h h2`)].map(h2 => ({
      text: h2.textContent.trim(),
      before: getComputedStyle(h2, '::before').content
    })), activePane);
  assert.ok(sections.length >= 3, `通用页至少 3 节，实际 ${sections.length}`);
  for (const item of sections) {
    assert.ok(item.text.length > 0, '节标题不应为空');
    assert.ok(
      item.before === 'none' || item.before === 'normal',
      `节标题不应再渲染序号伪元素，实际 ${item.before}`
    );
  }

  const block = await page.evaluate(pane => {
    const rows = document.querySelector(`${pane} .s-sec > .s-rows`);
    if (!rows) return null;
    const style = getComputedStyle(rows);
    const paneBg = getComputedStyle(document.querySelector('.settings-sheet')).backgroundColor;
    return {
      radius: style.borderTopLeftRadius,
      background: style.backgroundColor,
      paneBg,
      // 块内不得再有行间分隔线：直接子行只允许 .is-divided 自带的边
      rowBorders: [...rows.children]
        .filter(node => node.classList.contains('s-row') || node.classList.contains('s-frow'))
        .map(node => getComputedStyle(node).borderBottomWidth)
    };
  }, activePane);
  assert.ok(block, '通用页应有 .s-sec > .s-rows 行组');
  assert.equal(block.radius, '12px', `行组圆角应为 12px，实际 ${block.radius}`);
  assert.notEqual(block.background, block.paneBg, '行组底色应与页面底色区分开');
  assert.ok(
    block.rowBorders.every(w => w === '0px'),
    `行组内不应有行间分隔线，实际 ${JSON.stringify(block.rowBorders)}`
  );

  // 行内控件右缘到块右缘必须等于块内边距（18px）：贴边说明行没吃到 padding
  const inset = await page.evaluate(pane => {
    const rows = document.querySelector(`${pane} .s-rows`);
    const controls = [...rows.querySelectorAll('.s-row-r')];
    const last = controls[controls.length - 1];
    return Math.round(rows.getBoundingClientRect().right - last.getBoundingClientRect().right);
  }, activePane);
  assert.equal(inset, 18, `行内控件右侧留白应为 18，实际 ${inset}`);

  // 页头标题、说明、节标题、行组左缘必须齐平
  const align = await page.evaluate(pane => {
    const left = sel => Math.round(document.querySelector(`${pane} ${sel}`).getBoundingClientRect().left);
    return { head: left('.settings-pane-title h1'), lead: left('.settings-pane-title p'), section: left('.s-sec-h'), rows: left('.s-rows') };
  }, activePane);
  assert.equal(new Set(Object.values(align)).size, 1, `页头与节标题左缘应齐平，实际 ${JSON.stringify(align)}`);

  // 800px 下长文本/控件不得顶出卡片
  const overflow = await page.evaluate(pane =>
    [...document.querySelectorAll(`${pane} .s-rows, ${pane} .s-sec`)]
      .filter(node => node.scrollWidth > node.clientWidth + 1)
      .map(node => node.className), activePane);
  assert.deepEqual(overflow, [], `行组/节不得横向溢出：${JSON.stringify(overflow)}`);

  await capture('general-top');

  // 页头和内容同步滚动，位移与页签的滚动距离一致。
  const before = head.offsetTop;
  await page.evaluate(pane => {
    const scroller = document.querySelector(pane);
    scroller.scrollTop = 320;
  }, activePane);
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => {
    const el = document.querySelector('.settings-pane-title');
    const sheet = document.querySelector('.settings-sheet').getBoundingClientRect();
    return Math.round(el.getBoundingClientRect().top - sheet.top);
  });
  const scrolled = await page.evaluate(pane => document.querySelector(pane).scrollTop, activePane);
  assert.ok(scrolled >= 300, `通用页应可滚动，实际 scrollTop=${scrolled}`);
  assert.ok(Math.abs(before - after - scrolled) <= 1, `页头应随页面滚动：${before} → ${after}，滚动 ${scrolled}px`);
  await capture('general-scrolled');

  // 换页：块仍在
  await page.getByRole('button', { name: '通知', exact: true }).click();
  await page.waitForSelector('.settings-tabpane[data-settings-item="notify"].is-shown');
  const notify = await page.evaluate(() => {
    const pane = document.querySelector('.settings-tabpane[data-settings-item="notify"]');
    return {
      sections: pane.querySelectorAll('.s-sec-h h2').length,
      blocks: [...pane.querySelectorAll('.s-sec > .s-rows')].every(rows =>
        getComputedStyle(rows).borderTopLeftRadius === '12px')
    };
  });
  assert.ok(notify.sections >= 2, `通知页应有多个节，实际 ${notify.sections}`);
  assert.ok(notify.blocks, '通知页的每个行组都应成块');
  await capture('notify');

  // 模型与输入：滚动发生在页签容器上，页头和设置内容一起移动。
  // 内滚会让页头下方留出死区，内容再被自身滚动边缘硬切出半行（用户报的「空白 + 半行」）。
  await page.getByRole('button', { name: '模型与输入', exact: true }).click();
  await page.waitForSelector('.settings-tabpane[data-settings-item="agent"].is-shown');
  await page.waitForTimeout(200);
  const agent = await page.evaluate(() => {
    const pane = document.querySelector('.settings-tabpane[data-settings-item="agent"]');
    const style = getComputedStyle(pane);
    const inner = [...pane.querySelectorAll('*')].filter(el => {
      const s = getComputedStyle(el);
      return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
    });
    return {
      overflowY: style.overflowY,
      scrollable: pane.scrollHeight > pane.clientHeight + 1,
      innerScrollers: inner.map(el => el.className)
    };
  });
  assert.equal(agent.overflowY, 'auto', `模型与输入应在 tabpane 内滚动，实际 ${agent.overflowY}`);
  assert.deepEqual(agent.innerScrollers, [], `页内不应再有自己的滚动容器：${JSON.stringify(agent.innerScrollers)}`);
  await capture('agent');

  // 折叠行 hover 底必须向内收：铺到块边会盖住 1px inset 描边，并从圆角外露
  const firstProvider = page.locator('.settings-tabpane[data-settings-item="agent"] .llm-provider > summary').first();
  await firstProvider.hover();
  await page.waitForTimeout(120);
  const hoverGeom = await page.evaluate(() => {
    const list = document.querySelector('.settings-tabpane[data-settings-item="agent"] .llm-provider-list');
    const summary = list.querySelector('.llm-provider > summary');
    const lb = list.getBoundingClientRect();
    const sb = summary.getBoundingClientRect();
    return {
      left: Math.round(sb.left - lb.left),
      right: Math.round(lb.right - sb.right),
      bg: getComputedStyle(summary).backgroundColor
    };
  });
  assert.ok(
    hoverGeom.left >= 6 && hoverGeom.right >= 6,
    `折叠行 hover 底应向块内收（左 ${hoverGeom.left} / 右 ${hoverGeom.right}）`
  );
  assert.notEqual(hoverGeom.bg, 'rgba(0, 0, 0, 0)', 'hover 时折叠行应有底色');

  // 全局不变式：块内任何有底色的元素都不许贴到块的四边（会盖住 1px inset 描边、从圆角外露）
  const bleed = await page.evaluate(() => {
    const out = [];
    const cards = document.querySelectorAll(
      '.settings-tabpane.is-shown .s-sec > .s-rows, .settings-tabpane.is-shown .s-sec > .llm-provider-list, ' +
      '.settings-tabpane.is-shown .s-sec > .rt-list, .settings-tabpane.is-shown .s-sec > .theme-groups, ' +
      '.settings-tabpane.is-shown .s-sec > .s-adv'
    );
    for (const card of cards) {
      const cb = card.getBoundingClientRect();
      for (const el of card.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        const painted = style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.backgroundImage !== 'none';
        if (!painted) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.left <= cb.left + 1 || r.right >= cb.right - 1 || r.top <= cb.top + 1 || r.bottom >= cb.bottom - 1) {
          out.push(`${el.className || el.tagName}`);
        }
      }
    }
    return out;
  });
  assert.deepEqual(bleed, [], `块内底色元素不得贴边：${JSON.stringify(bleed)}`);

  // 未覆盖：外观 / 能力管理 / 模型与输入 三页在本夹具下会崩——ThemePane 的主题订阅
  // 传回调函数，夹具的结构化克隆桩直接抛错，整棵树随之中止。能力管理另有
  // capability-management.css 自己的 1000px 列与 cm-* 布局，不受本次列宽影响；
  // 另两页仅列宽收窄，需真实应用或补齐夹具后单独验收。
  return { theme, width, head, sections: sections.length, notify, block: { radius: block.radius } };
}
