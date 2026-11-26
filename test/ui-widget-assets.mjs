import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const output = execFileSync(process.execPath, ['scripts/gen-ui-assets.mjs', '--check'], { cwd: process.cwd(), timeout: 10000, windowsHide: true, encoding: 'utf8' });
assert.match(output, /current/);
console.log('ui-widget-assets: production runtime/offline library bundle is current');
