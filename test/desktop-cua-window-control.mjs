import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'cua-window-control-'));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const load = name => import(pathToFileURL(compile(`main/desktop/${name}.ts`)));
const { createCuaDesktopBackend } = await load('cuaDesktopBackend');
const { createLinuxDesktopHost } = await load('linuxDesktopHost');
const { createLocalDesktopDeliverySelector } = await load('localDesktopDeliverySelector');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+X0AAAAASUVORK5CYII=';
const labels = { active: 'Active', stopping: 'Stopping', stop: 'Stop', unknown: 'Unknown', escape: 'Escape', escapeUnavailable: 'Use Stop' };

function fixture() {
  const calls = [], connections = [];
  const state = { x: 10, noFrame: false, noTree: false, malformed: false, dispatches: 0 };
  const createConnection = () => {
    const driver = { closed: false, async connect() {}, async close() { driver.closed = true; }, async setValueDelivery() { return 'unavailable'; },
      async call(name, args) {
        assert.equal(driver.closed, false);
        calls.push({ name, args, driver });
        if (name === 'list_windows') return { structuredContent: { windows: [{ pid: 42, window_id: 9001, is_on_screen: true,
          title: 'Example\u0000window', app_name: 'Fixture', bounds: { x: state.x, y: 0, width: 160, height: 100 } }] } };
        if (name === 'get_window_state') return {
          content: args.include_screenshot && !state.noFrame ? [{ type: 'image', mimeType: 'image/png', data: png }] : [],
          structuredContent: { pid: args.pid, window_id: args.window_id, elements_complete: true, snapshot_id: 's01234567',
            ...(!state.noTree ? { elements: [{ element_token: 's01234567:0', label: 'Button', role: 'button' }] } : {}),
            ...(args.include_screenshot && (state.noFrame ? { screenshot_frame_valid: false, screenshot_error: { code: 'surface_identity_unproven' } } : {
              capture_id: 'cua-private-image', screenshot_width: state.malformed ? 2 : 1, screenshot_height: 1 })) }
        };
        assert.equal(name, 'click');
        state.dispatches++;
        return { structuredContent: { effect: 'confirmed' } };
      } };
    connections.push(driver);
    return driver;
  };
  const dispatcher = { async run(ctx, requestId, fingerprint, dispatch) {
    assert.equal(ctx.isCurrent(), true);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    return { reply: { outcome: 'dispatched', value: await dispatch(ctx.signal), invocationId: requestId }, async acknowledge() {} };
  } };
  return { calls, connections, createConnection, dispatcher, state };
}

