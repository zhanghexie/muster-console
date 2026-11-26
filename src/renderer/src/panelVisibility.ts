/** Confirm the page is actually painted and stable, including a late-starting axis transition. */
export async function settlePanelVisibility(selector: '.git-page' | '.terminal-page', current: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + 3500;
  let stableFrames = 0;
  await new Promise<void>((resolve, reject) => {
    const check = (): void => {
      try {
        if (!current()) throw new Error('Workspace page selection changed');
        const page = document.querySelector<HTMLElement>(selector);
        if (!page) throw new Error('Workspace page is unavailable');
        const rect = page.getBoundingClientRect(), style = getComputedStyle(page);
        const visibleWidth = Math.max(0, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left));
        const visibleHeight = Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top));
        const visible = style.display !== 'none' && style.visibility === 'visible' && rect.width > 0 && rect.height > 0 &&
          visibleWidth >= Math.min(rect.width, window.innerWidth) * 0.9 && visibleHeight >= Math.min(rect.height, window.innerHeight) * 0.9;
        const running = [document.querySelector('.h-strip'), document.querySelector('.git-page'), document.querySelector('.terminal-page')]
          .some(element => element?.getAnimations?.().some(animation => animation.playState === 'running' || animation.pending));
        stableFrames = visible && !running ? stableFrames + 1 : 0;
        if (stableFrames >= 2) { resolve(); return; }
        if (Date.now() >= deadline) throw new Error('Workspace page is not sufficiently visible');
        requestAnimationFrame(check);
      } catch (error) { reject(error); }
    };
    requestAnimationFrame(check);
  });
}
