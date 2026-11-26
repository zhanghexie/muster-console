export default async function ({ page, capture, assert }) {
  const root = page.locator('.agent-ws-stack:not(.agent-ws-stack-ghost)');
  const row = id => root.locator(`[data-workspace-sort-id="${id}"]`);
  const order = () => root.locator('[data-workspace-sort-id]').evaluateAll(els => els.map(el => el.dataset.workspaceSortId));
  const assertCurrentMarker = async id => {
    const markers = await root.locator('.agent-notify-bubble').evaluateAll(bubbles => bubbles.flatMap(bubble => {
      const marker = getComputedStyle(bubble, '::after');
      if (marker.content !== '""') return [];
      return [{
        id: bubble.closest('[data-workspace-sort-id]').dataset.workspaceSortId,
        width: marker.width, height: marker.height, clipPath: marker.clipPath,
        pointerEvents: marker.pointerEvents
      }];
    }));
    assert.deepEqual(markers, [{ id, width: '2px', height: '12px', clipPath: 'none', pointerEvents: 'none' }],
      'only the current workspace shows the straight marker');
  };
  await row('ws-0').waitFor();
  const docked = await root.evaluate(stack => !!stack.closest('.left-ws-slot'));
  if (docked) {
    const session = page.locator('[data-session-row="session-0"]');
    await session.hover();
    await session.locator('.session-reltime').waitFor({ state: 'hidden' });
  }
  await capture('before');
  const corners = await root.locator('.agent-notify-bubble').evaluateAll(bubbles => {
    const { dataset } = document.documentElement;
    const panel = document.querySelector('.terminal-page > .center-panel');
    const shape = element => {
      const style = getComputedStyle(element);
      return `${style.borderRadius} / ${style.getPropertyValue('corner-shape')}`;
    };
    const cases = ['', 'mica', 'vibrancy'].map(material => {
      dataset.nativeMaterial = material;
      const rows = [...bubbles, ...document.querySelectorAll('[data-session-row]')];
      return { material, panel: shape(panel), rows: rows.map(shape) };
    });
    delete dataset.nativeMaterial;
    return cases;
  });
  for (const { material, panel, rows } of corners) {
    assert.ok(rows.every(shape => shape === panel), `sidebar row corners match the center panel (${material || 'solid'})`);
  }
  if (docked) {
    const geometry = await page.evaluate(() => {
      const session = document.querySelector('[data-session-row="session-0"]');
      const workspace = document.querySelector('[data-workspace-sort-id="ws-2"] .agent-notify-bubble');
      const measure = (row, icon, title, action, next) => {
        const bounds = row.getBoundingClientRect();
        const glyph = row.querySelector(icon).getBoundingClientRect();
        return {
          height: bounds.height,
          iconWidth: glyph.width,
          iconHeight: glyph.height,
          iconX: glyph.left - bounds.left,
          iconY: glyph.top - bounds.top,
          titleX: row.querySelector(title).getBoundingClientRect().left - bounds.left,
          actionInset: bounds.right - row.querySelector(action).getBoundingClientRect().right,
          rowGap: document.querySelector(next).getBoundingClientRect().top - bounds.bottom
        };
      };
      return {
        session: measure(session, '.session-harness-icon > *', '.session-name-text', '.session-row-tools', '[data-session-row="session-1"]'),
        workspace: measure(workspace, '.agent-avatar-img', '.agent-notify-text', '.agent-notify-chat',
          '[data-workspace-sort-id="ws-3"] .agent-notify-bubble')
      };
    });
    assert.deepEqual(geometry.workspace, geometry.session, 'workspace content aligns with the top-level session row');
  }
  await assertCurrentMarker('ws-2');
  const sizes = await row('ws-2').locator('.agent-float-avatar').evaluate(avatar => {
    const bounds = avatar.getBoundingClientRect();
    const y = bounds.top + bounds.height / 2;
    return {
      button: bounds.width,
      icon: avatar.querySelector('img').getBoundingClientRect().width,
      edgesClickable: [bounds.left + 1, bounds.right - 1].every(x => avatar.contains(document.elementFromPoint(x, y)))
    };
  });
  assert.equal(sizes.button, docked ? 24 : 32, 'workspace avatar retains its button target');
  assert.equal(sizes.icon, docked ? 14 : 26, 'workspace avatar uses the icon size of its layout');
  assert.ok(sizes.edgesClickable, 'avatar hit area extends beyond the image');
  const first = await row('ws-0').boundingBox(), last = await row('ws-3').boundingBox();
  const x = first.x + 70, start = first.y + first.height / 2;
  await page.mouse.move(x, start); await page.mouse.down();
  await page.waitForTimeout(120);
  assert.equal(await row('ws-0').getAttribute('data-sort-pressing'), 'true');
  await capture('holding', { animations: 'allow' });
  await page.waitForFunction(() => !!document.querySelector('[data-sorting="true"]'));
  // Halfway between slots: the actual row, not a second copy, follows the pointer.
  const y = last.y - 4;
  await page.mouse.move(x, y, { steps: 8 }); await page.waitForTimeout(60);
  const dragging = await row('ws-0').boundingBox();
  assert.ok(Math.abs(dragging.y + dragging.height / 2 - y) < 2, 'drag must follow pointer');
  assert.deepEqual(await order(), ['ws-0', 'ws-1', 'ws-2', 'ws-3'], 'drag keeps DOM nodes stable');
  await capture('dragging', { animations: 'allow' });
  await page.mouse.move(x, last.y + last.height / 2); await page.mouse.up();
  await page.waitForTimeout(350);
  assert.deepEqual(await order(), ['ws-1', 'ws-2', 'ws-3', 'ws-0']);
  await capture('dropped');
  const beforeCancel = await order();
  const box = await row('ws-0').boundingBox();
  await page.mouse.move(x, box.y + box.height / 2); await page.mouse.down();
  await page.waitForFunction(() => !!document.querySelector('[data-sorting="true"]'));
  await page.mouse.move(x, first.y + first.height / 2);
  await page.keyboard.press('Escape'); await page.mouse.up(); await page.waitForTimeout(350);
  assert.deepEqual(await order(), beforeCancel);
  // The active workspace is not first: expansion must preserve the original grab point.
  await root.locator('.agent-ws-stack-header').hover();
  await root.locator('.agent-ws-collapse-btn').click(); await page.waitForTimeout(450);
  assert.ok((await root.getAttribute('class')).includes('is-collapsed'));
  await assertCurrentMarker('ws-2');
  await capture('collapsed');
  const collapsed = await row('ws-2').boundingBox();
  await page.mouse.move(x, collapsed.y + collapsed.height / 2); await page.mouse.down();
  await page.waitForFunction(() => !!document.querySelector('[data-sorting="true"]'));
  const expanded = await row('ws-2').boundingBox();
  const drop = await root.evaluate(el => ({ target: parseFloat(el.style.getPropertyValue('--ws-drop-top')),
    actual: new DOMMatrix(getComputedStyle(el, '::before').transform).m42 }));
  assert.ok(Math.abs(drop.actual - drop.target) < 1, 'drop slot must appear at its target immediately');
  assert.ok(Math.abs(expanded.y - collapsed.y) < 2, 'expanding keeps the grabbed row under pointer');
  await capture('expanded-hold', { animations: 'allow' });
  assert.equal(await page.locator('.session-details-card').count(), 0, 'details must not cover a sorting gesture');
  await page.mouse.up(); await page.waitForTimeout(350);
  assert.deepEqual(await order(), beforeCancel, 'holding without moving must not reorder');
  const calls = await page.evaluate(() => window.__uiFixture.calls.map(call => call.path));
  assert.ok(!calls.includes('workspaces.switch'), 'sorting must not switch workspace');
  assert.equal(await page.locator('.agent-float-panel.is-open').count(), 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await row('ws-0').boundingBox();
  await page.mouse.move(x, reduced.y + reduced.height / 2); await page.mouse.down();
  await page.waitForFunction(() => !!document.querySelector('[data-sorting="true"]'));
  await page.mouse.move(x, first.y + first.height / 2); await page.mouse.up();
  assert.equal(await row('ws-0').getAttribute('data-sorting'), null);
  assert.equal((await order())[0], 'ws-0');
  const next = row('ws-1').locator('.agent-notify-body');
  await next.click();
  await next.and(page.locator('[aria-current="true"]')).waitFor();
  await assertCurrentMarker('ws-1');
  await page.mouse.move(0, 0);
  await capture('switched');
}
