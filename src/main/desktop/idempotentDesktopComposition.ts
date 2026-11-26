import { DesktopActionIdempotency } from './actionIdempotency';
import { IdempotentVisibleDispatcher } from './idempotentVisibleDispatcher';

/**
 * Host-owned receipt storage. Close only after the visible runtime has stopped
 * and its backend calls have settled; an unconfirmed cleanup must leave it open.
 */
export function createIdempotentDesktopComposition(directory: string) {
  const receipts = new DesktopActionIdempotency(directory);
  let closed = false;
  try {
    const dispatcher = new IdempotentVisibleDispatcher(receipts);
    return Object.freeze({ dispatcher, async close(): Promise<void> {
      if (closed) return;
      closed = true;
      receipts.close();
    } });
  } catch (error) { receipts.close(); throw error; }
}
