// Pure policy and metadata aggregation for allocation sampling. No object values.
export const HEAP_SAMPLING_PARAMETERS = Object.freeze({
  samplingInterval: 131072, stackDepth: 64,
  includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true
});

export function parseHeapArguments(argv) {
  if (argv.length !== 3 || argv.some(value => !value || value.startsWith('--'))
    || !/^\d+$/.test(argv[0]) || Number(argv[0]) < 1 || Number(argv[0]) > 65535) {
    throw new Error('Usage: node heap-capture.mjs <port> <scenario.json> <new-output-prefix>');
  }
  return { port: argv[0], scenarioPath: argv[1], prefix: argv[2] };
}

export function validateHeapProtocol(protocol) {
  const domain = protocol?.domains?.find(value => value.domain === 'HeapProfiler');
  const commands = domain?.commands;
  if (!Array.isArray(commands) || !['enable', 'startSampling', 'stopSampling', 'disable'].every(name => commands.some(command => command.name === name))) {
    throw new Error('HeapProfiler sampling commands are unavailable in this endpoint protocol');
  }
  const names = new Set(commands.find(command => command.name === 'startSampling').parameters?.map(value => value.name));
  if (!Object.keys(HEAP_SAMPLING_PARAMETERS).every(name => names.has(name))) {
    throw new Error('HeapProfiler protocol does not support all required allocation sampling parameters; do not silently reduce coverage');
  }
  return true;
}

function safeFunctionName(frame) {
  const name = typeof frame?.functionName === 'string' && frame.functionName ? frame.functionName : '(anonymous)';
  // Source URLs belong only in the private raw profile, never console summaries.
  return /[a-z][a-z\d+.-]*:|(?:^|[\s(])(?:[\\/]|\.{1,2}[\\/])/i.test(name)
    ? '[URL/path omitted]' : name.replace(/[\r\n\t]/g, ' ').slice(0, 160);
}

export function summarizeHeapProfile(profile, topLimit = 30) {
  if (!profile?.head || typeof profile.head !== 'object') throw new Error('Sampling profile must contain a head node');
  if (!Number.isInteger(topLimit) || topLimit < 1 || topLimit > 100) throw new Error('Heap top limit must be 1..100');
  let nodesVisited = 0, estimatedAllocatedBytes = 0;
  const allocations = [], pending = [{ node: profile.head, parents: [] }];
  while (pending.length) {
    const { node, parents } = pending.pop();
    if (!node || typeof node !== 'object' || !Number.isFinite(node.selfSize) || node.selfSize < 0
      || !Array.isArray(node.children)) throw new Error('Malformed allocation sampling tree');
    nodesVisited++; estimatedAllocatedBytes += node.selfSize;
    const functionName = safeFunctionName(node.callFrame);
    if (node.selfSize > 0) allocations.push({
      estimatedSelfBytes: node.selfSize, functionName,
      lineNumber: Number.isInteger(node.callFrame?.lineNumber) ? node.callFrame.lineNumber : null,
      columnNumber: Number.isInteger(node.callFrame?.columnNumber) ? node.callFrame.columnNumber : null,
      parents
    });
    for (const child of node.children) pending.push({ node: child, parents: [...parents, functionName].slice(-7) });
  }
  if (!Number.isFinite(estimatedAllocatedBytes)) throw new Error('Allocation estimate overflow');
  return {
    estimatedAllocatedBytes, nodesVisited, allocationNodeCount: allocations.length,
    sampleCount: Array.isArray(profile.samples) ? profile.samples.length : null,
    topSelf: allocations.sort((a, b) => b.estimatedSelfBytes - a.estimatedSelfBytes || a.functionName.localeCompare(b.functionName)).slice(0, topLimit),
    interpretation: 'Sampling estimate of cumulative allocations, including objects collected by major/minor GC. Not retained heap, live bytes, or evidence of a leak. Tree self sizes are summed once; samples are not added again.'
  };
}
