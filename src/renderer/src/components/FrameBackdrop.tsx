/**
 * 窗口背景层（框底图）：主窗口（variant="window"，fixed 垫在整棵树下）、设置页与设置缩略图共用。
 * 模板与参数见 shared/frameBackdrop.ts；样式 styles/backdrop.css；
 * 几何系构图坐标以 docs/prototypes/frame-backdrop-templates/frame-backdrop-templates.html 的 GEO 为准。
 */
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react';
import {
  frameBackdropKind,
  SOLID_LEVELS,
  DEFAULT_WALLPAPER_BLUR,
  DEFAULT_WALLPAPER_DIM,
  type FrameBackdropChoice,
  type FrameBackdropGeoId
} from '../../../shared/frameBackdrop';
import { buildExternalFileUrl } from '../../../shared/filePreview';

/** SVG 内高斯模糊半径（viewBox 单位，随缩放等比；缩略图与大窗口同观感） */
const GEO_BLUR = 44;

const GRAIN: Partial<Record<FrameBackdropChoice['id'], string>> = {
  horizon: 'has-grain',
  velvet: 'has-grain-strong',
  mesh: 'has-grain',
  mondrian: 'has-grain',
  albers: 'has-grain',
  bauhaus: 'has-grain',
  suprematism: 'has-grain'
};

function GeoBody({ id, uid }: { id: FrameBackdropGeoId; uid: string }): ReactNode {
  const blur = `url(#${uid}b)`;
  switch (id) {
    case 'mondrian':
      return (
        <g filter={blur}>
          <rect className="fb-g-cv" x="0" y="60" width="260" height="270" />
          <rect className="fb-g-cv" x="270" y="60" width="840" height="270" />
          <rect className="fb-g-cv" x="1120" y="60" width="480" height="270" />
          <rect className="fb-g-a" x="0" y="340" width="260" height="460" />
          <rect className="fb-g-cv" x="270" y="340" width="560" height="300" />
          <rect className="fb-g-a3" x="840" y="340" width="270" height="300" />
          <rect className="fb-g-cv" x="1120" y="340" width="480" height="600" />
          <rect className="fb-g-cv" x="270" y="650" width="560" height="290" />
          <rect className="fb-g-a2" x="840" y="650" width="270" height="140" />
          <rect className="fb-g-cv" x="840" y="800" width="270" height="140" />
          <rect className="fb-g-ad" x="0" y="810" width="260" height="130" />
        </g>
      );
    case 'albers':
      return (
        <g filter={blur}>
          <rect className="fb-g-ad" x="40" y="200" width="700" height="700" />
          <rect className="fb-g-a3" x="120" y="320" width="540" height="540" />
          <rect className="fb-g-a" x="200" y="440" width="380" height="380" />
          <rect className="fb-g-a2" x="280" y="560" width="220" height="220" />
        </g>
      );
    case 'bauhaus':
      return (
        <g filter={blur}>
          <circle className="fb-g-a" cx="300" cy="700" r="260" />
          <path className="fb-g-a2" d="M620 940 A200 200 0 0 1 1020 940 Z" />
          <path className="fb-g-a3" d="M980 940 L1180 560 L1380 940 Z" />
          <circle className="fb-g-ad" cx="980" cy="360" r="64" />
          <rect className="fb-g-ink" x="90" y="390" width="600" height="14" />
          <circle className="fb-g-ring" cx="520" cy="520" r="120" />
        </g>
      );
    case 'suprematism':
      return (
        <g filter={blur}>
          <g transform="rotate(-16 600 640)">
            <rect className="fb-g-a" x="140" y="600" width="760" height="64" />
            <rect className="fb-g-ink" x="220" y="700" width="420" height="10" />
          </g>
          <g transform="rotate(12 620 460)">
            <rect className="fb-g-a3" x="540" y="380" width="170" height="170" />
          </g>
          <g transform="rotate(-28 300 820)">
            <rect className="fb-g-a2" x="180" y="800" width="340" height="34" />
          </g>
          <circle className="fb-g-ad" cx="980" cy="760" r="46" />
          <g transform="rotate(-16 1000 420)">
            <rect className="fb-g-ink" x="860" y="410" width="260" height="6" />
          </g>
        </g>
      );
    case 'grid':
      // 细网格线不糊（本就很淡，糊了即消失），只糊色块与圆环
      return (
        <>
          <defs>
            <pattern id={`${uid}p`} width="40" height="40" patternUnits="userSpaceOnUse">
              <path className="fb-g-line" d="M40 0H0V40" />
            </pattern>
            <pattern id={`${uid}P`} width="200" height="200" patternUnits="userSpaceOnUse">
              <path className="fb-g-line-b" d="M200 0H0V200" />
            </pattern>
            <radialGradient id={`${uid}m`} cx="0" cy="1" r="1.15">
              <stop offset="0" stopColor="#fff" />
              <stop offset=".75" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
            <mask id={`${uid}k`}>
              <rect x="0" y="60" width="1600" height="880" fill={`url(#${uid}m)`} />
            </mask>
          </defs>
          <g mask={`url(#${uid}k)`}>
            <rect x="0" y="60" width="1600" height="880" fill={`url(#${uid}p)`} />
            <rect x="0" y="60" width="1600" height="880" fill={`url(#${uid}P)`} />
          </g>
          <g filter={blur}>
            <rect className="fb-g-a" x="200" y="600" width="200" height="200" />
            <rect className="fb-g-a3" x="400" y="800" width="400" height="40" />
            <circle className="fb-g-ring" cx="600" cy="600" r="80" />
          </g>
        </>
      );
  }
}

