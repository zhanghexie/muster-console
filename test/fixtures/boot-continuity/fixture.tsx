import React, { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandBootLoader } from '@workbench/src/renderer/src/components/BrandLoader';
import { BootReady } from '@workbench/src/renderer/src/components/BootReady';
const boot = document.createElement('div');
boot.innerHTML = renderToStaticMarkup(<BrandBootLoader />);
const overlay = boot.firstElementChild!; overlay.id = 'boot-overlay'; document.body.appendChild(overlay);
document.documentElement.style.setProperty('--surface-frame','#202023');
document.documentElement.style.setProperty('--fg-primary','#ededee');
let ready = false; let finish!: () => void;
const pending = new Promise<void>(resolve => { finish = resolve; });
function Content() { if (!ready) throw pending; return <main style={{minHeight:'100vh'}}>主界面已就绪</main>; }
(window as any).mountBoot = () => createRoot(document.getElementById('root')!).render(<Suspense fallback={null}><BootReady/><Content/></Suspense>);
(window as any).finishBootFixture = () => { ready = true; finish(); };
