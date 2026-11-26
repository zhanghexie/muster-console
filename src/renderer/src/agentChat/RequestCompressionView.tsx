import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { COMPRESSION_SOURCE_PAGE, compressionFields, type CompressionSource, type ModelRequestRow, type RequestCompression } from '../../../shared/modelRequest';
import { AnimatedDetails } from '../components/AnimatedDetails';

function SourcePage({ session, call, source }: { session: string; call: number; source: CompressionSource }) {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{ offset: number; text?: string; next?: number | null }>();
  useEffect(() => {
    let live = true;
    void window.api.agentSession.modelRequestSource(session, call, source.id, offset).then(page => {
      if (live) setResult({ offset, ...page });
    }, () => { if (live) setResult({ offset }); });
    return () => { live = false; };
  }, [session, call, source.id, offset]);
  if (!result || result.offset !== offset) return <p role="status">{t('加载中…')}</p>;
  if (result.text === undefined) return <p role="status">{t('该调用的来源原文已不可用')}</p>;
  return <><pre>{result.text}</pre>{(offset > 0 || result.next != null) && <footer>
    <button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - COMPRESSION_SOURCE_PAGE))}>{t('上一页')}</button>
    <span>{(offset + 1).toLocaleString()}–{(offset + result.text.length).toLocaleString()}</span>
    <button disabled={result.next == null} onClick={() => setOffset(result.next!)}>{t('下一页')}</button>
  </footer>}</>;
}

export function RequestCompressionView({ session, row, data }: { session: string; row: ModelRequestRow; data: unknown }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<RequestCompression[] | null>();
  const fields = useMemo(() => compressionFields(data), [data]);
  useEffect(() => {
    if (!row.compressionCount) return;
    let live = true;
    void window.api.agentSession.modelRequestCompression(session, row.id).then(value => {
      if (live) setItems(value.length ? value : null);
    }, () => { if (live) setItems(null); });
    return () => { live = false; };
  }, [session, row.id, row.compressionCount]);
  if (!row.compressionCount || !items) return <p role="status">{row.compressionCount === 0
    ? t('此次请求未检测到 Core 压缩内容') : row.compressionCount === undefined || items === null
    ? t('这条记录没有可核对的压缩来源') : t('加载中…')}</p>;
  return <>{items.map(item => {
    const sent = fields.get(item.path);
    const before = item.sources.reduce((total, source) => total + source.chars, 0);
    return <article key={item.path} className="request-compression-card">
      <header><strong>{{ excerpt: t('工具结果摘录'), summary: t('工具结果摘要'), checkpoint: t('阶段检查点'), native: t('会话摘要'), expanded: t('已展开检查点') }[item.kind]}</strong>
        <span>{item.tool ?? (item.level ? 'L' + item.level : '')}</span></header>
      <div className="request-compression-stats">{item.tool ? t('原文 {{n}} 字符', { n: before.toLocaleString() }) : t('来源 {{count}} 条', { count: item.sources.length })}
        {sent !== undefined && <> · {t('已发送 {{n}} 字符', { n: sent.length.toLocaleString() })}</>}</div>
      <section><h4>{t('本次发送')} <span>{item.path}</span></h4><pre>{sent ?? t('无法读取请求正文')}</pre></section>
      {item.sources.length > 0 && <section><h4>{t('压缩前的来源')}</h4>{item.sources.map(source => <AnimatedDetails key={source.id} className="request-original"
        summary={<><b>{source.id === item.previous ? t('上代检查点') : ({ toolResult: t('工具结果'), user: t('用户'), assistant: t('助手'), compaction: t('会话摘要') } as Record<string, string>)[source.role] ?? source.role}</b> <code>{source.id}</code> · {t('{{n}} 字符', { n: source.chars.toLocaleString() })}</>}>
        <SourcePage session={session} call={row.id} source={source}/>
      </AnimatedDetails>)}</section>}
    </article>;
  })}</>;
}
