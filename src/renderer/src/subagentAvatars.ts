/// <reference path="./assets.d.ts" />
import { DEFAULT_SUBAGENT_CHARACTER_ID, getSubagentCharacter, type SubagentCharacterId } from '../../shared/subagentCharacters';
import pixelUrl from './assets/subagents/pixel.webp';
import rivetUrl from './assets/subagents/rivet.webp';
import quantumUrl from './assets/subagents/quantum.webp';
import welderUrl from './assets/subagents/welder.webp';
import scoutUrl from './assets/subagents/scout.webp';
import sentinelUrl from './assets/subagents/sentinel.webp';
import compassUrl from './assets/subagents/compass.webp';
import joineryUrl from './assets/subagents/joinery.webp';
import atlasUrl from './assets/subagents/atlas.webp';
import piUrl from './assets/subagents/pi.webp';
import bubbleUrl from './assets/subagents/bubble.webp';
import wrenchUrl from './assets/subagents/wrench.webp';
import bookmarkUrl from './assets/subagents/bookmark.webp';
import inkUrl from './assets/subagents/ink.webp';
import bridgeUrl from './assets/subagents/bridge.webp';
import beanUrl from './assets/subagents/bean.webp';
import healerUrl from './assets/subagents/healer.webp';
import sproutUrl from './assets/subagents/sprout.webp';
import stewUrl from './assets/subagents/stew.webp';
import noteUrl from './assets/subagents/note.webp';
import paletteUrl from './assets/subagents/palette.webp';
import shutterUrl from './assets/subagents/shutter.webp';
import scalesUrl from './assets/subagents/scales.webp';
import courierUrl from './assets/subagents/courier.webp';

// Static imports ship with the application on every platform. No remote/userData paths.
const assets: Record<SubagentCharacterId, string> = {
  pixel: pixelUrl,
  rivet: rivetUrl,
  quantum: quantumUrl,
  welder: welderUrl,
  scout: scoutUrl,
  sentinel: sentinelUrl,
  compass: compassUrl,
  joinery: joineryUrl,
  atlas: atlasUrl,
  pi: piUrl,
  bubble: bubbleUrl,
  wrench: wrenchUrl,
  bookmark: bookmarkUrl,
  ink: inkUrl,
  bridge: bridgeUrl,
  bean: beanUrl,
  healer: healerUrl,
  sprout: sproutUrl,
  stew: stewUrl,
  note: noteUrl,
  palette: paletteUrl,
  shutter: shutterUrl,
  scales: scalesUrl,
  courier: courierUrl,
};
export function subagentAvatarUrl(characterId?: string): string {
  const id = getSubagentCharacter(characterId)?.id ?? DEFAULT_SUBAGENT_CHARACTER_ID;
  return assets[id];
}
