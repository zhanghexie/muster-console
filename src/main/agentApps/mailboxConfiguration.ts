import type { AppConnection, AppConnectionInput, AppPermission } from '../../shared/agentApps';

const textFields = ['id', 'name', 'address', 'user', 'imapHost', 'smtpHost', 'mailbox', 'imapTls', 'smtpTls', 'notify'] as const;
const secretFields = ['password', 'smtpPassword', 'passwordEnv', 'smtpPasswordEnv'] as const;
const fields = new Set<string>([...textFields, ...secretFields, 'imapPort', 'smtpPort', 'enabled', 'grants', 'expectedRevision', 'notificationHint']);

/** Explicit allowlist: tool metadata and credential references never enter connection storage. */
export function prepareMailboxConnection(params: Record<string, unknown>, connections: AppConnection[], env: NodeJS.ProcessEnv = process.env): AppConnectionInput {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Mailbox params must be an object');
  for (const key of Object.keys(params)) if (!fields.has(key)) throw new Error(`Unknown mailbox parameter: ${key}`);
  for (const key of [...textFields, ...secretFields]) {
    if (params[key] !== undefined && (typeof params[key] !== 'string' || !(params[key] as string).trim())) throw new Error(`${key} must be a non-empty string`);
  }
  if (typeof params.id !== 'string' || !params.id.trim()) throw new Error('Mailbox id is required');
  const id = params.id.trim(), old = connections.find(c => c.id === id);
  if (old && old.kind !== 'imap-smtp') throw new Error('This connection is not an IMAP/SMTP mailbox');
  if (params.expectedRevision !== undefined && (!Number.isInteger(params.expectedRevision) || Number(params.expectedRevision) < 1)) throw new Error('Invalid expectedRevision');
  if (!old && params.expectedRevision !== undefined) throw new Error('Connection not found; reload connections before saving');
  if (old && params.expectedRevision !== old.revision) throw new Error('Connection changed or expectedRevision missing; reload connections before saving');
  if (params.enabled !== undefined && typeof params.enabled !== 'boolean') throw new Error('enabled must be a boolean');
  const grants = (params.grants ?? old?.grants ?? { mail: ['mail.read'] }) as Record<string, AppPermission[]>;
  if (params.grants === null || typeof grants !== 'object' || Array.isArray(grants) || Object.values(grants).some(value => !Array.isArray(value) || value.some(p => p !== 'mail.read' && p !== 'mail.send'))) throw new Error('Mailbox grants must contain only mail.read/mail.send');
  const secret = (key: 'password' | 'smtpPassword'): string | undefined => {
    const ref = params[`${key}Env`];
    if (ref !== undefined && params[key] !== undefined) throw new Error(`Use either ${key} or ${key}Env`);
    if (ref === undefined) return params[key] as string | undefined;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(ref))) throw new Error(`Invalid ${key}Env name`);
    const value = env[String(ref)];
    if (!value) throw new Error(`${key}Env is not set in the workbench process`);
    return value;
  };
  const address = (params.address ?? old?.address) as string;
  for (const [key, value] of Object.entries({ address, imapHost: params.imapHost ?? old?.imapHost, smtpHost: params.smtpHost ?? old?.smtpHost })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  }
  for (const key of ['imapPort', 'smtpPort'] as const) if (params[key] !== undefined && !Number.isInteger(params[key])) throw new Error(`${key} must be an integer`);
  const imapTls = (params.imapTls ?? old?.imapTls ?? 'tls') as 'tls' | 'starttls';
  const smtpTls = (params.smtpTls ?? old?.smtpTls ?? 'tls') as 'tls' | 'starttls';
  return {
    kind: 'imap-smtp', id, name: (params.name ?? old?.name ?? address) as string,
    address, user: (params.user ?? old?.user ?? address) as string,
    imapHost: (params.imapHost ?? old?.imapHost) as string,
    smtpHost: (params.smtpHost ?? old?.smtpHost) as string,
    imapTls, smtpTls,
    imapPort: (params.imapPort ?? old?.imapPort ?? (imapTls === 'tls' ? 993 : 143)) as number,
    smtpPort: (params.smtpPort ?? old?.smtpPort ?? (smtpTls === 'tls' ? 465 : 587)) as number,
    mailbox: (params.mailbox ?? old?.mailbox ?? 'INBOX') as string,
    enabled: (params.enabled ?? old?.enabled ?? true) as boolean,
    notify: (params.notify ?? old?.notify ?? 'wake') as 'wake' | 'digest' | 'mute',
    notificationHint: (params.notificationHint ?? old?.notificationHint ?? '') as string,
    grants: structuredClone(grants), expectedRevision: params.expectedRevision as number | undefined,
    password: secret('password'), smtpPassword: secret('smtpPassword')
  };
}
