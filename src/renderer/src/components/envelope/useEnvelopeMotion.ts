import { useLayoutEffect, type RefObject } from 'react';
import { envelopeDuration, envelopePlaybackRate, envelopeTiming } from './EnvelopePaper';
import type { MailDirection } from './mailEnvelopeQueue';

/** Replay the actual CSS transitions, using a negative rate for incoming mail.
 * All tracks share the prototype's logical clock, including their original overlaps/delays/easing.
 */
export function useEnvelopeMotion(root: RefObject<HTMLDivElement>, running: boolean, direction: MailDirection,
  reduced: boolean, done: (played: boolean) => void, depart?: () => Promise<boolean>) {
  useLayoutEffect(() => {
    const scene = root.current;
    if (!running || !scene) return;
    if (reduced) { done(false); return; }
    scene.dataset.playing = 'false';
    void scene.offsetWidth;
    scene.dataset.playing = 'true';
    void scene.offsetWidth;
    const flights = [...scene.querySelectorAll<HTMLElement>('.es-flight')];
    const tracks = flights.flatMap(flight => flight.getAnimations?.({ subtree: true }) ?? []);
    const reverse = direction === 'receive';
    const flightTracks = !reverse && depart ? new Set(flights.flatMap(flight => flight.getAnimations?.() ?? [])) : undefined;
    if (flightTracks && !flightTracks.size) {
      void depart?.();
      for (const track of tracks) track.cancel();
      done(false);
      return;
    }
    if (!tracks.length) {
      if (reverse) scene.dataset.playing = 'false';
      done(true);
      return;
    }
    let time = reverse ? envelopeDuration : 0;
    for (const track of tracks) {
      track.pause();
      track.playbackRate = reverse ? -envelopePlaybackRate : envelopePlaybackRate;
      // Hold vertical movement before it reaches the compositor. Folding can run up to the cue.
      if (!flightTracks?.has(track)) track.play();
      // play() auto-rewinds negative-rate tracks to their own end. Seek afterwards
      // so short folds also wait on the common clock before unfolding.
      track.currentTime = time;
    }
    const draw = () => {
      scene.dataset.progress = String(time / envelopeDuration);
      scene.dataset.paperLayer = time >= envelopeTiming.top.duration ? 'inside' : 'front';
    };
    draw();
    let awaitingDeparture = !!flightTracks;
    let disposed = false;
    let frame = 0, previous = performance.now();
    const tick = (now: number) => {
      time = Math.min(envelopeDuration, Math.max(0, time + (now - previous) * envelopePlaybackRate * (reverse ? -1 : 1)));
      if (awaitingDeparture && depart && time >= envelopeTiming.flight.delay) {
        awaitingDeparture = false;
        time = envelopeTiming.flight.delay;
        for (const track of tracks) { track.pause(); track.currentTime = time; }
        draw();
        void depart().then(stored => {
          if (disposed) return;
          if (!stored) { done(false); return; }
          for (const track of tracks) track.play();
          previous = performance.now();
          frame = requestAnimationFrame(tick);
        });
        return;
      }
      previous = now; draw();
      if (reverse ? time <= 0 : time >= envelopeDuration) {
        if (reverse) scene.dataset.playing = 'false';
        done(true);
      } else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      for (const track of tracks) track.cancel();
    };
  }, [root, running, direction, reduced, done, depart]);
}
