import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { browserSurfaceVisibility } from '../../src/renderer/src/browserSurfaceGeometry';

test('an anchored webview keeps its guest and input while its target changes', async ({}, info) => {
  const root = info.outputPath('webview-anchor');
  fs.mkdirSync(root, { recursive: true });
  buildSync({ stdin: { contents: "import { inspectBrowserSurface } from './src/renderer/src/browserSurfaceAncestors'; window.__inspectSurface = inspectBrowserSurface;", resolveDir: process.cwd(), loader: 'ts' },
    outfile: path.join(root, 'probe.js'), bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent' });
  fs.writeFileSync(path.join(root, 'guest.html'), '<input id="draft"><script>window.probeToken=Math.random().toString()</script>');
  fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><style>
    body { margin: 0; background: #eee; }
    #a, #b { position: fixed; top: 20px; width: 200px; height: 120px; background: #ddd; }
    #a { left: 20px; anchor-name: --a; }
    #ancestor { position:fixed; left:180px; top:10px; width:250px; height:150px; anchor-name:--ancestor; }
    #b { position:absolute; left:120px; top:10px; anchor-name: --b; }
    #clipper, #clipper2 { position: fixed; inset: 0; pointer-events:none; }
    #shell { position: fixed; position-anchor: --a; left: anchor(left); top: anchor(top); pointer-events:auto;
      width: anchor-size(width); height: anchor-size(height); }
    webview { width: 100%; height: 100%; }
    #overlay { display:none; position:fixed; z-index:10; left:300px; top:20px; width:200px; height:120px; background:#222; }
  </style><div id="a"></div><div id="ancestor"><div id="b"></div></div><div id="clipper"><div id="clipper2"><div id="shell"><webview id="view" src="./guest.html"></webview></div></div></div><div id="overlay"></div><script src="./probe.js"></script>`);
  fs.writeFileSync(path.join(root, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'userdata'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:true,width:600,height:260,webPreferences:{webviewTag:true,contextIsolation:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});});`);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'main.cjs'), '--no-sandbox'], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => { try { const view = document.querySelector('#view') as any; return view?.getWebContentsId() > 0 && !view.isLoading(); } catch { return false; } });
    const result = await page.evaluate(async () => {
      const view = document.querySelector('#view') as any, shell = document.querySelector('#shell') as HTMLElement;
      if (!CSS.supports('anchor-name: --probe') || !CSS.supports('left: anchor(left)')) throw Error('CSS anchor positioning is unavailable');
      await view.executeJavaScript("document.querySelector('#draft').value='unsaved'");
      const sample = async () => ({ id: view.getWebContentsId(), token: await view.executeJavaScript('window.probeToken'),
        value: await view.executeJavaScript("document.querySelector('#draft').value"), rect: shell.getBoundingClientRect().toJSON() });
      const before = await sample();
      shell.style.setProperty('position-anchor', '--b');
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const after = await sample();
      (document.querySelector('#overlay') as HTMLElement).style.display = 'block';
      return { before, after, overlayHit: document.elementFromPoint(350, 50)?.id };
    });
    expect(result.before.rect.x).toBeCloseTo(20, 0);
    expect(result.after.rect.x).toBeCloseTo(300, 0);
    expect(result.after.id).toBe(result.before.id);
    expect(result.after.token).toBe(result.before.token);
    expect(result.after.value).toBe('unsaved');
    expect(result.overlayHit).toBe('overlay');
    await page.screenshot({ path: info.outputPath('anchored-overlay.png') });
    await page.locator('#overlay').evaluate(element => { (element as HTMLElement).style.display = 'none'; });
    await page.screenshot({ path: info.outputPath('anchored-guest.png') });
    await page.mouse.click(330, 39);
    const focus = await page.evaluate(async () => ({ parent: document.activeElement?.tagName,
      hit: document.elementFromPoint(330, 39)?.tagName,
      guest: await (document.querySelector('#view') as any).executeJavaScript('document.activeElement?.id') }));
    expect(focus).toEqual({ parent: 'WEBVIEW', hit: 'WEBVIEW', guest: 'draft' });
    // Playwright's parent-page keyboard does not reach an Electron guest. Send
    // through the guest webContents; this does not prove physical OS routing.
    await app.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id);
      if (!guest) throw new Error('Guest disappeared');
      guest.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
      guest.sendInputEvent({ type: 'keyUp', keyCode: 'End' });
      for (const keyCode of '-typed') guest.sendInputEvent({ type: 'char', keyCode });
    }, result.after.id);
    await expect.poll(() => page.evaluate(async () => (document.querySelector('#view') as any).executeJavaScript("document.querySelector('#draft').value"))).toBe('unsaved-typed');
    const transformed = await page.evaluate(async () => {
      const target = document.querySelector('#b') as HTMLElement, shell = document.querySelector('#shell') as HTMLElement;
      target.style.transform = 'translateX(-50px)';
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { target: target.getBoundingClientRect().x, guest: shell.getBoundingClientRect().x };
    });
    expect(transformed.guest).toBeCloseTo(transformed.target, 0);
    const animated = await page.evaluate(async () => {
      const target = document.querySelector('#b') as HTMLElement, shell = document.querySelector('#shell') as HTMLElement;
      target.style.transition = 'transform 200ms linear';
      void target.offsetWidth;
      target.style.transform = 'translateX(-100px)';
      const samples: Array<{ target: number; guest: number }> = [];
      for (let i = 0; i < 15; i++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        samples.push({ target: target.getBoundingClientRect().x, guest: shell.getBoundingClientRect().x });
      }
      return samples;
    });
    expect(Math.abs(animated[0].target - animated.at(-1)!.target)).toBeGreaterThan(5);
    expect(Math.max(...animated.map(sample => Math.abs(sample.guest - sample.target)))).toBeLessThan(1);
    const clipping = await page.evaluate(async () => {
      const target = document.querySelector('#b') as HTMLElement, shell = document.querySelector('#shell') as HTMLElement;
      target.style.clipPath = 'inset(0 100px 0 0)';
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const targetRect = target.getBoundingClientRect(), surface = shell.getBoundingClientRect();
      return { unprotected: document.elementFromPoint(350, 50)?.tagName,
        surface: { x: surface.x, y: surface.y, width: surface.width, height: surface.height },
        viewport: { x: 0, y: 0, width: innerWidth, height: innerHeight },
        clip: { x: targetRect.x, y: targetRect.y, width: targetRect.width - 100, height: targetRect.height } };
    });
    const visibility = browserSurfaceVisibility(clipping.surface, clipping.viewport, [{ kind: 'rect', rect: clipping.clip }]);
    expect(visibility.kind).toBe('visible');
    if (visibility.kind !== 'visible') throw Error('Expected a visible clip');
    const protectedHit = await page.evaluate(async inset => {
      (document.querySelector('#shell') as HTMLElement).style.clipPath = `inset(${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px)`;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return document.elementFromPoint(350, 50)?.tagName;
    }, visibility.inset);
    console.log('clipping probe:', { unprotected: clipping.unprotected, protected: protectedHit });
    expect(protectedHit).not.toBe('WEBVIEW');
    const nestedClip = await page.evaluate(async () => {
      const target = document.querySelector('#b') as HTMLElement, shell = document.querySelector('#shell') as HTMLElement;
      const clipper = document.querySelector('#clipper') as HTMLElement;
      shell.style.clipPath = 'none';
      clipper.style.cssText = 'position:fixed;position-anchor:--b;left:anchor(left);top:anchor(top);width:anchor-size(width);height:anchor-size(height);clip-path:inset(0 100px 0 0);pointer-events:none';
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { guestX: shell.getBoundingClientRect().x, targetX: target.getBoundingClientRect().x,
        inside: document.elementFromPoint(230, 50)?.tagName, outside: document.elementFromPoint(350, 50)?.tagName,
        id: (document.querySelector('#view') as any).getWebContentsId() };
    });
    expect(nestedClip.guestX).toBeCloseTo(nestedClip.targetX, 0);
    expect(nestedClip.inside).toBe('WEBVIEW');
    expect(nestedClip.outside).not.toBe('WEBVIEW');
    expect(nestedClip.id).toBe(result.before.id);
    const roundedClip = await page.evaluate(async () => {
      const target = document.querySelector('#b') as HTMLElement, clipper = document.querySelector('#clipper') as HTMLElement;
      clipper.style.clipPath = 'inset(0 round 30px)';
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const box = target.getBoundingClientRect();
      return { corner: document.elementFromPoint(box.x + 2, box.y + 2)?.tagName,
        inside: document.elementFromPoint(box.x + 40, box.y + 40)?.tagName,
        id: (document.querySelector('#view') as any).getWebContentsId() };
    });
    expect(roundedClip.corner).not.toBe('WEBVIEW');
    expect(roundedClip.inside).toBe('WEBVIEW');
    expect(roundedClip.id).toBe(result.before.id);
    const nestedIntersection = await page.evaluate(async () => {
      const outer = document.querySelector('#clipper') as HTMLElement, inner = document.querySelector('#clipper2') as HTMLElement;
      outer.style.setProperty('position-anchor', '--ancestor');
      outer.style.clipPath = 'inset(0 100px 0 0)';
      inner.style.cssText = 'position:fixed;position-anchor:--b;left:anchor(left);top:anchor(top);width:anchor-size(width);height:anchor-size(height);clip-path:inset(0 0 0 50px);pointer-events:none';
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { left: document.elementFromPoint(230, 50)?.tagName, inside: document.elementFromPoint(270, 50)?.tagName,
        right: document.elementFromPoint(350, 50)?.tagName, id: (document.querySelector('#view') as any).getWebContentsId() };
    });
    expect(nestedIntersection.left).not.toBe('WEBVIEW');
    expect(nestedIntersection.inside).toBe('WEBVIEW');
    expect(nestedIntersection.right).not.toBe('WEBVIEW');
    expect(nestedIntersection.id).toBe(result.before.id);
    const ancestorMoved = await page.evaluate(async () => {
      const ancestor = document.querySelector('#ancestor') as HTMLElement, target = document.querySelector('#b') as HTMLElement;
      ancestor.style.transform = 'translateX(25px)';
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const box = target.getBoundingClientRect(), view = document.querySelector('#view') as any;
      return { targetX: box.x, guestX: (document.querySelector('#shell') as HTMLElement).getBoundingClientRect().x,
        left: document.elementFromPoint(box.x + 30, 50)?.tagName, inside: document.elementFromPoint(box.x + 70, 50)?.tagName,
        right: document.elementFromPoint(box.x + 150, 50)?.tagName, id: view.getWebContentsId(), value: await view.executeJavaScript("document.querySelector('#draft').value") };
    });
    expect(ancestorMoved.guestX).toBeCloseTo(ancestorMoved.targetX, 0);
    expect(ancestorMoved.left).not.toBe('WEBVIEW');
    expect(ancestorMoved.inside).toBe('WEBVIEW');
    expect(ancestorMoved.right).not.toBe('WEBVIEW');
    expect(ancestorMoved.id).toBe(result.before.id);
    expect(ancestorMoved.value).toBe('unsaved-typed');
    const ancestorProbe = await page.evaluate(() => {
      const parent = document.createElement('div'), target = document.createElement('div');
      parent.style.cssText = 'position:fixed;left:100px;top:90px;width:100px;height:60px;overflow:hidden';
      target.style.cssText = 'position:absolute;left:-20px;top:-10px;width:200px;height:100px';
      document.body.append(parent); parent.append(target);
      const inspect = (window as any).__inspectSurface;
      const rectangular = inspect(target);
      parent.style.borderRadius = '10px';
      const rounded = inspect(target);
      parent.remove();
      return { rectangular, rounded };
    });
    expect(ancestorProbe.rectangular).toEqual({ kind: 'visible', inset: { top: 10, right: 80, bottom: 30, left: 20 } });
    expect(ancestorProbe.rounded).toEqual({ kind: 'unsupported' });
  } finally { await app.close(); }
});
