// E4 去弧版：卫星点六色候选（几何不变，仅换点色）
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const base = fs.readFileSync(path.join(dir, 'icon-e.svg'), 'utf8');

const noArc = base.replace(/  <path d="M 547 224[\s\S]*?\/>\n/, '');
const head = noArc.slice(0, noArc.indexOf('<circle cx="678"'));
const tail = noArc.slice(noArc.indexOf('<circle cx="232"'));

const colors = [
  { id: 'c1', hex: '#4FB3C9', name: '青', note: '冷调青，与藏蓝同族（上轮 E1 色）' },
  { id: 'c2', hex: '#58A6FF', name: '科技蓝', note: 'GitHub/VS Code 系，最主流' },
  { id: 'c3', hex: '#8B7CFF', name: '蓝紫', note: 'Linear/Stripe 系，AI 产品色' },
  { id: 'c4', hex: '#F5A83C', name: '琥珀', note: '暖点冷底强对比，状态灯感' },
  { id: 'c5', hex: '#45D0A0', name: '薄荷', note: '冷化的绿，保住「运行中」语义' },
  { id: 'c6', hex: '#FFFFFF', name: '纯白', note: '临床单色参照' }
];

for (const c of colors) {
  const svg =
    `<!-- E4 去弧 · 卫星点 ${c.name} ${c.hex} -->\n` +
    head +
    `<circle cx="678" cy="274" r="54" fill="${c.hex}"/>\n  ` +
    tail;
  fs.writeFileSync(path.join(dir, `icon-e4-${c.id}.svg`), svg);
  console.log('wrote', `icon-e4-${c.id}.svg`, c.hex);
}
