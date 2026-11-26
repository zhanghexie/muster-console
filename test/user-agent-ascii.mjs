/**
 * 产品名必须能安全进 UA / 自定义协议 — 回归（2026-11-10「图片无法预览」根因 + 命名分工）。
 *
 * 事故链路：产品名曾是 `Muster Console · 集序`，Electron 用产品名拼默认 UA（去空格）→
 * `MusterConsole·集序/0.1.34 …`；Electron 43.x 的 protocol.handle 把请求头转 WebIDL
 * Headers 时，非 Latin-1 字符在 ByteString 转换处抛 TypeError，异常发生在 handler 之前，
 * 渲染层只看到 net::ERR_UNEXPECTED。四类自定义协议（muster-ws / muster-root /
 * muster-ext / muster-app）一起失效：图片、音视频、PDF、HTML 预览与扩展面板整片打不开，
 * 而文件明明存在、stat 也读得到大小。
 *
 * 守卫三条（任一条被改回去都应转红）：
 * 1) 身份名 `PRODUCT_NAME` 纯 ASCII、不含中英混排分隔符；中文名只做展示名；
 * 2) `asciiUserAgent()` 仍能兜住非 ASCII UA（未来改名的保险），且保留版本/内核段；
 * 3) `src/main/index.ts` 启动期确实把 app.userAgentFallback 换成清洗后的值。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'user-agent-ascii-'));
try {
  const compile = createSharedCompiler(root, fixture);
  const { asciiUserAgent, PRODUCT_EXECUTABLE_NAME, PRODUCT_NAME, PRODUCT_NAME_ZH } = await import(
    pathToFileURL(compile('shared/productIdentity.ts'))
  );

  const nonAscii = (value) => [...value].filter(ch => ch.charCodeAt(0) > 0x7e);

  // 1) 身份名进 UA/安装器/日志/CLI，必须纯 ASCII，不允许再造中英混排
  assert.deepEqual(nonAscii(PRODUCT_NAME), [], `身份名必须是纯 ASCII：${PRODUCT_NAME}`);
  assert.doesNotMatch(PRODUCT_NAME, /[·・]/, `身份名不允许中英混排分隔符：${PRODUCT_NAME}`);
  assert.ok(nonAscii(PRODUCT_NAME_ZH).length > 0, '中文名只做展示名（PRODUCT_NAME_ZH）');

  // 2) 兜底清洗：即使未来产品名再带中文，UA 也不能把非 ASCII 带出去
  const broken = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ${
    PRODUCT_NAME_ZH}/0.1.34 Chrome/150.0.7871.250 Electron/43.7.0 Safari/537.36`;
  assert.ok(nonAscii(broken).length > 0, 'fixture 必须真的含非 ASCII 才能复现');

  const fixed = asciiUserAgent(broken);
  assert.deepEqual(nonAscii(fixed), [], `UA 仍含非 ASCII：${fixed}`);
  assert.ok(fixed.includes(`${PRODUCT_EXECUTABLE_NAME}/0.1.34`), `产品段应回落成 ASCII 令牌：${fixed}`);
  for (const token of ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Chrome/150.0.7871.250', 'Electron/43.7.0', 'Safari/537.36']) {
    assert.ok(fixed.includes(token), `清洗不得丢内核/平台段：缺 ${token} → ${fixed}`);
  }

  // 产品名整段是中文：清完只剩 `/<版本>`，必须补 ASCII 令牌而不是留裸斜杠
  const cjkOnly = asciiUserAgent('Mozilla/5.0 (X11; Linux x86_64) 集序/0.1.34 Chrome/150.0.0.0 Safari/537.36');
  assert.deepEqual(nonAscii(cjkOnly), []);
  assert.ok(cjkOnly.includes(`${PRODUCT_EXECUTABLE_NAME}/0.1.34`), `应补 ASCII 产品段：${cjkOnly}`);
  assert.ok(!/\s\/\d/.test(cjkOnly), `不得出现裸斜杠产品段：${cjkOnly}`);

  // 已纯 ASCII 的 UA 原样通过（幂等，便于重复调用）
  const clean = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) MusterConsole/0.1.34 Chrome/150.0.0.0 Safari/537.36';
  assert.equal(asciiUserAgent(clean), clean);
  assert.equal(asciiUserAgent(asciiUserAgent(broken)), fixed);

  // 3) 启动链必须真的应用它：否则清洗函数再好也不生效
  const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.match(
    mainSource,
    /app\.userAgentFallback\s*=\s*asciiUserAgent\(app\.userAgentFallback\)/,
    'src/main/index.ts 必须在启动期把默认 UA 换成 asciiUserAgent(app.userAgentFallback)'
  );

  console.log('product name stays ASCII / user agent sanitized (custom protocol header regression) passed');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
