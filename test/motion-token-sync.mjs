/**
 * 动效 token 同步守卫：base.css :root 的 --dur-* 与 motion.tsx MOTION 逐项相等
 * （presence 卸载兜底、过场编排等 JS 计时都读 MOTION，两侧漂移会让退场被截断或空等）；
 * 渲染层不得再出现散落的具名时长常量（WS_SLIDE_MS / WS_FADE_MS / WS_STACK_ANIM_STEP_MS）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const css = read('src/renderer/src/styles/base.css');
const motion = read('src/renderer/src/components/motion.tsx');

const rootBlock = css.match(/:root\s*\{([\s\S]*?--dur-[\s\S]*?)\n\}/);
assert.ok(rootBlock, 'base.css 找不到含 --dur-* 的 :root 块');
const cssDur = {};
for (const m of rootBlock[1].matchAll(/--dur-([a-z]+):\s*(\d+)ms/g)) cssDur[m[1]] = Number(m[2]);
assert.ok(Object.keys(cssDur).length >= 5, `--dur-* 解析过少：${JSON.stringify(cssDur)}`);

const motionBlock = motion.match(/export const MOTION = \{([\s\S]*?)\} as const/);
assert.ok(motionBlock, 'motion.tsx 找不到 MOTION 常量');
const jsDur = {};
for (const m of motionBlock[1].matchAll(/([a-z]+)Ms:\s*(\d+)/g)) jsDur[m[1]] = Number(m[2]);

assert.deepEqual(
  Object.keys(jsDur).sort(),
  Object.keys(cssDur).sort(),
  'MOTION 键须与 --dur-* 一一对应（新增 token 两侧同步登记）'
);
for (const [k, v] of Object.entries(cssDur)) {
  assert.equal(jsDur[k], v, `--dur-${k}=${v}ms 与 MOTION.${k}Ms=${jsDur[k]} 不一致`);
}

for (const rel of ['src/renderer/src/App.tsx', 'src/renderer/src/panels/AgentFloat.tsx']) {
  const src = read(rel);
  for (const name of ['WS_SLIDE_MS', 'WS_FADE_MS', 'WS_STACK_ANIM_STEP_MS']) {
    assert.ok(!src.includes(name), `${rel} 不应再有具名时长常量 ${name}（改读 MOTION）`);
  }
}

console.log('motion-token-sync ok');
