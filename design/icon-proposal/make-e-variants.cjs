// 生成 E 环轨的四个配色变体（几何不变，只动卫星/弧的颜色）
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const base = fs.readFileSync(path.join(dir, 'icon-e.svg'), 'utf8');

const ARC_OLD = '<path d="M 547 224 A 290 290 0 0 1 678 274" fill="none" stroke="#3FB950" stroke-width="26" stroke-linecap="round"/>';
const DOT_OLD = '<circle cx="678" cy="274" r="54" fill="#3FB950"/>';
const DIM1_OLD = '<circle cx="232" cy="560" r="54" fill="#E4E4E4"/>';
const DIM2_OLD = '<circle cx="583" cy="796" r="54" fill="#E4E4E4"/>';

function write(name, comment, transform) {
  const svg = base
    .replace(/<!-- E 环轨[^>]*-->/, `<!-- ${comment} -->`)
    .replace(/  <path d="M 547 224[\s\S]*?\/>\n/, transform.arc ? `  ${transform.arc}\n` : '')
    .replace(DOT_OLD, transform.dot)
    .replace(DIM1_OLD, transform.dim ? '<circle cx="232" cy="560" r="54" fill="#E4E4E4" fill-opacity="0.55"/>' : DIM1_OLD)
    .replace(DIM2_OLD, transform.dim ? '<circle cx="583" cy="796" r="54" fill="#E4E4E4" fill-opacity="0.55"/>' : DIM2_OLD);
  fs.writeFileSync(path.join(dir, name), svg);
  console.log('wrote', name);
}

// E1 青：冷调青与藏蓝同族
write('icon-e1.svg', 'E1 环轨·青：卫星与扫过弧换冷调青，与藏蓝底同族', {
  arc: '<path d="M 547 224 A 290 290 0 0 1 678 274" fill="none" stroke="#4FB3C9" stroke-width="26" stroke-linecap="round"/>',
  dot: '<circle cx="678" cy="274" r="54" fill="#4FB3C9"/>'
});

// E2 灰绿：降饱和鼠尾草绿
write('icon-e2.svg', 'E2 环轨·灰绿：降饱和鼠尾草绿，收敛刺眼感', {
  arc: '<path d="M 547 224 A 290 290 0 0 1 678 274" fill="none" stroke="#6FAF7D" stroke-width="26" stroke-linecap="round"/>',
  dot: '<circle cx="678" cy="274" r="54" fill="#6FAF7D"/>'
});

// E3 全单色：活跃卫星纯白 + 半透白弧，其余卫星降灰（最临床）
write('icon-e3.svg', 'E3 环轨·单色：活跃卫星纯白+半透白弧，其余降灰，全临床单色', {
  arc: '<path d="M 547 224 A 290 290 0 0 1 678 274" fill="none" stroke="#FFFFFF" stroke-opacity="0.5" stroke-width="26" stroke-linecap="round"/>',
  dot: '<circle cx="678" cy="274" r="54" fill="#FFFFFF"/>',
  dim: true
});

// E4 去弧：删扫过弧，卫星灰绿（验证「弧」是否为不协调来源）
write('icon-e4.svg', 'E4 环轨·去弧：无扫过弧，卫星灰绿', {
  arc: '',
  dot: '<circle cx="678" cy="274" r="54" fill="#6FAF7D"/>'
});
