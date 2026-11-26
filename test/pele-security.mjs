/**
 * pele 安全回归：mermaid 围栏源码（模型产出，视为不可信输入）经 pele.render 后
 * 以 innerHTML 注入文档——输出不得携带可执行内容。
 * 覆盖：标签注入、事件属性注入、javascript: 链接、正常链接的 rel=noopener。
 * 运行: node test/pele-security.mjs（pele DOM-free，node 直接可渲）
 */
import assert from 'node:assert/strict';
import { render } from 'pele';

function svgOf(source) {
  return render(source, { fontFamily: 'sans-serif' }).svg;
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name} :: ${err.message}`);
  }
}

const TAG_RE = /<script|<iframe|<img|<foreignObject|<animate|<set\b/gi;
const EVENT_ATTR_RE = /<[a-z][^>]*\son[a-z]+\s*=/i;

check('标签注入：label 里的 script/iframe/img/onerror 全部不得成为元素或属性', () => {
  const svg = svgOf(
    'flowchart LR\n' +
      '  A["<script>alert(1)</script>"] --> B["<iframe src=evil></iframe>"]\n' +
      '  B --> C["<img src=x onerror=alert(2)>"] --> D["onclick=foo 正文文本"]'
  );
  const tags = svg.match(TAG_RE);
  assert.equal(tags, null, `输出含可疑标签: ${tags?.join(',')}`);
  assert.equal(EVENT_ATTR_RE.test(svg), false, '输出含 on* 事件属性');
  // 事件词只允许作为转义后的正文文本出现
  assert.ok(svg.includes('onclick=foo'), '正文文本应保留（被剥标签/转义后）');
});

check('javascript: 链接：click 指令的 javascript URL 必须被丢弃', () => {
  const svg = svgOf(
    'flowchart LR\n' +
      '  A[正常] --> B[危险]\n' +
      '  click A "https://example.com" "提示"\n' +
      '  click B "javascript:alert(1)"'
  );
  assert.equal(/javascript:/i.test(svg), false, '输出含 javascript: URL');
  const anchors = [...svg.matchAll(/<a\b[^>]*href="([^"]*)"/gi)].map((m) => m[1]);
  assert.deepEqual(anchors, ['https://example.com/'], '只保留安全链接');
});

check('正常链接带 rel=noopener', () => {
  const svg = svgOf('flowchart LR\n  A[点我] --> B[去]\n  click A "https://example.com"');
  const anchor = svg.match(/<a\b[^>]*>/i)?.[0] ?? '';
  assert.match(anchor, /rel="noopener"/, '链接缺少 rel=noopener');
});

check('解析失败抛错而非产出半截 SVG（上层回退源码显示）', () => {
  assert.throws(() => svgOf('flowchart LR\n  A[未闭合 -->'), /pele|diagram|syntax|parse/i);
});

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
