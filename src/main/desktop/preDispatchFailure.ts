/** The host proved that the backend was not entered and its dispatch state was cleared. */
export class PreDispatchFailure extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause), { cause }); this.name = 'PreDispatchFailure'; }
}

/** No backend call occurred, but a durable marker or task lock may require recovery. */
export class PreDispatchRecoveryRequired extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'PreDispatchRecoveryRequired';
  }
}
