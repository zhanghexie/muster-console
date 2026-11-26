/** Name migration only: merged operations still require explicit argument and policy adapters. */
const RENAMED: Readonly<Record<string, string>> = {
  'sessions.restartConversation': 'host.sessions.restart',
  'sessions.recoverInterrupted': 'host.sessions.recover',
  'sessions.readMessages': 'host.mail.read',
  'sessions.message': 'host.mail.send',
  'memory.journalGet': 'host.memory.journalRead',
  'memory.correctionStatus': 'host.memory.correction',
  'app.getConfig': 'host.config.get',
  'app.instances': 'host.instances.list',
  'git.refreshRepos': 'host.repos.refresh'
};

const COMBINED: Readonly<Record<string, string>> = {
  'sessions.completeAndArchive': 'host.sessions.review',
  'sessions.rename': 'host.sessions.update',
  'sessions.setPinned': 'host.sessions.update',
  'sessions.setArchived': 'host.sessions.update',
  'sessions.setModel': 'host.sessions.update',
  'sessions.setThinking': 'host.sessions.update',
  'sessions.setOrchestrated': 'host.sessions.update',
  'askQuestion': 'host.ask',
  'ui.confirm': 'host.ask',
  'ui.prompt': 'host.ask',
  'llm.quota': 'host.llm.run'
};

export type HostToolNameMigration =
  | { kind: 'rename'; name: string }
  | { kind: 'combined'; name: string }
  | { kind: 'action-routing'; name: 'host.sessions' }
  | { kind: 'extension'; name: string };

/** Transform a known internal host ID. This does not validate the ID or authorize calls. */
export function migrateHostToolName(name: string): HostToolNameMigration {
  if (!name || name.startsWith('host.')) throw new Error('Expected an unprefixed internal host tool ID');
  if (name.startsWith('ext.')) return { kind: 'extension', name };
  if (name === 'sessions.run') return { kind: 'action-routing', name: 'host.sessions' };
  if (Object.hasOwn(COMBINED, name)) return { kind: 'combined', name: COMBINED[name] };
  return { kind: 'rename', name: Object.hasOwn(RENAMED, name) ? RENAMED[name] : `host.${name}` };
}
