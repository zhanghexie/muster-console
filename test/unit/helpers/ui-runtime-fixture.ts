import fs from 'node:fs';
import { afterEach } from 'vitest';

export type RuntimeWindow = Window & typeof globalThis & { maUi: any; pele?: { render: (source: string) => { svg: string } }; _virtualConsole: { constructor: any } };
type RuntimeDom = { window: RuntimeWindow };
const environment = (globalThis as unknown as { jsdom: RuntimeDom }).jsdom;
const JSDOM = environment.constructor as new (html: string, options: any) => RuntimeDom;
const VirtualConsole = environment.window._virtualConsole.constructor;
const scripts = ['bridge', 'expressions', 'components', 'data-components', 'advanced-components', 'mermaid'].map(name => fs.readFileSync(`src/main/uiRuntime/${name}.js`, 'utf8'));
const windows: RuntimeDom[] = [];
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); });
export async function runtimeFixture(html: string) {
  const errors: string[] = [], console = new VirtualConsole(); console.on('jsdomError', (error: Error) => errors.push(error.message));
  const dom = new JSDOM(`<!doctype html><html lang="zh-CN"><head>${scripts.map(code => `<script>${code}</script>`).join('')}</head><body><main id="ma-ui-content">${html}</main></body></html>`, {
    url: 'https://fixture.invalid/expanded', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window: RuntimeWindow) {
      Object.assign(window, {
        TextEncoder, TextDecoder, ResizeObserver: class { observe() {} disconnect() {} },
        pele: { render(source: string) { if (/invalid/i.test(source)) throw new Error('invalid Mermaid syntax'); return { svg: `<svg data-source="${source}"></svg>` }; } }
      });
    }
  });
  windows.push(dom); await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  return { window: dom.window, document: dom.window.document, api: dom.window.maUi, errors };
}
