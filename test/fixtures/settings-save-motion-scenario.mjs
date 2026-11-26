/** Real SettingsModal input + production CSS. Explicit settlement controls only mocked IPC.
 * 1100px is the actual desktop BrowserWindow minimum. Smaller widths are labelled
 * boundary probes, retain screenshots/geometry, and never claim supported-window acceptance.
 */
import fs from 'node:fs';
import path from 'node:path';

export default async function ({ page, theme, width, capture, assert }) {
  const outIndex = process.argv.indexOf('--out');
  const output = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1], `${theme}-${width}-settings-save.json`) : null;
  const evidence = {
    theme, width, kind: 'production-settings-memory-ipc', desktopMinimumWidth: 1100,
    scope: width >= 1100 ? 'supported-desktop-width' : 'unsupported-desktop-boundary-probe',
    status: 'incomplete', phases: [], limitations: [
      'Mock IPC proves renderer lifecycle, not native configuration persistence.',
      'Solid production theme; no Electron Mica/Vibrancy or MobileApp coverage.',
      'Screenshots require visual review; geometry/opacity checks do not replace it.'
    ]
  };
  const bar = page.locator('.settings-savebar');
  const keepAwake = page.getByRole('checkbox', { name: '任务运行时阻止休眠', exact: true });
  const save = () => bar.getByRole('button', { name: /^保存/ });
  const settle = outcome => page.evaluate(outcome => window.__settingsSaveFixture.settle(outcome), outcome);
  const pending = () => page.evaluate(() => window.__settingsSaveFixture.pendingId());
  const updates = () => page.evaluate(() => window.__settingsSaveFixture.diagnostics.updates);
  const pause = ms => page.waitForTimeout(ms);
  const geometry = () => page.evaluate(() => {
    const rect = node => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const el = document.querySelector('.settings-savebar');
    return {
      bar: rect(el), sheet: rect(document.querySelector('.settings-sheet')),
      stage: el?.getAttribute('data-mp-stage') ?? null,
      buttons: [...(el?.querySelectorAll('button') ?? [])].map(button => ({
        text: button.textContent.trim(), rect: rect(button), disabled: button.disabled
      })),
      message: rect(el?.querySelector('.settings-savebar-message-slot')),
      scrollWidth: el?.scrollWidth ?? null, clientWidth: el?.clientWidth ?? null,
      documentOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
      narrow: document.documentElement.classList.contains('is-narrow'),
      motion: document.documentElement.dataset.uiMotion
    };
  });
  const sameBox = (a, b, label) => {
    assert.ok(a && b, `${label}: missing geometry`);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(a[key] - b[key]) <= 1, `${label}: ${key} changed: ${a[key]} → ${b[key]}`);
  };
  const contained = (state, label) => {
    assert.ok(state.bar && state.sheet, `${label}: missing savebar/sheet`);
    assert.ok(state.bar.x >= state.sheet.x - 1 && state.bar.right <= state.sheet.right + 1,
      `${label}: savebar exceeds sheet: ${JSON.stringify(state)}`);
    assert.ok(state.bar.x >= -1 && state.bar.right <= width + 1, `${label}: savebar exceeds viewport`);
    for (const button of state.buttons) assert.ok(button.rect.x >= state.bar.x - 1 && button.rect.right <= state.bar.right + 1,
      `${label}: ${button.text} exceeds savebar`);
    assert.ok(state.scrollWidth <= state.clientWidth + 1, `${label}: savebar content overflows`);
  };
  const record = async (label, extra = {}) => {
    const state = await geometry();
    evidence.phases.push({ label, ...state, ...extra });
    return state;
  };
  const beginProbe = label => page.evaluate(label => {
    const probe = { label, startedAt: performance.now(), frames: [], done: false };
    window.__settingsSaveProbe = probe;
    const frame = now => {
      const el = document.querySelector('.settings-savebar');
      const success = el?.querySelector('.settings-savebar-success');
      const notice = el?.querySelector('.settings-savebar-notice');
      const rect = el?.getBoundingClientRect();
      probe.frames.push({
        at: now, elapsed: now - probe.startedAt,
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        buttons: el?.querySelectorAll('button').length ?? 0,
        successOpacity: success ? Number(getComputedStyle(success).opacity) : null,
        successTransform: success ? getComputedStyle(success).transform : null,
        noticeOpacity: notice ? Number(getComputedStyle(notice).opacity) : null,
        noticeHidden: notice?.getAttribute('aria-hidden') ?? null
      });
      if (now - probe.startedAt >= 240) probe.done = true;
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, label);
  const probeResult = async () => {
    await page.waitForFunction(() => window.__settingsSaveProbe?.done);
    return page.evaluate(() => window.__settingsSaveProbe);
  };
  const edit = async () => {
    const previous = await keepAwake.isChecked();
    await keepAwake.click();
    assert.equal(await keepAwake.isChecked(), !previous, 'real checkbox click changes the draft immediately');
    await bar.waitFor();
    return previous;
  };
  const startSave = async () => {
    const before = (await updates()).length;
    await save().click();
    assert.equal((await updates()).length, before + 1, 'click dispatches config.update before animation completion');
    assert.equal(await pending(), before + 1);
    assert.ok(await save().isDisabled(), 'pending save disables its real button');
  };
  const savedNoButtons = async () => {
    await page.waitForFunction(() => document.querySelector('.settings-savebar.is-saved .settings-savebar-success:not([aria-hidden="true"])'));
    assert.equal(await bar.getByRole('button').count(), 0, 'old interactive controls leave immediately');
    assert.equal(await page.evaluate(() => window.__oldSettingsSaveButton?.isConnected ?? false), false);
  };
  const waitSince = (at, elapsed) => page.evaluate(({ at, elapsed }) => new Promise(resolve => {
    setTimeout(resolve, Math.max(0, at + elapsed - performance.now()));
  }), { at, elapsed });
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await keepAwake.waitFor();
    await page.evaluate(async () => { await document.fonts.ready; });
    await pause(320);
    assert.equal(await page.locator('html').evaluate(el => el.classList.contains('is-narrow')), width <= 820,
      'fixture retains the real desktop viewport marker');
    await capture(width < 1100 ? 'unsupported-width-initial' : 'settings-initial');

    if (width < 1100) {
      // A desktop boundary is evidence, not a fake supported mobile layout. Do not
      // force-click controls outside the real sheet or override production CSS.
      await keepAwake.scrollIntoViewIfNeeded();
      const canHit = await keepAwake.evaluate(el => {
        const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight && (hit === el || el.contains(hit));
      });
      if (canHit) {
        await edit(); await pause(220);
        await capture('unsupported-width-dirty');
      }
      await record('unsupported-desktop-width', { checkboxReachable: canHit });
      evidence.status = 'boundary-probe-only';
      console.warn(`SettingsModal ${width}px is below Electron minWidth 1100px; retained as a desktop boundary probe, not supported-window acceptance.`);
      return;
    }

    await edit(); await pause(220);
    const dirty = await record('dirty'); contained(dirty, 'dirty');
    await capture('settings-dirty');
    await save().evaluate(el => { window.__oldSettingsSaveButton = el; });
    await startSave();
    await capture('settings-save-pending');
    await beginProbe('first-success');
    await settle('success');
    await savedNoButtons();
    const success = await record('first-success-immediate');
    sameBox(dirty.bar, success.bar, 'save success preserves bar position and dimensions');
    for (const axis of ['x', 'y']) assert.ok(Math.abs(dirty.message[axis] - success.message[axis]) <= 1,
      `save message ${axis} origin remains in place`);
    assert.equal((await updates())[0].patch.tasksKeepAwake, false);
    assert.equal(await page.evaluate(() => window.__settingsSaveFixture.diagnostics.config().tasksKeepAwake), false);
    await capture('settings-success-entering', { animations: 'allow', caret: 'initial' });
    const probe = await probeResult();
    evidence.phases.push({ label: 'first-success-frames', probe });
    const visibleFrames = probe.frames.filter(frame => frame.successOpacity !== null);
    assert.ok(visibleFrames.some(frame => frame.successOpacity > .01 && frame.successOpacity < .999), 'success has a real opacity intermediate frame');
    for (const frame of visibleFrames) {
      sameBox(dirty.bar, frame.rect, 'success frame bar geometry');
      assert.equal(frame.buttons, 0);
      if (frame.noticeOpacity !== null) assert.equal(frame.noticeHidden, 'true', 'outgoing notice is hidden from assistive technology immediately');
    }
    await capture('settings-success');

    // Reverse while success remains mounted. Selection and business state must
    // change immediately; no frozen/clickable action snapshot may survive.
    await edit();
    assert.ok(await save().isEnabled());
    const oldSuccess = bar.locator('.settings-savebar-success');
    if (await oldSuccess.count()) assert.equal(await oldSuccess.getAttribute('aria-hidden'), 'true');
    await startSave(); await settle('success'); await savedNoButtons();
    const second = (await updates()).at(-1);
    await record('rapid-second-save', { update: second });
    await capture('settings-rapid-second-success', { animations: 'allow', caret: 'initial' });

    // Save again before that success expires; cross the PREVIOUS deadline while
    // the NEW success must remain fully present. A reused boolean timer fails.
    await waitSince(second.endedAt, 850);
    await edit(); await startSave(); await settle('success'); await savedNoButtons();
    const third = (await updates()).at(-1);
    assert.ok(third.endedAt - second.endedAt < 1500, 'third save overlaps the previous feedback lifetime');
    await waitSince(second.endedAt, 1680);
    assert.ok(await bar.isVisible(), 'old deadline does not remove the newer success');
    assert.equal(await bar.getAttribute('data-mp-stage'), 'in', 'old deadline does not start newer success exit');
    assert.equal(await bar.locator('.settings-savebar-success').getAttribute('aria-hidden'), null);
    assert.equal(await bar.locator('.settings-savebar-success').getAttribute('data-mp-stage'), 'in');
    await record('crossed-old-success-deadline', { previous: second, current: third });
    await capture('settings-new-success-past-old-deadline');
    await waitSince(third.endedAt, 1980);
    await bar.waitFor({ state: 'detached' });
    await record('current-success-deadline-complete');

    await edit(); await startSave(); await settle('failure');
    const acknowledgement = bar.getByRole('button', { name: '知道了', exact: true });
    await acknowledgement.waitFor();
    assert.match(await bar.textContent(), /保存失败：隔离夹具模拟保存失败/);
    assert.equal(await bar.getByRole('button').count(), 1);
    await record('save-failed'); await capture('settings-save-failed');
    assert.equal(await page.evaluate(() => window.__settingsSaveFixture.diagnostics.config().tasksKeepAwake), false,
      'failed update leaves the in-memory persisted configuration unchanged');
    const attemptsBeforeAck = (await updates()).length;
    await acknowledgement.click();
    assert.ok(await save().isEnabled());
    assert.equal((await updates()).length, attemptsBeforeAck, 'acknowledgement does not dispatch another save');

    await page.getByRole('button', { name: /^返回工作台/ }).click();
    assert.ok(await bar.getByRole('button', { name: '放弃并离开', exact: true }).isVisible());
    assert.equal(await page.evaluate(() => window.__settingsSaveFixture.diagnostics.closeCalls.length), 0);
    contained(await record('leave-confirmation'), 'leave confirmation');
    await capture('settings-leave-confirmation');
    await startSave(); await settle('failure'); await acknowledgement.waitFor();
    await acknowledgement.click();
    assert.ok(await bar.getByRole('button', { name: '保存并离开', exact: true }).isEnabled(), 'failed save retains leave confirmation after acknowledgement');
    await startSave(); await settle('success');
    await page.waitForFunction(() => window.__settingsSaveFixture.diagnostics.closeCalls.length === 1);
    const close = await page.evaluate(() => ({ at: window.__settingsSaveFixture.diagnostics.closeCalls[0], update: window.__settingsSaveFixture.diagnostics.updates.at(-1) }));
    assert.ok(close.at - close.update.endedAt < 100, 'save-and-leave calls onClose without waiting for feedback animation');
    await page.locator('.settings-page').waitFor({ state: 'detached' });
    evidence.phases.push({ label: 'save-and-leave', ...close });

    await page.getByRole('button', { name: '重新打开隔离设置页', exact: true }).click();
    await keepAwake.waitFor(); await pause(320);
    const updatesBeforePreference = (await updates()).length;
    await page.getByRole('group', { name: '界面动效', exact: true }).getByRole('button', { name: '减少', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-ui-motion'), 'reduced');
    assert.equal((await updates()).length, updatesBeforePreference, 'user motion preference is immediate/local, not a configuration save');
    await edit();
    const reducedDirty = await record('reduced-dirty'); contained(reducedDirty, 'reduced dirty');
    await startSave(); await settle('success'); await savedNoButtons();
    const reducedSuccess = await record('reduced-success');
    sameBox(reducedDirty.bar, reducedSuccess.bar, 'reduced success geometry');
    const reducedStyle = await bar.locator('.settings-savebar-success').evaluate(el => ({
      opacity: Number(getComputedStyle(el).opacity), transform: getComputedStyle(el).transform,
      durations: getComputedStyle(el).transitionDuration.split(',').map(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000))
    }));
    assert.equal(reducedStyle.opacity, 1); assert.ok(reducedStyle.durations.every(ms => ms <= .02));
    await capture('settings-user-reduced-success', { animations: 'allow', caret: 'initial' });

    assert.deepEqual(await page.evaluate(() => window.__uiFixture.unmocked), [], 'all fixture IPC routes are explicit');
    assert.ok(await page.evaluate(() => window.__settingsSaveFixture.diagnostics.inputs.every(event => event.trusted)), 'all recorded UI input is browser-generated');
    evidence.status = 'behavior-passed-visual-review-pending';
  } catch (error) {
    evidence.status = 'failed'; evidence.error = error.stack ?? String(error);
    throw error;
  } finally {
    evidence.diagnostics = await page.evaluate(() => ({
      calls: window.__uiFixture?.calls, unmocked: window.__uiFixture?.unmocked,
      updates: window.__settingsSaveFixture?.diagnostics.updates,
      closeCalls: window.__settingsSaveFixture?.diagnostics.closeCalls,
      inputs: window.__settingsSaveFixture?.diagnostics.inputs
    }));
    if (output) fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  }
}
