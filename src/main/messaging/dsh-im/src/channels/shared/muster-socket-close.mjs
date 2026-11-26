/** Observe close even when the transport is already shutting down. */
export function closeSocketAndWait(socket) {
  if (!socket || socket.readyState === 3) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const close = () => { remove(); resolve(); };
    const eventTarget = typeof socket.addEventListener === 'function';
    const remove = () => {
      if (eventTarget) socket.removeEventListener('close', close);
      else socket.off('close', close);
    };
    if (eventTarget) socket.addEventListener('close', close, { once: true });
    else socket.once('close', close);
    try {
      if (socket.readyState < 2) socket.close(1000, 'Plugin stopped');
      if (socket.readyState === 3) close();
    } catch (error) {
      remove();
      reject(error);
    }
  });
}
