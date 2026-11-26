import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 内联 SVG 组件的 path 数据必须是纯 SVG path 字符：混入单词会让整条 path 解析失败、
// 图标缺笔画。曾发生过批量替换把 'v3'/'V3' 写成 'extension'/'Extension'，下载、上传、
// 展开、收缩、警告、文件、铃铛、关于、盾形、写活动、视频等图标的笔画整体消失，故立此回归。
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'src/renderer/src/components/icons.tsx',
  'src/renderer/src/components/ActivityIcons.tsx',
  'src/renderer/src/components/FileTypeIcon.tsx'
];
let checked = 0;
for (const file of files) {
  const source = fs.readFileSync(path.join(repo, file), 'utf8');
  const paths = [...source.matchAll(/\bd="([^"]+)"/g)].map(match => match[1]);
  assert.ok(paths.length > 0, `${file} 应提取到 path 数据`);
  for (const data of paths) {
    const invalid = data.replace(/[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]/g, '');
    assert.equal(invalid, '', `${file} 的 path 数据混入非法字符 "${invalid}"：${data}`);
    checked += 1;
  }
}
console.log(`icon-path-data: ${files.length} 个内联 SVG 组件共 ${checked} 条 path 数据均为合法 SVG path 字符`);
