import React, { useId } from 'react';
import { MOTION } from '../motion';

// Shared with the approved envelope-send study. One clock, overlapping tracks.
const fold = MOTION.panelMs + MOTION.staggerMs * 2;
export const envelopeTiming = {
  top: { delay: 0, duration: fold },
  bottom: { delay: 0, duration: fold },
  insert: { delay: fold + MOTION.staggerMs, duration: MOTION.panelMs },
  lid: { delay: fold + MOTION.exitMs + MOTION.staggerMs, duration: MOTION.menuMs },
  flight: { delay: fold + MOTION.staggerMs * 3, duration: MOTION.moveMs + MOTION.panelMs },
};
export const envelopeDuration = envelopeTiming.flight.delay + envelopeTiming.flight.duration;
export const envelopePlaybackRate = .9;
export const envelopeTimingVars = Object.fromEntries(Object.entries(envelopeTiming).flatMap(([key, track]) => [
  [`--es-${key}-delay`, `${track.delay}ms`], [`--es-${key}-duration`, `${track.duration}ms`]
])) as React.CSSProperties;

/** Three clipped copies of one static snapshot; no form controls or duplicated IDs. */
export function EnvelopePaper({ children }: { children: React.ReactNode }) {
  const lidClipId = `es-lid-${useId().replace(/:/g, '')}`;
  return <div className="es-flight" aria-hidden="true"><div className="es-package" style={{'--es-lid-clip':`url("#${lidClipId}")`} as React.CSSProperties}>
    <svg className="es-shape-defs" width="0" height="0"><defs><clipPath id={lidClipId} clipPathUnits="objectBoundingBox">
      <path d="M .011 0 H .989 Q .999 0 .994 .017 L .509 .985 Q .5 1.003 .491 .985 L .006 .017 Q .001 0 .011 0 Z"/>
    </clipPath></defs></svg>
    <div className="es-envelope-rear">
      <div className="es-envelope-body"/>
      <div className="es-lid-pivot"><div className="es-lid-inside"/></div>
    </div>
    <div className="es-sheet-depth"><div className="es-insert"><div className="es-sheet-scale"><div className="es-paper">
      <div className="es-middle es-panel"><div className="es-face es-front"><div className="es-letter-slice" style={{top:'-100%'}}>{children}</div></div></div>
      <div className="es-top es-panel"><div className="es-face es-front"><div className="es-letter-slice">{children}</div></div><div className="es-face es-back"/></div>
      <div className="es-bottom es-panel"><div className="es-face es-front"><div className="es-letter-slice" style={{top:'-200%'}}>{children}</div></div><div className="es-face es-back"/></div>
    </div></div></div></div>
    <div className="es-envelope-pocket"><div className="es-pocket-surface"/></div>
    <div className="es-envelope-front-lid"><div className="es-lid-pivot"><div className="es-lid-outside"/></div></div>
  </div></div>;
}
