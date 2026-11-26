// Build a file:// friendly prototype, sharing the application's font and motion system.
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compact = process.argv.includes('--compact-actions');
const name = compact ? 'composer-send-actions-study' : 'composer-queue-study';
const bundle = buildSync({
  absWorkingDir: root,
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ComposerQueueStudy} from './docs/prototypes/composer-queue-study/composer-queue-study'; createRoot(document.getElementById('root')).render(<ComposerQueueStudy compactStudy={${compact}}/>);`,
    resolveDir: root, loader: 'tsx'
  },
  bundle: true, write: false, minify: true, format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'inline'
}).outputFiles[0].text;
const css = ['src/renderer/src/styles/base.css', 'docs/prototypes/composer-queue-study/composer-queue-study.css']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const output = path.join(root, `docs/prototypes/${name}/${name}.html`);
fs.writeFileSync(output, `<!doctype html>\n<!-- Generated from composer-queue-study.tsx/.css. Rebuild: node scripts/build-composer-queue-study.mjs${compact ? ' --compact-actions' : ''} -->\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MetaAgent · ${compact ? '发送旁的小按钮' : '输入与待发送'}</title><style>${css.replaceAll('</style', '<\\/style')}</style></head><body><div id="root"></div><script>${bundle.replaceAll('</script', '<\\/script')}</script></body></html>\n`);
console.log(path.relative(root, output));
