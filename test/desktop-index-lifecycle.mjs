import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
assert.match(source, /process\.platform === 'darwin' \? createMacDesktopHost\(desktopOptions\)/);
assert.match(source, /process\.platform === 'linux' \? createLinuxDesktopHost\(desktopOptions\)/);
assert.match(source, /desktopWindowList: desktopHost\.desktopWindowList/);
assert.match(source, /await recoverDesktopInitializationFailure\(\s*desktopHost,\s*desktopResumeState,/);
assert.match(source, /await desktopHost!\.close\(\);\s*desktopHost = undefined;\s*if \(desktopResumeState\) \{\s*desktopResumeState\.cleanRun\(\)/);
console.log('desktop index lifecycle: Windows, macOS and Linux hosts share window discovery, ordered shutdown and dirty-run recovery');
