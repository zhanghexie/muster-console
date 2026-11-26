/** Realize just the initial bottom viewport before the first pin. Keep these
 * rows realized through one paint so Chromium can replace CV estimates without
 * moving visible text; all older history keeps its normal skipped layout. */
export function prepareTranscriptBottom(root: HTMLElement): () => void {
  const rows: HTMLElement[] = [];
  let covered = 0;
  for (let row = root.querySelector('.agent-chat-col')?.lastElementChild;
    row && covered < root.clientHeight; row = row.previousElementSibling) {
    if (!(row instanceof HTMLElement)) continue;
    row.classList.add('chat-positioning-row');
    rows.push(row);
    covered += row.offsetHeight;
  }
  let frame: number | null = null;
  const release = (): void => {
    if (frame != null) cancelAnimationFrame(frame);
    frame = null;
    for (const row of rows) row.classList.remove('chat-positioning-row');
  };
  if (rows.length) frame = requestAnimationFrame(() => { frame = requestAnimationFrame(release); });
  return release;
}
