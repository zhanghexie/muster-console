import React, { useEffect, useRef, useState } from 'react';
import { MOTION, usePresence } from './motion';

const HOT_BAND_WIDTH = 48;
const HOT_BAND_INSET = 0.3;

/** 左缘检测不占 DOM 命中域，避免挡住工作面里的终端或网页点击。 */
export function SessionsHotZone({
  active,
  onSummon
}: {
  active: boolean;
  onSummon: () => void;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [bandHot, setBandHot] = useState(false);
  const bandHotRef = useRef(false);
  const bandArmedRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const presence = usePresence(bandHot, MOTION.microMs);

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const el = rootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const inBand =
        x >= 0 &&
        x <= HOT_BAND_WIDTH &&
        y >= r.height * HOT_BAND_INSET &&
        y <= r.height * (1 - HOT_BAND_INSET);
      const next = inBand && bandArmedRef.current && activeRef.current;
      if (!inBand) bandArmedRef.current = true;
      if (next !== bandHotRef.current) {
        bandHotRef.current = next;
        setBandHot(next);
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  // 失效时收回把手；恢复 active 的边沿同时解除武装（sessions-dock F-01）：速览
  // 经 Escape/点选收回时指针往往仍压在检测带内（面板原覆盖区域），不解除武装的话
  // 下一次 pointermove 会立刻重现把手、pointerenter 紧接着重开速览。指针须离开
  // 检测带再进入才重新武装，防止刚收起就重开。
  useEffect(() => {
    if (active) {
      bandArmedRef.current = false;
      return;
    }
    bandHotRef.current = false;
    setBandHot(false);
  }, [active]);

  return (
    <div ref={rootRef} className="sessions-hot-root" aria-hidden>
      {presence.mounted && (
        <div className="sessions-hot-ghost" onPointerEnter={onSummon}>
          <div className="sessions-hot-ghost-inner mp-pop" {...presence.spread}>
            ▸
          </div>
        </div>
      )}
    </div>
  );
}
