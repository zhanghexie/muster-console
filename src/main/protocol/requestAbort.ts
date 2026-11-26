import type { IncomingMessage, ServerResponse } from 'node:http';

/** A normal request-body close is not cancellation. Only abort or an unfinished response disconnect is. */
export function requestAbort(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => { if (!res.writableEnded) abort(); dispose(); };
  const dispose = () => {
    req.removeListener('aborted', abort);
    res.removeListener('close', close);
    res.removeListener('finish', dispose);
  };
  req.once('aborted', abort);
  res.once('close', close);
  res.once('finish', dispose);
  if (req.aborted || res.destroyed) abort();
  return { signal: controller.signal, controller, abort, dispose };
}
