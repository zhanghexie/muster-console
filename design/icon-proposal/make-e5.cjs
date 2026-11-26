// E5：中性近黑底 + 加大细节的环轨图标（去弧）
// 卫星点三色候选 + 底色深度测试（#000 / #101010 / #1A1A1A）
const fs = require('fs');
const path = require('path');
const dir = __dirname;

function orbitSvg({ tile, dot, dotPos = { x: 682, y: 270 } }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <!-- E5 环轨·加大版：轨道 r296/线宽46，核心 r120，卫星 r80；底 ${tile} -->
  <rect x="32" y="32" width="960" height="960" rx="216" fill="${tile}"/>
  <rect x="33" y="33" width="958" height="958" rx="215" fill="none" stroke="#FFFFFF" stroke-opacity="0.07" stroke-width="2"/>
  <circle cx="512" cy="512" r="296" fill="none" stroke="#E4E4E4" stroke-opacity="0.4" stroke-width="46"/>
  <circle cx="512" cy="512" r="120" fill="#E4E4E4"/>
  <circle cx="${dotPos.x}" cy="${dotPos.y}" r="80" fill="${dot}"/>
  <circle cx="221" cy="563" r="80" fill="#E4E4E4"/>
  <circle cx="584" cy="799" r="80" fill="#E4E4E4"/>
</svg>
`;
}

const T = '#101010';
const files = [
  { f: 'icon-e5-mint.svg', tile: T, dot: '#45D0A0' },
  { f: 'icon-e5-blue.svg', tile: T, dot: '#58A6FF' },
  { f: 'icon-e5-violet.svg', tile: T, dot: '#8B7CFF' },
  { f: 'icon-e5-tile-black.svg', tile: '#000000', dot: '#45D0A0' },
  { f: 'icon-e5-tile-app.svg', tile: '#1A1A1A', dot: '#45D0A0' }
];
for (const { f, tile, dot } of files) {
  fs.writeFileSync(path.join(dir, f), orbitSvg({ tile, dot }));
  console.log('wrote', f);
}
