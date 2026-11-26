import { t } from '../../shared/i18n';
export interface DemoOptions {
  mode: 'build' | 'run' | 'delete';
  scene: string;
  allScenes: boolean;
  base?: string;
  record: boolean;
  replay?: string;
  list: boolean;
  speed: number;
  from: number;
}

export function replayTitleBar(platform: NodeJS.Platform): Pick<Electron.BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay'> {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  if (platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#202023', symbolColor: '#ededee', height: 36 } };
  return {};
}

export function parseDemoArgs(args: readonly string[]): DemoOptions | null {
  const modes = args.filter(value => /^--demo-(build|run|delete)$/.test(value));
  if (!modes.length) return null;
  if (modes.length !== 1) throw new Error(t('请只选一个 demo 启动模式。'));
  const mode = modes[0].slice(7) as DemoOptions['mode'];
  const options = new Map<string, string>();
  let list = false;
  let record = false;
  for (let i = 0; i < args.length; i++) {
    const [key] = args[i].split('=', 1);
    if (key === '--record') {
      if (mode !== 'build' || args[i] !== key) throw new Error(t('整窗录制开关 --record 仅用于 demo-build，无需参数。'));
      record = true;
      continue;
    }
    if (key === '--list') { list = true; continue; }
    if (!['--scene', '--demo-base', '--replay', '--speed', '--from'].includes(key)) continue;
    if (options.has(key)) throw new Error(t('重复参数 {{option}}', { option: key }));
    let value = args[i].includes('=') ? args[i].slice(key.length + 1) : undefined;
    if (value === undefined && args[i + 1] && !args[i + 1].startsWith('--')) value = args[++i];
    if (value === undefined && key === '--replay') value = 'latest';
    if (!value?.trim()) throw new Error(t('缺少参数值 {{option}}', { option: key }));
    options.set(key, value);
  }
  const scene = (options.get('--scene') ?? 'default').normalize('NFC');
  if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(scene) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(scene)) {
    throw new Error(t('场景名需为 1–64 个文字、数字、下划线或短横线。'));
  }
  const replay = options.get('--replay');
  if (replay && replay !== 'latest' && !/^\d{8}T\d{9}Z-[a-f0-9]{8}$/.test(replay)) throw new Error(t('无效回放编号，可用 --list 查看。'));
  const speed = Number(options.get('--speed') ?? 1), from = Number(options.get('--from') ?? 0);
  if (!Number.isFinite(speed) || speed <= 0 || speed > 32 || !Number.isFinite(from) || from < 0) throw new Error(t('回放倍速须为 0–32 之间的正数，起点为非负秒数。'));
  if ((list || replay) && mode !== 'run' || list && replay || (!replay && (options.has('--speed') || options.has('--from')))) {
    throw new Error(t('--list 和 --replay 分别用于 demo-run，--speed、--from 用于回放。'));
  }
  return { mode, scene, allScenes: mode === 'delete' && !options.has('--scene'), base: options.get('--demo-base'), record, replay, list, speed, from };
}
