/// <reference path="./assets.d.ts" />
import { DEFAULT_WORKSPACE_ICON, WORKSPACE_ICON_PREFIX, workspaceIconId, type WorkspaceIconId } from '../../shared/workspaceIcons';
import { isImageAvatarSrc } from '../../shared/userAvatar';
import newsUrl from './assets/workspaces/news.webp';
import socialUrl from './assets/workspaces/social.webp';
import messagingUrl from './assets/workspaces/messaging.webp';
import developmentUrl from './assets/workspaces/development.webp';
import videoUrl from './assets/workspaces/video.webp';
import musicUrl from './assets/workspaces/music.webp';
import liveUrl from './assets/workspaces/live.webp';
import photographyUrl from './assets/workspaces/photography.webp';
import designUrl from './assets/workspaces/design.webp';
import writingUrl from './assets/workspaces/writing.webp';
import readingUrl from './assets/workspaces/reading.webp';
import educationUrl from './assets/workspaces/education.webp';
import calendarUrl from './assets/workspaces/calendar.webp';
import tasksUrl from './assets/workspaces/tasks.webp';
import notesUrl from './assets/workspaces/notes.webp';
import mailUrl from './assets/workspaces/mail.webp';
import cloudUrl from './assets/workspaces/cloud.webp';
import securityUrl from './assets/workspaces/security.webp';
import dataUrl from './assets/workspaces/data.webp';
import financeUrl from './assets/workspaces/finance.webp';
import shoppingUrl from './assets/workspaces/shopping.webp';
import travelUrl from './assets/workspaces/travel.webp';
import mapsUrl from './assets/workspaces/maps.webp';
import healthUrl from './assets/workspaces/health.webp';
import gamepadUrl from './assets/workspaces/gamepad.webp';
import actionUrl from './assets/workspaces/action.webp';
import shooterUrl from './assets/workspaces/shooter.webp';
import rpgUrl from './assets/workspaces/rpg.webp';
import strategyUrl from './assets/workspaces/strategy.webp';
import racingUrl from './assets/workspaces/racing.webp';
import sportsUrl from './assets/workspaces/sports.webp';
import puzzleUrl from './assets/workspaces/puzzle.webp';
import simulationUrl from './assets/workspaces/simulation.webp';
import sandboxUrl from './assets/workspaces/sandbox.webp';
import rhythmUrl from './assets/workspaces/rhythm.webp';
import cardsUrl from './assets/workspaces/cards.webp';
const urls: Record<WorkspaceIconId, string> = {
  news: newsUrl,
  social: socialUrl,
  messaging: messagingUrl,
  development: developmentUrl,
  video: videoUrl,
  music: musicUrl,
  live: liveUrl,
  photography: photographyUrl,
  design: designUrl,
  writing: writingUrl,
  reading: readingUrl,
  education: educationUrl,
  calendar: calendarUrl,
  tasks: tasksUrl,
  notes: notesUrl,
  mail: mailUrl,
  cloud: cloudUrl,
  security: securityUrl,
  data: dataUrl,
  finance: financeUrl,
  shopping: shoppingUrl,
  travel: travelUrl,
  maps: mapsUrl,
  health: healthUrl,
  gamepad: gamepadUrl,
  action: actionUrl,
  shooter: shooterUrl,
  rpg: rpgUrl,
  strategy: strategyUrl,
  racing: racingUrl,
  sports: sportsUrl,
  puzzle: puzzleUrl,
  simulation: simulationUrl,
  sandbox: sandboxUrl,
  rhythm: rhythmUrl,
  cards: cardsUrl,
};
export function workspaceIconUrl(value?: string): string | undefined {
  const id = workspaceIconId(value);
  if (id) return urls[id];
  if (value?.trim().startsWith(WORKSPACE_ICON_PREFIX)) return urls[workspaceIconId(DEFAULT_WORKSPACE_ICON)!];
  return undefined;
}
export function workspaceAvatarImageSrc(value?: string): string | undefined {
  return workspaceIconUrl(value) ?? (value && isImageAvatarSrc(value) ? value : undefined);
}
