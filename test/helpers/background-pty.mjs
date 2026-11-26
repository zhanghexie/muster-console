/** Controlled PTY boundary for Shell task tests; no process ownership is mocked in production. */
export function installFakeOwnedBackground(pty) {
  pty.spawnOwnedBackground = async (id, launch, cwd, assertCurrent) => {
    assertCurrent(); pty.spawn(id, launch, cwd);
    let resolve, reject;
    const completed = new Promise((yes, no) => { resolve = yes; reject = no; });
    void completed.catch(() => {});
    const unsubscribe = pty.addExitListener((sid, code) => { if (sid === id) { unsubscribe(); resolve(code); } });
    let closing;
    return { completed, close() {
      if (closing) return closing;
      unsubscribe(); reject(Error('cancelled'));
      closing = Promise.resolve().then(() => pty.killAndWait ? pty.killAndWait(id) : pty.kill(id));
      return closing;
    } };
  };
}
