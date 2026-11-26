import { parentPort, workerData } from 'node:worker_threads';
import { extractText } from './service';
import { convertDocument } from './document';

try {
  if (workerData.document) {
    parentPort?.postMessage({ result: await convertDocument(workerData.document) });
  } else {
  const result = await extractText(Buffer.from(workerData.bytes), workerData.name, workerData.mime, workerData.limit);
  parentPort?.postMessage({ result: result ? { ...result, text: result.text.slice(0, workerData.limit + 1) } : undefined });
  }
} catch (error) { parentPort?.postMessage({ error: (error as Error).message }); }
