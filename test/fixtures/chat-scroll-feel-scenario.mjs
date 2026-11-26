/** Production ChatTranscript/CSS + real Chromium wheel and keyboard input.
 * Geometry assignments below occur only in explicitly named preparation steps.
 * This is interaction verification, not a 60fps benchmark or Electron acceptance.
 */
import fs from 'node:fs';
import path from 'node:path';

export default async function ({ page, theme, width, capture, assert }) {
  const evidence = { theme, width, kind: 'production-component-real-input', status: 'incomplete', phases: [], preparations: [] };
  const outIndex = process.argv.indexOf('--out');
  const output = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1], `${theme}-${width}-scroll-feel.json`) : null;
  const list = page.locator('.chat-list');
  const geometry = () => list.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight,
    max: el.scrollHeight - el.clientHeight, gap: el.scrollHeight - el.clientHeight - el.scrollTop }));
  const wait = ms => page.waitForTimeout(ms);
  const choose = async (feel, distance = '1.5', motion = 'system') => {
    await page.getByLabel('滚动手感', { exact: true }).selectOption(feel);
    if (feel !== 'native') await page.getByLabel('每格距离', { exact: true }).selectOption(distance);
    await page.getByLabel('动态效果', { exact: true }).selectOption(motion);
  };
  const begin = label => page.evaluate(label => {
    const probe = window.__scrollFeelProbe;
    if (probe.frame != null) cancelAnimationFrame(probe.frame);
    probe.phase = { label, started: performance.now(), wheels: [], keys: [], scrolls: [], samples: [] };
    const root = document.querySelector('.chat-list'), rect = root.getBoundingClientRect();
    probe.witness = null;
    for (const inset of [8, 24, 48]) {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(inset, rect.height - 1));
      if (hit instanceof HTMLElement && hit.closest('[data-mid]') && root.contains(hit)) { probe.witness = hit; break; }
    }
    probe.phase.witness = probe.witness ? { tag: probe.witness.tagName,
      messageId: probe.witness.closest('[data-mid]').getAttribute('data-mid'),
      start: probe.witness.getBoundingClientRect().top - rect.top } : null;
    const until = performance.now() + 800;
    const sample = () => {
      const phase = probe.phase, el = document.querySelector('.chat-list');
      phase.samples.push({ at: performance.now(), top: el.scrollTop, height: el.scrollHeight,
        witness: probe.witness?.isConnected ? probe.witness.getBoundingClientRect().top - el.getBoundingClientRect().top : null });
      probe.frame = performance.now() < until ? requestAnimationFrame(sample) : null;
    };
    sample();
  }, label);
  const finish = async extra => {
    const phase = await page.evaluate(() => {
      const probe = window.__scrollFeelProbe;
      if (probe.frame != null) cancelAnimationFrame(probe.frame);
      probe.frame = null;
      const phase = probe.phase;
      if (phase.witness && probe.witness?.isConnected) phase.witness.end = probe.witness.getBoundingClientRect().top - document.querySelector('.chat-list').getBoundingClientRect().top;
      probe.phase = null; probe.witness = null; return phase;
    });
    const intervals = phase.samples.slice(1).map((sample, index) => sample.at - phase.samples[index].at).sort((a, b) => a - b);
    phase.frameIntervals = { count: intervals.length, p95: intervals[Math.max(0, Math.ceil(intervals.length * .95) - 1)] ?? null, max: intervals.at(-1) ?? null };
    const wheel = phase.wheels[0];
    const firstMoved = wheel && phase.samples.find(sample => sample.at >= wheel.at && Math.abs(sample.top - phase.samples[0].top) > 1);
    phase.firstWheelToObservedPositionMs = firstMoved ? firstMoved.at - wheel.at : null;
    evidence.phases.push({ ...phase, ...extra }); return phase;
  };
  const realWheel = (phase, prevented) => {
    assert.ok(phase.wheels.length > 0, `${phase.label}: received real wheel`);
    assert.ok(phase.wheels.every(event => event.trusted && event.prevented === prevented), `${phase.label}: correct native/enhanced routing`);
  };
  const prepareGap = async (gap = 600) => {
    // Preparation only: choose a point in the already-realized tail body.
    await list.evaluate((el, gap) => { el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - gap); }, gap);
    await wait(360); await list.hover();
    const result = await geometry(); assert.ok(result.top > 400 && result.gap > 250, 'prepared scrollable reading position'); return result;
  };
  const stableBottom = async label => {
    let previous = await geometry(), current = previous, stable = 0;
    for (let attempt = 0; attempt < 15 && stable < 2; attempt++) {
      await wait(80); current = await geometry();
      stable = current.gap <= 1 && Math.abs(current.top - previous.top) <= 1 && Math.abs(current.height - previous.height) <= 1 ? stable + 1 : 0;
      previous = current;
    }
    assert.ok(stable >= 2 && current.gap <= 1, `${label}: current production bottom and height have settled`);
    return current;
  };
  const prepareNested = async label => {
    await page.getByRole('button', { name: '嵌套样本', exact: true }).click(); await wait(450);
    // Explicit navigation is part of preparation. Reading a previous sample must
    // never be assumed to grant following permission to a different sample.
    const before = await prepareGap();
    await page.getByRole('button', { name: '滚动到底部', exact: true }).click();
    let after = await stableBottom(label);
    const card = page.locator('.thinking-card').last(); await card.waitFor();
    let expanded = false;
    if (!await card.evaluate(el => el.open)) {
      await card.locator('summary').click(); expanded = true;
      after = await stableBottom(`${label}: expanded thinking`);
    }
    const body = card.locator('.thinking-body'); await body.waitFor({ state: 'visible' });
    evidence.preparations.push({ label, before, after, expanded }); return body;
  };
  const hoverThinking = async (body, label) => {
    const point = await body.evaluate(el => {
      const box = el.getBoundingClientRect(), root = el.closest('.chat-list').getBoundingClientRect();
      const left = Math.max(box.left, root.left, 0), right = Math.min(box.right, root.right, innerWidth);
      const top = Math.max(box.top, root.top, 0), bottom = Math.min(box.bottom, root.bottom, innerHeight);
      const x = (left + right) / 2, y = (top + bottom) / 2, hit = document.elementFromPoint(x, y);
      return { x, y, offsetX: x - box.left, offsetY: y - box.top, width: right - left, height: bottom - top,
        open: el.closest('details').open, hit: !!hit && el.contains(hit) };
    });
    assert.ok(point.open && point.width > 0 && point.height > 0 && point.hit, `${label}: expanded thinking is actually hit in the current viewport`);
    await body.hover({ position: { x: point.offsetX, y: point.offsetY } });
    const hit = await body.evaluate((el, point) => { const hit = document.elementFromPoint(point.x, point.y); return !!hit && el.contains(hit); }, point);
    assert.ok(hit, `${label}: the real hover remains over thinking rather than another surface`);
    evidence.preparations.push({ label, thinkingHit: point });
  };
  try {
    await list.waitFor();
    await page.evaluate(() => window.enableScrollFeelFixture());
    await page.locator('[data-scroll-feel-controls]').waitFor(); await wait(450);
    await page.evaluate(() => {
      const probe = { phase: null, frame: null };
      const root = () => document.querySelector('.chat-list');
      const wheel = event => {
        const el = root(); if (!probe.phase || !el.contains(event.target)) return;
        if (probe.phase.wheels.length === 0) {
          // Start the visual dose at the real input, after any preparation-time
          // settlement, using the same bounded visible hit as the controller.
          const rect = el.getBoundingClientRect(); probe.witness = null;
          for (const inset of [8, 24, 48]) {
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(inset, rect.height - 1));
            if (hit instanceof HTMLElement && hit.closest('[data-mid]') && el.contains(hit)) { probe.witness = hit; break; }
          }
          probe.phase.witness = probe.witness ? { tag: probe.witness.tagName,
            messageId: probe.witness.closest('[data-mid]').getAttribute('data-mid'),
            start: probe.witness.getBoundingClientRect().top - rect.top } : null;
        }
        probe.phase.wheels.push({ at: performance.now(), top: el.scrollTop, deltaY: event.deltaY, deltaX: event.deltaX,
          mode: event.deltaMode, prevented: event.defaultPrevented, trusted: event.isTrusted,
          target: event.target.closest('.thinking-body') ? 'nested' : 'transcript' });
      };
      const scroll = event => {
        const el = root(); if (probe.phase && event.target === el) probe.phase.scrolls.push({ at: performance.now(), top: el.scrollTop });
      };
      const key = event => {
        const el = root();
        if (probe.phase) probe.phase.keys.push({ at: performance.now(), key: event.key, trusted: event.isTrusted, prevented: event.defaultPrevented,
          target: el.contains(event.target) ? 'transcript' : event.target.matches('textarea') ? 'composer' : 'other',
          gap: el.scrollHeight - el.clientHeight - el.scrollTop });
      };
      document.addEventListener('wheel', wheel); document.addEventListener('scroll', scroll, true);
      document.addEventListener('keydown', key);
      probe.dispose = () => {
        if (probe.frame != null) cancelAnimationFrame(probe.frame);
        document.removeEventListener('wheel', wheel); document.removeEventListener('scroll', scroll, true);
        document.removeEventListener('keydown', key);
      };
      window.__scrollFeelProbe = probe;
    });

    await choose('native'); await list.hover();
    const nativeBefore = await geometry(); await begin('native-fine');
    await page.mouse.wheel(0, -12.5); await wait(300);
    const nativeAfter = await geometry(), native = await finish({ before: nativeBefore, after: nativeAfter });
    realWheel(native, false); assert.ok(nativeAfter.top < nativeBefore.top, 'native fine wheel actually moves the transcript');

    await choose('soft');
    // Keep the real multi-message/CV difficulty. Absolute scrollTop may move as
    // estimates settle; the same visible paragraph must move by the wheel dose.
    const cvBefore = await prepareGap(); await begin('soft-cv-settlement');
    await page.mouse.wheel(0, -100); await wait(45);
    const cvIntermediate = await geometry(); await wait(350); const cvAfter = await geometry();
    await wait(220); const cvStable = await geometry();
    const cv = await finish({ before: cvBefore, intermediate: cvIntermediate, after: cvAfter, stable: cvStable }); realWheel(cv, true);
    assert.ok(cv.witness && Number.isFinite(cv.witness.end), 'CV sample has a stable visible content witness');
    assert.ok(Math.abs(cv.witness.end - cv.witness.start - 150) <= 4, 'CV settlement does not consume or reverse the configured visual wheel distance');
    assert.ok(cvAfter.gap > 250, 'CV settlement does not incorrectly clamp the reading position to the bottom');
    assert.ok(Math.abs(cvAfter.top - cvStable.top) <= 1, 'CV correction converges without a delayed queue');
    assert.ok(cv.samples.filter(sample => sample.at >= cv.wheels[0].at && sample.witness != null && sample.witness > cv.witness.start + 1 && sample.witness < cv.witness.end - 1).length >= 2,
      'CV sample presents intermediate content positions');

    await page.getByRole('button', { name: '单块正文样本', exact: true }).click(); await wait(450);
    for (const magnitude of [100, 120]) {
      const before = await prepareGap(); await begin(`soft-detent-${magnitude}`);
      await page.mouse.wheel(0, -magnitude); await wait(45);
      const intermediate = await geometry(); await wait(350); const after = await geometry();
      await wait(220); const stable = await geometry();
      const phase = await finish({ before, intermediate, after, stable }); realWheel(phase, true);
      assert.ok(Math.max(...phase.samples.map(sample => sample.height)) - Math.min(...phase.samples.map(sample => sample.height)) <= 1,
        `${magnitude}: genuine realized content keeps its measured height, with no geometry override`);
      assert.ok(Math.abs(after.top - stable.top) <= 1, `${magnitude}: converges without an animation queue`);
      assert.ok(Math.abs((before.top - after.top) - magnitude * 1.5) <= 4, `${magnitude}: configured detent distance is applied`);
      assert.ok(phase.witness && Math.abs(phase.witness.end - phase.witness.start - magnitude * 1.5) <= 4, `${magnitude}: the visible content moves by the configured distance`);
      assert.ok(phase.samples.filter(sample => sample.top < before.top - 1 && sample.top > after.top + 1).length >= 2, `${magnitude}: visible intermediate positions, not one instant jump`);
    }
    await capture('soft-detents', { animations: 'allow' });

    const reverseBefore = await prepareGap(); await begin('soft-reversal');
    await page.mouse.wheel(0, -120); await wait(45); await page.mouse.wheel(0, 120);
    await wait(350); const reverseAfter = await geometry(); await wait(200);
    const reverseStable = await geometry(), reverse = await finish({ before: reverseBefore, after: reverseAfter, stable: reverseStable });
    realWheel(reverse, true);
    assert.equal(reverse.wheels.length, 2); assert.ok(reverse.wheels[1].at - reverse.wheels[0].at < 200, 'reversal reaches the controller before its original deadline');
    assert.ok(Math.abs(reverseAfter.top - reverse.wheels[1].top - 180) <= 4, 'reversal takes current position rather than paying the previous debt');
    assert.ok(Math.abs(reverseAfter.top - reverseStable.top) <= 1, 'reversal has a finite tail');

    let thinking = await prepareNested('nested-consumption');
    // Preparation only: guarantee internal content can consume this up-wheel.
    await thinking.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight; }); await hoverThinking(thinking, 'nested-consumption'); await wait(100);
    const outerBefore = await geometry(), innerBefore = await thinking.evaluate(el => el.scrollTop);
    assert.ok(innerBefore > 120); await begin('nested-consumption');
    await page.mouse.wheel(0, -120); await wait(320);
    const outerAfter = await geometry(), nested = await finish({ before: outerBefore, after: outerAfter }); realWheel(nested, false);
    assert.ok(await thinking.evaluate(el => el.scrollTop) < innerBefore, 'real wheel scrolls the inner thinking body');
    assert.ok(Math.abs(outerAfter.top - outerBefore.top) <= 1, 'nested consumption keeps the outer position');
    await page.getByRole('button', { name: '追加尾段', exact: true }).click(); await wait(450);
    assert.ok((await geometry()).gap <= 1, 'inner up-wheel did not revoke outer following');

    // Appending real output correctly auto-collapses the former live thinking
    // card. Begin the boundary cases with a fresh live sample and explicit UI
    // navigation, rather than trying to hover that now-hidden old body.
    thinking = await prepareNested('nested-contained-boundary');
    await page.getByLabel('内部阻断滚动链', { exact: true }).check();
    await thinking.evaluate(el => { el.scrollTop = 0; }); await hoverThinking(thinking, 'nested-contained-boundary'); await wait(150);
    const containedBefore = await geometry(); await begin('nested-contained-boundary');
    await page.mouse.wheel(0, -120); await wait(350);
    const containedAfter = await geometry(), contained = await finish({ before: containedBefore, after: containedAfter }); realWheel(contained, false);
    assert.ok(Math.abs(containedAfter.top - containedBefore.top) <= 1, 'contained nested boundary does not scroll the transcript');
    await page.getByLabel('内部阻断滚动链', { exact: true }).uncheck();
    await thinking.evaluate(el => { el.scrollTop = 0; }); await hoverThinking(thinking, 'nested-chain-boundary'); await wait(350);
    const chainBefore = await geometry(); await begin('nested-chain-boundary');
    await page.mouse.wheel(0, -120); await wait(350);
    const chainAfter = await geometry(), chain = await finish({ before: chainBefore, after: chainAfter }); realWheel(chain, true);
    assert.ok(chainAfter.top < chainBefore.top - 30, 'an uncontained nested boundary hands real scrolling to the transcript');
    await capture('nested-routing', { animations: 'allow' });

    await page.getByRole('button', { name: '正文样本', exact: true }).click(); await wait(450); await prepareGap();
    await begin('jump-keyboard-interruption');
    await page.getByRole('button', { name: '跳到历史 m20', exact: true }).click();
    assert.ok(await list.evaluate(el => document.activeElement === el), 'manual jump also gives the transcript keyboard focus');
    // Move away from the earlier target so a native key cannot accidentally land
    // at the same 8px destination and masquerade as the old animation finishing.
    await page.keyboard.press('ArrowDown'); await wait(400);
    const jumpAfter = await geometry(); await wait(220); const jumpStable = await geometry();
    const targetOffset = await list.evaluate(el => el.querySelector('[data-mid="m20"]').getBoundingClientRect().top - el.getBoundingClientRect().top);
    const keyPhase = await finish({ after: jumpAfter, stable: jumpStable, targetOffset });
    assert.ok(keyPhase.keys.some(event => event.key === 'ArrowDown' && event.trusted && !event.prevented), 'real native scrolling key reaches this transcript');
    assert.ok(Math.abs(targetOffset - 8) > 5, 'real keyboard input takes over rather than finishing the old jump');
    assert.ok(Math.abs(jumpAfter.top - jumpStable.top) <= 1, 'interrupted navigation never restarts later');

    await page.getByRole('button', { name: '单块正文样本', exact: true }).click(); await wait(450);
    await prepareGap(); await begin('hidden-interruption');
    await page.mouse.wheel(0, -120); await wait(45);
    await page.getByRole('button', { name: '隐藏会话', exact: true }).click();
    const hiddenBefore = await geometry(); await wait(350); const hiddenAfter = await geometry();
    await finish({ before: hiddenBefore, after: hiddenAfter });
    assert.ok(Math.abs(hiddenBefore.top - hiddenAfter.top) <= 1, 'hidden transcript stops changing its position');
    await page.getByRole('button', { name: '显示会话', exact: true }).click(); await wait(100);
    assert.ok(Math.abs((await geometry()).top - hiddenAfter.top) <= 1, 'showing a reading transcript preserves its position');

    const reduceBefore = await prepareGap(); await begin('reduced-interruption');
    await page.mouse.wheel(0, -120); await wait(45);
    await page.getByLabel('动态效果', { exact: true }).selectOption('reduced');
    const reduced = await geometry(); await wait(350); const reducedStable = await geometry();
    const reducePhase = await finish({ before: reduceBefore, after: reduced, stable: reducedStable }); realWheel(reducePhase, true);
    assert.ok(Math.abs(reduced.top - (reduceBefore.top - 180)) <= 4, 'reducing motion immediately finishes at the semantic target');
    assert.ok(Math.abs(reduced.top - reducedStable.top) <= 1, 'reduced motion leaves no delayed scroll tail');

    await page.getByRole('button', { name: '滚动到底部', exact: true }).click();
    assert.ok((await geometry()).gap <= 1, 'production jump-bottom reaches the real current bottom');
    await choose('soft', '0.5', 'system'); await list.hover(); await begin('small-up-wheel-keeps-reading');
    await page.mouse.wheel(0, -100); await wait(350);
    const smallUp = await geometry();
    assert.ok(Math.abs(smallUp.gap - 50) <= 4, 'enhanced small up-wheel intentionally remains inside the bottom tolerance band');
    await page.getByRole('button', { name: '追加尾段', exact: true }).click(); await wait(450);
    const smallGrown = await geometry(), small = await finish({ intermediate: smallUp, after: smallGrown }); realWheel(small, true);
    assert.ok(Math.abs(smallGrown.top - smallUp.top) <= 1 && smallGrown.gap > 100, 'small up-wheel does not regain following after its asynchronous scroll delivery');
    await page.getByRole('button', { name: '滚动到底部', exact: true }).click(); await wait(350);
    assert.ok((await geometry()).gap <= 1, 'explicit jump restores following after the small reading move');
    await choose('soft', '1.5', 'system');
    await page.getByLabel('手感输入', { exact: true }).click(); await begin('composer-space-during-follow');
    // Data preparation uses the original fixture entry; the Space is real input
    // issued while following is still in flight, rather than after click waits.
    await page.evaluate(() => window.appendScrollFixture());
    await page.waitForFunction(() => { const el = document.querySelector('.chat-list'); return el.scrollHeight - el.clientHeight - el.scrollTop > 10; });
    await page.keyboard.type(' '); await wait(350);
    const composer = await finish({ after: await geometry() });
    assert.ok(composer.keys.some(event => event.key === ' ' && event.trusted && event.target === 'composer' && event.gap > 1),
      'trusted composer Space occurred during unfinished following');
    assert.equal(await page.getByLabel('手感输入', { exact: true }).inputValue(), ' ');
    assert.ok((await geometry()).gap <= 1, 'typing a composer space does not revoke a live following animation');
    await choose('native', '1', 'system'); await capture('final-native-bottom', { animations: 'allow' });
    evidence.final = await geometry(); evidence.status = 'passed';
  } catch (error) {
    evidence.failure = String(error); throw error;
  } finally {
    evidence.pending = await page.evaluate(() => {
      const probe = window.__scrollFeelProbe; if (!probe) return null;
      const pending = probe.phase; probe.dispose(); delete window.__scrollFeelProbe; return pending;
    }).catch(() => null);
    if (output) fs.writeFileSync(output, JSON.stringify(evidence, null, 2), { flag: 'wx' });
  }
}