try {
  for (const [platform, env] of [['win32', {}], ['darwin', {}], ['linux', { DISPLAY: ':1' }],
    ['linux', { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':1' }]]) {
    const f = fixture(), lifetime = new AbortController();
    const actor = { sessionId: 'caller', taskId: 'task', turnId: 'turn', lifetimeSignal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted };
    const lease = { owner: actor.sessionId, turnId: actor.turnId, signal: lifetime.signal, isCurrent: actor.isCurrent };
    const backend = createCuaDesktopBackend({ ...f, env, platform, driverPath: () => assert.fail('private test connection should be used'),
      activity: { visibilityEpoch: () => 1, stop: async () => lifetime.abort() },
      selector: createLocalDesktopDeliverySelector(), reportStopError: error => assert.fail(error) });
    const bridge = backend.semanticControl();
    const choose = async () => {
      const list = await backend.windows.list(actor, 0, 8);
      assert.equal(list.windows[0].title, 'Example window');
      assert.doesNotMatch(JSON.stringify(list), /9001|"pid"/);
      return list.windows[0].windowId;
    };
    const windowId = await choose();
    assert.throws(() => backend.windows.resolve({ ...actor, turnId: 'other' }, windowId), /expired/);
    const observation = await bridge.observe(actor, lease, undefined, windowId, undefined, true);
    assert.equal(observation.image.width, 1);
    assert.equal(observation.elements[0].label, 'Button');
    assert.doesNotMatch(JSON.stringify(observation), /cua-private-image|9001|s01234567/);
    const request = { snapshotId: observation.snapshotId, requestId: 'click-1', action: 'click', point: { x: 0, y: 0, count: 2 } };
    const receipt = await bridge.act(actor, lease, undefined, windowId, request);
    assert.equal(receipt.outcome, 'dispatched');
    assert.deepEqual(await bridge.act(actor, lease, undefined, windowId, request), receipt);
    await assert.rejects(() => bridge.act(actor, lease, undefined, windowId, { ...request, requestId: 'new-id' }), /already used/);
    assert.equal(f.state.dispatches, 1);
    const [read, click] = f.calls.filter(call => ['get_window_state', 'click'].includes(call.name));
    assert.equal(f.calls.filter(call => call.name === 'get_window_state').length, 1, 'the act path does not grab new pixels');
    assert.equal(click.driver, read.driver);
    assert.equal(click.args.session, read.args.session);
    assert.equal(click.args.capture_id, 'cua-private-image');
    assert.equal(click.args.delivery_mode, 'foreground');
    assert.equal(click.args.count, 2);
    assert.equal(read.args.include_accessibility_tree, true);

    const moved = await bridge.observe(actor, lease, undefined, windowId, undefined, true);
    f.state.x++;
    await assert.rejects(() => bridge.act(actor, lease, undefined, windowId, { ...request, snapshotId: moved.snapshotId }), /changed/);
    assert.equal(f.state.dispatches, 1);
    const currentWindow = await choose();
    f.state.noFrame = true;
    await assert.rejects(() => bridge.observe(actor, lease, undefined, currentWindow, undefined, true), { code: 'window_capture_unavailable' });
    const semantic = await bridge.observe(actor, lease, undefined, currentWindow);
    assert.equal(semantic.elements.length, 1, 'a missing frame can still have a usable tree');
    f.state.noFrame = false;
    f.state.malformed = true;
    await assert.rejects(() => bridge.observe(actor, lease, undefined, currentWindow, undefined, true), { code: 'invalid_driver_response' });
    f.state.malformed = false;
    f.state.noTree = true;
    const live = await bridge.observe(actor, lease, undefined, currentWindow, undefined, true);
    assert.equal(live.treeAvailable, false);
    assert.ok(live.image.png.length, 'a validated capture can still be used when the tree is unavailable');
    lifetime.abort();
    await backend.stop();
    await assert.rejects(() => bridge.act(actor, lease, undefined, currentWindow, { ...request, snapshotId: live.snapshotId }));
    await backend.close();
    assert.ok(f.connections.every(connection => connection.closed));
  }

  for (const [env, expectEscape] of [[{ DISPLAY: ':20', XDG_SESSION_TYPE: 'x11' }, true],
    [{ DISPLAY: ':20', XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' }, false]]) {
    const f = fixture();
    let monitors = 0, stop;
    const host = createLinuxDesktopHost({ ...f, env, labels, composition: { dispatcher: f.dispatcher, async close() {} }, driverPath: () => assert.fail(),
      reportStopError: error => assert.fail(error), createIndicator(onStop) { stop = onStop; return { async show() {}, close() {} }; },
      createEscapeMonitor() { monitors++; return { async start() {}, async stop() {} }; } });
    host.desktopTurns().begin('owner', 'turn', () => true);
    await host.desktopTurns().use('owner', 'turn', 'Fixture', async (signal, lease) => {
      const actor = { sessionId: 'owner', turnId: 'turn', lifetimeSignal: lease.signal, isCurrent: () => lease.isCurrent() };
      assert.ok((await host.desktopWindowList().list(actor, 0, 8, signal)).windows.length);
    }, false);
    assert.equal(monitors, Number(expectEscape));
    await stop();
    await host.close();
    assert.ok(f.connections.every(connection => connection.closed));
  }
  assert.throws(() => createLinuxDesktopHost({ env: { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' } }), /X11 or native Wayland/);
  console.log('Cua window control: the same screenshot-bound click and refusal cases passed for Windows, macOS, X11 and Wayland simulations');
} finally { removeWorkspaceFixture(temp, 'cua-window-control-'); }