export interface FrameBackdropProps {
  choice: FrameBackdropChoice;
  /** window：主窗口 fixed 铺满视口；inline（缺省）：铺满最近的定位祖先（设置页 / 缩略图） */
  variant?: 'window' | 'inline';
  /** 壁纸顶部渐隐起点（缩略图按比例缩小）；缺省 36px = 顶栏高 */
  topInset?: number;
  className?: string;
  /** 壁纸加载失败（文件被外部删除等）：回落角光后通知 */
  onImageError?: () => void;
}

export function FrameBackdrop({
  choice,
  variant = 'inline',
  topInset,
  className,
  onImageError
}: FrameBackdropProps): React.JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const kind = frameBackdropKind(choice.id);
  const imageUrl = kind === 'image' && choice.image ? buildExternalFileUrl(choice.image) : '';
  const [brokenUrl, setBrokenUrl] = useState('');

  useEffect(() => {
    if (!imageUrl) return;
    let alive = true;
    const img = new Image();
    img.onerror = () => {
      if (!alive) return;
      setBrokenUrl(imageUrl);
      onImageError?.();
    };
    img.src = imageUrl;
    return () => {
      alive = false;
    };
    // onImageError 只在失败瞬间读，不参与重订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  const broken = !!imageUrl && brokenUrl === imageUrl;
  const id = kind === 'image' && (!imageUrl || broken) ? 'corner' : choice.id;
  const style: CSSProperties & Record<string, string> = {};
  if (id === 'solid') style['--fb-solid-k'] = `${SOLID_LEVELS[choice.solidLevel ?? 'deep']}%`;
  if (id === 'custom') {
    style['--fb-blur'] = `${choice.blur ?? DEFAULT_WALLPAPER_BLUR}px`;
    style['--fb-dim'] = String((choice.dim ?? DEFAULT_WALLPAPER_DIM) / 100);
    if (topInset !== undefined) style['--fb-top'] = `${topInset}px`;
  }
  const cls = [
    'frame-backdrop',
    `fb-${id}`,
    variant === 'window' ? 'is-window' : '',
    GRAIN[id] ?? '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} style={style} data-backdrop={id} aria-hidden="true">
      {frameBackdropKind(id) === 'geo' ? (
        <svg className="frame-backdrop-art" viewBox="0 0 1600 940" preserveAspectRatio="xMinYMax slice">
          <defs>
            <filter id={`${uid}b`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation={GEO_BLUR} />
            </filter>
          </defs>
          <GeoBody id={id as FrameBackdropGeoId} uid={uid} />
        </svg>
      ) : null}
      {id === 'custom' ? (
        <>
          <div className="frame-backdrop-img" style={{ backgroundImage: `url("${imageUrl}")` }} />
          <div className="frame-backdrop-dim" />
        </>
      ) : null}
    </div>
  );
}
