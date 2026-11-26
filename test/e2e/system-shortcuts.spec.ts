import { test, expect } from './fixtures/electron';

test('desktop IPC sends a configured system shortcut and rejects stale IDs', async ({ appCtx }) => {
  const chord = process.platform === 'darwin' ? 'F20' : 'F24';
  const { app, win } = appCtx;
  const registered = await app.evaluate(({ globalShortcut }, chord) => {
    (globalThis as any).__shortcutReceived = 0;
    return globalShortcut.register(chord, () => { (globalThis as any).__shortcutReceived++; });
  }, chord);
  expect(registered).toBe(true);
  try {
    await win.evaluate(chord => window.api.config.update({ systemShortcuts: [{ id: 'e2e-f24', name: '测试快捷操作', chord }] }), chord);
    const result = await win.evaluate(() => window.api.app.runSystemShortcut('e2e-f24'));
    expect(result, JSON.stringify(result)).toEqual({ ok: true });
    await expect.poll(() => app.evaluate(() => (globalThis as any).__shortcutReceived)).toBe(1);
    expect(await win.evaluate(() => window.api.app.runSystemShortcut('deleted'))).toMatchObject({ ok: false });
  } finally {
    await app.evaluate(({ globalShortcut }, chord) => globalShortcut.unregister(chord), chord);
    await win.evaluate(() => window.api.config.update({ systemShortcuts: [] }));
  }
});
