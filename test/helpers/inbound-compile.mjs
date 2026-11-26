import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createSharedCompiler } from './shared-compile.mjs';
const require = createRequire(import.meta.url);
export function createInboundCompiler(root, temporary) {
  const compile = createSharedCompiler(root, temporary);
  const yaml = path.join(temporary, 'node_modules/yaml'); fs.mkdirSync(yaml, { recursive: true });
  fs.writeFileSync(path.join(yaml, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  fs.writeFileSync(path.join(yaml, 'index.cjs'), `const real = require(${JSON.stringify(require.resolve('yaml'))}); exports.parseDocument = real.parseDocument;\n`);
  const shim = path.join(temporary, 'node_modules/smol-toml'); fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  const real = JSON.stringify(require.resolve('smol-toml'));
  fs.writeFileSync(path.join(shim, 'index.cjs'), `const real = require(${real}); exports.parse = real.parse; exports.stringify = real.stringify;\n`);
  const jsonc = path.join(temporary, 'node_modules/jsonc-parser'); fs.mkdirSync(jsonc, { recursive: true });
  fs.writeFileSync(path.join(jsonc, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  fs.writeFileSync(path.join(jsonc, 'index.cjs'), `const real = require(${JSON.stringify(require.resolve('jsonc-parser'))}); exports.parse = real.parse; exports.modify = real.modify; exports.applyEdits = real.applyEdits;\n`);
  return compile;
}
