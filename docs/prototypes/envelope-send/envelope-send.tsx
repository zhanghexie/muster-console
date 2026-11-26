import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MOTION, prefersReducedMotion, usePresence } from '../../../src/renderer/src/components/motion';
import { subscribeInteractionPreferences } from '../../../src/renderer/src/interactionPreferences';

import { EnvelopePaper, envelopeTiming, envelopeDuration, envelopePlaybackRate } from '../../../src/renderer/src/components/envelope/EnvelopePaper';
export { EnvelopePaper, envelopeTiming, envelopeDuration, envelopePlaybackRate };
type Phase = 'ready' | 'sending' | 'sent';

function LetterContent() {
  return <div className="es-letter-content">
    <div className="es-letter-meta">TO YOU <span>2026 / 10 / 20</span></div>
    <h2>见字如面。</h2>
    <p>有些话，值得认真写下来。</p>
    <p>把今天的灵感、还没讲完的故事，<br/>和一点点想念，折进这一页。</p>
    <p>希望它到达你面前的时候，<br/>也带着纸张的温度。</p>
    <div className="es-signature">一切都好。<br/><span>来自远方的朋友</span></div>
    <div className="es-letter-footer">A LITTLE NOTE, ON ITS WAY.</div>
  </div>;
}

export function EnvelopeSendStudy() {
  const [phase, setPhase] = useState<Phase>('ready');
  const [slow, setSlow] = useState(false);
  const [dark, setDark] = useState<boolean | null>(null);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [run, setRun] = useState(0);
  const root = useRef<HTMLElement>(null);
  const elapsed = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const tracks = useRef<Animation[]>([]);
  const reduced = useSyncExternalStore(subscribeInteractionPreferences, prefersReducedMotion, () => false);
  const presence = usePresence(phase !== 'sent', MOTION.microMs);
  const running = phase === 'sending';

  useLayoutEffect(() => {
    if (!running || !presence.mounted || !root.current) return;
    // Reset without a transition, commit the flat page, then launch every CSS track together.
    root.current.dataset.playing = 'false';
    void root.current.offsetWidth;
    root.current.dataset.playing = 'true';
    void root.current.offsetWidth;
    tracks.current = root.current.querySelector('.es-flight')?.getAnimations?.({ subtree: true }) ?? [];
    if (pendingSeek.current !== null) {
      for (const animation of tracks.current) {
        animation.pause();
        animation.currentTime = pendingSeek.current;
      }
      elapsed.current = pendingSeek.current;
      pendingSeek.current = null;
    }
    return () => { for (const animation of tracks.current) animation.cancel(); tracks.current = []; };
  }, [run, presence.mounted]);

  useEffect(() => {
    if (!running) return;
    if (reduced) { elapsed.current = envelopeDuration; setProgress(1); setPhase('sent'); return; }
    const rate = envelopePlaybackRate * (slow ? 1 / 3 : 1);
    for (const animation of tracks.current) {
      animation.playbackRate = rate;
      if (paused) animation.pause();
      else if (animation.playState === 'paused') animation.play();
    }
    if (paused) return;
    let previous = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      elapsed.current = Math.min(envelopeDuration, elapsed.current + (now - previous) * rate);
      previous = now;
      setProgress(elapsed.current / envelopeDuration);
      if (elapsed.current >= envelopeDuration) setPhase('sent');
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, paused, slow, reduced, run]);

  function start() {
    elapsed.current = 0;
    setProgress(reduced ? 1 : 0);
    setPaused(false);
    setPhase(reduced ? 'sent' : 'sending');
    setRun(value => value + 1);
  }
  function reset() {
    for (const animation of tracks.current) animation.cancel();
    tracks.current = [];
    if (root.current) root.current.dataset.playing = 'false';
    elapsed.current = 0;
    pendingSeek.current = null;
    setProgress(0);
    setPaused(false);
    setPhase('ready');
  }
  function seek(value: number) {
    if (reduced) return;
    const time = value * envelopeDuration;
    elapsed.current = time;
    setProgress(value);
    setPaused(true);
    if (!running) {
      pendingSeek.current = time;
      setPhase('sending');
      setRun(value => value + 1);
    } else for (const animation of tracks.current) { animation.pause(); animation.currentTime = time; }
  }
  const timingVars = Object.fromEntries(Object.entries(envelopeTiming).flatMap(([key, track]) => [
    [`--es-${key}-delay`, `${track.delay}ms`], [`--es-${key}-duration`, `${track.duration}ms`]
  ])) as React.CSSProperties;

  // Folded paper clears the stationary pocket before it changes depth and slides inside.
  const paperInside = progress * envelopeDuration >= envelopeTiming.top.duration;
  return <section id="envelope-send-study" ref={root} data-phase={phase} data-paused={paused} data-duration={envelopeDuration} data-paper-layer={paperInside ? 'inside' : 'front'}
    data-theme={dark === null ? undefined : dark ? 'dark' : 'light'} style={timingVars}>
    <header className="es-toolbar">
      <span className="es-wordmark">纸上来信 <span> / SEND STUDY</span></span>
      <button type="button" onClick={() => setDark(value => value === null ? !matchMedia('(prefers-color-scheme: dark)').matches : !value)} aria-label="切换明暗主题">明 / 暗</button>
    </header>
    <div className="es-scene" aria-label="折叠页面露出后方信封，向上飞行时装入信纸并合盖">
      {presence.mounted && <div className="es-presence mp-panel" {...presence.spread}>
        <EnvelopePaper><LetterContent/></EnvelopePaper>
      </div>}
    </div>
    <footer className="es-controls">
      <div className="es-actions">
        <span className="es-status" role="status" aria-live="polite">{phase === 'sent' ? '已寄出' : phase === 'ready' ? '折一页，寄给你。' : paused ? '已暂停' : '寄送中'}</span>
        <label><input type="checkbox" checked={slow} onChange={event => setSlow(event.target.checked)}/>慢放</label>
        {running && <button type="button" onClick={() => setPaused(value => !value)}>{paused ? '继续' : '暂停'}</button>}
        <button type="button" onClick={reset} disabled={phase === 'ready'}>还原</button>
        <button type="button" className="es-send" onClick={start} disabled={running}>{phase === 'sent' ? '再寄一次' : '寄出这页'}<span aria-hidden="true">↑</span></button>
      </div>
      <label className="es-scrub"><span>逐帧查看</span><input type="range" min="0" max="1000" step="1" value={Math.round(progress * 1000)} aria-label="动画进度" disabled={reduced} onChange={event => seek(Number(event.target.value) / 1000)}/><output>{Math.round(progress * 100)}%</output></label>
    </footer>
  </section>;
}
