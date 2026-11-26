/** Data cleanup failed only after the engine connection was confirmed retired. */
export class GuiSessionDataCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuiSessionDataCleanupError';
  }
}
