/** 设置页 12 个页签的分区盘点（临时审计用）：
 * 逐页截图，并输出每节的内容容器类名，用来找出「有节标题但没有成块」的页。
 * 运行：capture-component --fixture settings-save-motion.tsx --scenario 本文件 --themes dark */
const TABS = ['通用', '外观', '模型与输入', '能力管理', '调度 Agent', 'Worker', '记忆', '文本工具', '通知', '远程访问', '快捷键', '关于'];

export default async function ({ page, theme, width, capture }) {
  await page.waitForSelector('.settings-page .settings-col', { timeout: 15000 });
  const report = [];
  for (const [index, label] of TABS.entries()) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForTimeout(260);
    const info = await page.evaluate(() => {
      const pane = document.querySelector('.settings-tabpane.is-shown');
      const title = pane.querySelector('.settings-pane-title h1')?.textContent ?? '';
      const sections = [...pane.querySelectorAll('.s-sec')].map(sec => ({
        title: sec.querySelector('.s-sec-h h2')?.textContent ?? '',
        num: getComputedStyle(sec.querySelector('.s-sec-h h2'), '::before').content,
        children: [...sec.children]
          .filter(node => !node.classList.contains('s-sec-h'))
          .map(node => {
            const style = getComputedStyle(node);
            return {
              cls: node.className,
              radius: style.borderTopLeftRadius,
              bg: style.backgroundColor
            };
          })
      }));
      // 行内控件右缘到块右缘的留白：应等于块的左右内边距（18），不能贴边
      const rowsBox = pane.querySelector('.s-rows');
      const controls = rowsBox ? [...rowsBox.querySelectorAll('.s-row-r')] : [];
      const lastControl = controls[controls.length - 1];
      const inset = rowsBox && lastControl
        ? Math.round(rowsBox.getBoundingClientRect().right - lastControl.getBoundingClientRect().right)
        : null;
      // 横向溢出：块内长文本/控件不得顶出卡片（scrollWidth 大于 clientWidth 即溢出）
      const overflow = [...pane.querySelectorAll('.s-rows, .s-sec, .settings-col')]
        .filter(node => node.scrollWidth > node.clientWidth + 1)
        .map(node => {
          const edge = node.getBoundingClientRect().right;
          const culprits = [...node.querySelectorAll('*')]
            .filter(child => child.getBoundingClientRect().right > edge + 1)
            .slice(0, 4)
            .map(child => `${child.className || child.tagName}`)
            .join('|');
          return `${node.className}: ${node.scrollWidth}>${node.clientWidth} @${culprits}`;
        });
      // 谁是这一页真正的滚动容器：overflow 不是 visible/auto 的话就滚不动
      const paneEl = document.querySelector('.settings-tabpane.is-shown');
      const scrollers = [paneEl, ...paneEl.querySelectorAll('*')]
        .filter(el => {
          const style = getComputedStyle(el);
          return /(auto|scroll|hidden)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        })
        .map(el => `${el.className}: ${el.scrollHeight}/${el.clientHeight} ov=${getComputedStyle(el).overflowY}`)
        .slice(0, 3);
      // 全局扫描：块内任何「有底色的元素」都不许贴到块的四边——会盖掉 1px inset 描边，
      // 并从 12px 圆角外露。左右靠负边距内收，上下靠块自身的垂直内边距。
      const cardSel = '.s-sec > .s-rows, .s-sec > .llm-provider-list, .s-sec > .rt-list, .s-sec > .theme-groups, .s-sec > .s-adv';
      const bleed = [];
      for (const card of paneEl.querySelectorAll(cardSel)) {
        const cb = card.getBoundingClientRect();
        for (const el of card.querySelectorAll('*')) {
          const style = getComputedStyle(el);
          const painted = style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.backgroundImage !== 'none';
          if (!painted) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const sides = [];
          if (r.left <= cb.left + 1) sides.push('L');
          if (r.right >= cb.right - 1) sides.push('R');
          if (r.top <= cb.top + 1) sides.push('T');
          if (r.bottom >= cb.bottom - 1) sides.push('B');
          if (sides.length) bleed.push(`${el.parentElement?.className || ''} > ${el.className || el.tagName}[${sides.join('')}] card=${card.className} d=${Math.round(cb.bottom - r.bottom)}/${Math.round(r.top - cb.top)}`);
        }
      }
      const headerRect = paneEl.querySelector('.settings-pane-title')?.getBoundingClientRect();
      const firstBlock = paneEl.querySelector('.s-sec > .s-rows, .s-sec > .llm-provider-list, .s-sec > .rt-list');
      const firstBlockTop = firstBlock?.getBoundingClientRect().top;
      return {
        title,
        inset,
        scroll: scrollers,
        bleed,
        // 页头下缘到第一个块顶边的距离：>0 说明页头与内容之间有一段死区
        headerGap: headerRect && typeof firstBlockTop === 'number'
          ? Math.round(firstBlockTop - headerRect.bottom)
          : null,
        overflow,
        // 页头标题左缘 vs 节标题左缘：两者必须齐平，否则整页看起来是歪的
        align: {
          head: Math.round(pane.querySelector('.settings-pane-title h1')?.getBoundingClientRect().left ?? -1),
          lead: Math.round(pane.querySelector('.settings-pane-title p')?.getBoundingClientRect().left ?? -1),
          section: Math.round(pane.querySelector('.s-sec-h')?.getBoundingClientRect().left ?? -1),
          rows: Math.round(pane.querySelector('.s-rows')?.getBoundingClientRect().left ?? -1)
        },
        sections
      };
    });
    report.push({ tab: label, ...info });
    await capture(`tab-${index}`);
    // 外观页的配色分组与动作行在首屏之下，单独滚一段看清
    if (label === '外观' || label === 'Worker' || label === '模型与输入') {
      const tops = label === '模型与输入' ? [300, 620, 900] : [430, 980];
      for (const [i, top] of tops.entries()) {
        await page.evaluate(y => {
          document.querySelector('.settings-tabpane.is-shown').scrollTop = y;
        }, top);
        await page.waitForTimeout(160);
        await capture(`tab-${index}-scrolled${i}`);
      }
    }
    // 折叠行 hover：高亮底必须向内收，不能盖住块的描边或从圆角外露
    if (label === '模型与输入') {
      await page.evaluate(() => {
        document.querySelector('.settings-tabpane.is-shown').scrollTop = 0;
      });
      const row = page.locator('.llm-provider').nth(1).locator('summary');
      if (await row.count()) {
        await row.hover();
        await page.waitForTimeout(160);
        await capture(`tab-${index}-hover`);
      }
    }
  }
  console.log('PARTITION_AUDIT ' + JSON.stringify(report));
  return { theme, width };
}
