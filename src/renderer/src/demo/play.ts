import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import { applyLocaleSetting, t } from '../../../shared/i18n';

document.documentElement.lang = applyLocaleSetting('system', navigator.language);
document.title = t('集序 · 场景回放');
const status = document.querySelector<HTMLElement>('#status')!;
status.textContent = t('正在读取本地回放…');

async function play() {
  const bridge = window.demoReplay;
  if (!bridge) throw new Error(t('请通过 demo-run --replay 打开。'));
  const root = document.querySelector<HTMLElement>('#scene')!;
  const events: ConstructorParameters<typeof Replayer>[0] = [];
  let batch;
  do {
    batch = await bridge.next();
    for (const event of batch.events) events.push(event as Exclude<typeof events[number], string>);
  } while (!batch.done);
  if (events.length < 2) throw new Error(t('记录中缺少完整画面。'));
  const { width, height, speed, from } = batch;
  const offset = Math.round(from * 1000);
  let size = { width, height };
  let running = true, ended = false, pausedAt = offset;
  function createPlayer() {
    const next = new Replayer(events, { root, speed, skipInactive: false, mouseTail: false,
      // Fast-forward against the iframe itself so reparented chat panels survive a seek.
      useVirtualDom: false,
      UNSAFE_replayCanvas: false, triggerFocus: false, showWarning: false,
      insertStyleRules: ['img[data-muster-demo-surface] { display: block !important; }'] });
    let lastRevision: string | undefined;
    next.on('event-cast', () => {
      const frame = next.iframe.contentDocument?.documentElement;
      if (!frame) return;
      const { theme, appearanceRevision } = frame.dataset;
      if ((theme !== 'light' && theme !== 'dark') || !appearanceRevision || lastRevision === appearanceRevision) return;
      const panel = frame.style.getPropertyValue('--surface-frame').trim();
      const ink = frame.style.getPropertyValue('--frame-fg-primary').trim();
      if (!panel || !ink) return;
      lastRevision = appearanceRevision;
      bridge!.appearance({ appearance: theme, panel, ink });
    });
    next.on('resize', event => {
      const dimensions = event as typeof size;
      if (dimensions.width > 0 && dimensions.height > 0) { size = dimensions; fit(next); }
    });
    next.on('finish', () => { ended = true; running = false; });
    return next;
  }
  let player = createPlayer();
  function fit(current: Replayer) {
    const factor = Math.min(innerWidth / size.width, innerHeight / size.height);
    current.wrapper.style.transform = 'scale(' + factor + ')';
    current.wrapper.style.left = (innerWidth - size.width * factor) / 2 + 'px';
    current.wrapper.style.top = (innerHeight - size.height * factor) / 2 + 'px';
  }
  window.addEventListener('resize', () => fit(player));
  const { totalTime } = player.getMetaData();
  if (offset > totalTime) throw new Error(t('起点超过本条记录的时长 {{seconds}} 秒。', { seconds: (totalTime / 1000).toFixed(1) }));
  window.addEventListener('keydown', e => {
    if (e.repeat || !['Space', 'Home'].includes(e.code)) return;
    e.preventDefault();
    if (e.code === 'Home' || ended) {
      // Start each take with a clean DOM mirror, including after the final snapshot.
      player.destroy();
      size = { width, height }; ended = false; running = true;
      player = createPlayer(); fit(player); player.play(offset);
    }
    else if (running) { pausedAt = player.getCurrentTime(); player.pause(); running = false; }
    else { player.play(pausedAt); running = true; }
  });
  fit(player); status.replaceChildren(); player.play(offset);
}
void play().catch(error => { status.textContent = t('无法回放：{{error}}', { error: String(error) }); });
