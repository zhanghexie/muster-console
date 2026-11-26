// node shot.mjs <port> [out.png] [targetId]; screenshots may contain private content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectCdp } from './cdp-client.mjs';
let cdp;
try {
  cdp = await connectCdp(process.argv[2] || '9333', process.argv[4]);
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  const outputPath = process.argv[3] || path.join(os.tmpdir(), 'metaagent-perf', 'shot.png');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
  console.log(outputPath);
} catch (error) { console.error(`[shot] FAILED: ${error.message}`); process.exitCode = 1; }
finally { cdp?.close(); }
