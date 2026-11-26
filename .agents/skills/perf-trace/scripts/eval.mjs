// node eval.mjs <port> '<expression>' [targetId]; failures are nonzero.
import { connectCdp } from './cdp-client.mjs';
let cdp;
try {
  cdp = await connectCdp(process.argv[2] || '9333', process.argv[4]);
  await cdp.call('Runtime.enable');
  console.log(JSON.stringify(await cdp.evaluate(process.argv[3] || '1+1')));
} catch (error) { console.error(`[eval] FAILED: ${error.message}`); process.exitCode = 1; }
finally { cdp?.close(); }
