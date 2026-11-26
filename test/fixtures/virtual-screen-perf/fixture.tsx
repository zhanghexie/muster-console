import '../../../.agents/skills/ui-verification/assets/fixture-api';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { BrandLoader } from '@workbench/src/renderer/src/components/BrandLoader';
import { guardVirtualScreenScroll } from '@workbench/src/renderer/src/virtualScreenScrollGuard';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
function Fixture() {
  const [shown, setShown] = useState(false), [inner, setInner] = useState(true), [right, setRight] = useState(false);
  const view = useRef<HTMLDivElement>(null), work = useRef<HTMLDivElement>(null);
  useEffect(() => guardVirtualScreenScroll([view.current, work.current]), [right]);
  return <main className="perf-surface" style={{ padding: 24, color: 'var(--fg-primary)' }}>
    <button onClick={() => setShown(value => !value)}>切换外层</button>
    <button onClick={() => setInner(value => !value)}>切换内层</button>
    <button onClick={() => setRight(value => !value)}>切换虚拟屏</button>
    <div className="xfade-stack" style={{ height: 110, marginTop: 20 }}>
      <div data-testid="outer" className={`xfade${shown ? ' is-shown' : ''}`}>
        <div className={`xfade${inner ? ' is-shown' : ''}`}><BrandLoader size={64}/></div>
      </div>
    </div>
    <div ref={view} className="main-view" style={{ width: '100%', height: 180, flex: 'none' }}>
      <div ref={work} className="work-area" style={{ width: '100%' }}>
        <div className="h-strip" style={{ width: 2000, transform: `translateX(${right ? -200 : 0}px)` }}>
          <button data-testid="far-focus" style={{ position: 'absolute', left: 1500, top: 40 }}>离屏目标</button>
        </div>
      </div>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
