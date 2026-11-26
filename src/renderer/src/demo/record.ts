import { record } from '@rrweb/record';
import type { DemoRecordingBridge, DemoVisualEvent } from '../../../shared/demoReplay';
import { t } from '../../../shared/i18n';
import { privateFields, recordSurfaces } from './surfaces';

export function startRecording(bridge: DemoRecordingBridge) {
  const opened = bridge.start();
  if (!opened.id) throw new Error(opened.error || t('录制文件不可用'));
  const id = opened.id;
  let pending: DemoVisualEvent[] = [], failed = false;
  let stop: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  function flush() {
    clearTimeout(timer); timer = undefined;
    if (!pending.length || failed) return;
    const events = pending; pending = [];
    const result = bridge.append(id, events);
    if (!result.ok) {
      failed = true; stop?.();
      window.alert(t('演示录制已停止，已保存的部分仍可使用。\n{{error}}', { error: result.error }));
    }
  }
  stop = record({
    emit(event) {
      if (failed) return;
      pending.push(event);
      if (pending.length >= 200 || event.type === 2) flush();
      else timer ??= setTimeout(flush, 100);
    },
    inlineStylesheet: true, inlineImages: true, recordAfter: 'DOMContentLoaded',
    blockSelector: privateFields,
    slimDOMOptions: { script: true }, sampling: { mousemove: 40 },
    keepIframeSrcFn: () => false
  });
  if (!stop) throw new Error(t('页面录制器初始化失败。'));
  let reported = false;
  const stopSurfaces = recordSurfaces(bridge, id, error => {
    if (!reported) { console.error('[demo] 无法保存画布或扩展画面', error); reported = true; }
  });
  window.addEventListener('pagehide', () => { stop?.(); stopSurfaces(); flush(); }, { once: true });
}
