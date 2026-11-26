/** Logical session identity and portable artifact-directory identity are deliberately separate. */
const WORKER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SCHEDULER_ID = new RegExp(`^orchestrator:(${UUID})$`);
const SCHEDULER_DIRECTORY = new RegExp(`^orchestrator[.](${UUID})$`);

export function uiWidgetSessionDirectory(sessionId: unknown): string {
  if (typeof sessionId !== 'string') throw new Error('Invalid host session identity');
  const scheduler = SCHEDULER_ID.exec(sessionId);
  if (scheduler) return `orchestrator.${scheduler[1]}`;
  if (WORKER_ID.test(sessionId)) return sessionId;
  throw new Error('Invalid host session identity');
}

/** The dot namespace cannot collide with any accepted Worker identity. */
export function uiWidgetSessionFromDirectory(directory: string): string {
  const scheduler = SCHEDULER_DIRECTORY.exec(directory);
  if (scheduler) return `orchestrator:${scheduler[1]}`;
  if (WORKER_ID.test(directory)) return directory;
  throw new Error('Invalid host session identity');
}
