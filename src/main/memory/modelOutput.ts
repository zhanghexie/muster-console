/** Responses reasoning items are not the assistant's final structured result. */
export function parseMemoryResponsesOutput(data:unknown):string {
  if(!data||typeof data!=='object') throw new Error('记忆模型返回无效响应');
  const d=data as {status?:unknown;output_text?:unknown;output?:unknown};
  if(d.status!=null&&d.status!=='completed') throw new Error(`记忆模型响应未完成：${String(d.status)}`);
  if(typeof d.output_text==='string') return d.output_text;
  if(!Array.isArray(d.output)) return '';
  return d.output.filter(item=>item?.type==='message'&&item.role==='assistant')
    .flatMap(item=>Array.isArray(item.content)?item.content:[])
    .filter(part=>part?.type==='output_text'&&typeof part.text==='string')
    .map(part=>part.text).join('');
}
