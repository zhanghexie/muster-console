/** Opaque reference issued by a trusted host credential provider. Never a token or secret. */
export type CredentialRef = Readonly<{ provider: string; id: string }>;

/** Available only to a host-owned transport. The messaging store persists references alone. */
export interface MessagingCredentialProvider {
  read(ref: CredentialRef, signal: AbortSignal): Promise<Readonly<Record<string, string>>>;
  revoke(ref: CredentialRef): Promise<void>;
}
