export interface WorkerModelMention {
  targetRef: string;
  label: string;
}

const targetRefPattern = String.raw`wr1\.[A-Za-z0-9_-]{32}`;
const encodedMentionPattern = String.raw`\[@model:(${targetRefPattern}):("(?:\\.|[^"\\\r\n])*")\]`;
const fileOrSkillPattern = String.raw`\[File: "(?:\\.|[^"\\])*"\]|Use skill "(?:\\.|[^"\\])*"; read "(?:\\.|[^"\\])*"\.`;

function referencesIn(text: string) {
  return text.matchAll(new RegExp(`${fileOrSkillPattern}|${encodedMentionPattern}`, 'g'));
}

export function composerProtectedReferenceRanges(text: string): Array<[number, number]> {
  return Array.from(referencesIn(text), match => [match.index, match.index + match[0].length]);
}

/** This string is a draft/queue representation. It can be restored without renderer state. */
export function encodeWorkerModelMention(mention: WorkerModelMention): string {
  return `[@model:${mention.targetRef}:${JSON.stringify(mention.label)}]`;
}

export function workerModelMentions(text: string): Array<{ start: number; end: number; mention: WorkerModelMention }> {
  const result: Array<{ start: number; end: number; mention: WorkerModelMention }> = [];
  if (!text.includes('[@model:wr1.')) return result;
  for (const match of referencesIn(text)) {
    if (!match[1]) continue;
    let label: string;
    try { label = JSON.parse(match[2]); } catch { continue; }
    result.push({ start: match.index, end: match.index + match[0].length, mention: { targetRef: match[1], label } });
  }
  return result;
}

export function hasWorkerModelMentions(text: string): boolean {
  return workerModelMentions(text).length > 0;
}

export function workerModelInvocation(targetRef: string): string {
  return `host.sessions.create({task, isolation, target: {targetRef: ${JSON.stringify(targetRef)}}})`;
}

function mapMentions(text: string, map: (mention: WorkerModelMention) => string): string {
  let result = '';
  let cursor = 0;
  for (const { start, end, mention } of workerModelMentions(text)) {
    result += text.slice(cursor, start) + map(mention);
    cursor = end;
  }
  return result + text.slice(cursor);
}

export function summarizeWorkerModelMentions(text: string): string {
  return mapMentions(text, mention => `@${mention.label}`);
}

/** Expand only after the caller has validated each reference against the current source. */
export function serializeWorkerModelMentions(text: string): string {
  return mapMentions(text, ({ label, targetRef }) =>
    `[Worker model ${JSON.stringify(label)}. To delegate to this exact configuration, use ${workerModelInvocation(targetRef)}.]`);
}
