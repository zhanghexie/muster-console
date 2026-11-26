import { BrandLoading } from './BrandLoader';
import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CellObject, WorkSheet } from 'xlsx';
import {
  DOC_PREVIEW_CAP,
  buildExternalFileUrl,
  type PreviewKind
} from '../../../shared/filePreview';
import { buildWorkspaceMediaUrl } from '../../../shared/mediaKinds';
import { filePreviewUrl } from '../filePreviewUrl';
import { listZipEntries, type ZipEntry } from '../../../shared/archiveZip';
import { listGzipEntries, listTarEntries, type TarEntry } from '../../../shared/archiveTar';
import { pptxOutline, type PptxSlide } from '../../../shared/pptxOutline';

type DocKind = Extract<PreviewKind, 'word' | 'sheet' | 'slides' | 'archive'>;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 表格视图单表最大行数（超出截断并提示），防止超大 sheet 撑爆 DOM */
const SHEET_MAX_ROWS = 5000;
const sheetTabScroll = { block: 'nearest', inline: 'nearest', container: 'nearest' } as const;

interface SheetData {
  name: string;
  rows: SheetCell[][];
  truncated: boolean;
}

interface SheetCell {
  address: string;
  text: string;
  link?: string;
  rows?: number;
  columns?: number;
}

function workbookLink(target?: string): string | undefined {
  if (!target) return undefined;
  try {
    const url = new URL(target);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') return url.href;
  } catch {
    // Relative and internal workbook links have no destination in this preview.
  }
  return undefined;
}

function readSheet(XLSX: typeof import('xlsx'), worksheet: WorkSheet, name: string): SheetData {
  const { decode_range, encode_cell, format_cell } = XLSX.utils;
  const reference = worksheet['!ref'];
  if (!reference) return { name, rows: [], truncated: false };
  const { s: start, e: end } = decode_range(reference);
  const lastRow = Math.min(end.r, start.r + SHEET_MAX_ROWS - 1);
  const merges = worksheet['!merges'] ?? [];
  const rows: SheetCell[][] = [];
  for (let row = start.r; row <= lastRow; row++) {
    const cells: SheetCell[] = [];
    const rowMerges = merges.filter(({ s, e }) => row >= s.r && row <= e.r);
    for (let column = start.c; column <= end.c; column++) {
      const merge = rowMerges.find(({ s, e }) => column >= s.c && column <= e.c);
      if (merge && (row !== merge.s.r || column !== merge.s.c)) continue;
      const address = encode_cell({ r: row, c: column });
      const cell: CellObject | undefined = worksheet[address];
      cells.push({
        address,
        text: cell?.v == null ? '' : String(format_cell(cell)),
        link: workbookLink(cell?.l?.Target),
        rows: merge ? Math.min(lastRow, merge.e.r) - row + 1 : undefined,
        columns: merge ? Math.min(end.c, merge.e.c) - column + 1 : undefined
      });
    }
    rows.push(cells);
  }
  return { name, rows, truncated: lastRow < end.r };
}

/**
 * Office / 归档族预览：经 muster-ws:// 或 muster-ext:// 取字节，渲染层解析。
 * - word(docx)：docx-preview 版式渲染（懒加载）
 * - sheet(xlsx/xls/csv)：SheetJS 解析 → React 表格（懒加载，行数截断）
 * - slides(pptx)：自研大纲提取（zip → slideN.xml → <a:t> 文本段）
 * - archive(zip/tar/gz)：自研解析器列条目清单
 */
export function FileDocPreview({
  workspaceId,
  rootId,
  path,
  kind,
  external
}: {
  workspaceId: string;
  rootId?: string;
  path: string;
  kind: DocKind;
  external?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sheets, setSheets] = useState<SheetData[] | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [focusedSheet, setFocusedSheet] = useState<number>();
  const [slides, setSlides] = useState<PptxSlide[] | null>(null);
  const [entries, setEntries] = useState<(ZipEntry | TarEntry)[] | null>(null);
  const wordHostRef = useRef<HTMLDivElement>(null);
  const sheetId = useId();
  const fileName = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : '';
  const src = filePreviewUrl(external ? buildExternalFileUrl(path) : buildWorkspaceMediaUrl(workspaceId, path, rootId));

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let wordTarget: HTMLDivElement | undefined;
    setLoading(true);
    setError(null);
    setSheets(null);
    setSlides(null);
    setEntries(null);
    setActiveSheet(0);
    setFocusedSheet(undefined);

    void (async () => {
      try {
        const res = await fetch(src, { signal });
        if (signal.aborted) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cap = DOC_PREVIEW_CAP[kind];
        const lenHeader = Number(res.headers.get('content-length') ?? '0');
        if (lenHeader > cap) {
          throw new Error(t('文件过大（超过 {{cap}}），无法预览', { cap: formatBytes(cap) }));
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (signal.aborted) return;
        if (buf.byteLength > cap) {
          throw new Error(t('文件过大（超过 {{cap}}），无法预览', { cap: formatBytes(cap) }));
        }

        if (kind === 'word') {
          if (ext !== 'docx') throw new Error(t('仅支持 .docx（旧版 .doc 请先转换格式）'));
          const { renderAsync } = await import('docx-preview');
          if (signal.aborted || !wordHostRef.current) return;
          // The library can write to its target after parsing has started and the effect has closed.
          wordTarget = document.createElement('div');
          wordHostRef.current.appendChild(wordTarget);
          await renderAsync(buf.buffer, wordTarget, undefined, {
            inWrapper: true,
            ignoreLastRenderedPageBreak: true,
            useBase64URL: true,
            // The library otherwise creates an unsandboxed iframe for embedded HTML.
            renderAltChunks: false
          });
          if (signal.aborted) return;
          setLoading(false);
          return;
        }

        if (kind === 'sheet') {
          const XLSX = await import('xlsx');
          if (signal.aborted) return;
          // CSV 是文本：显式按 UTF-8 解码成字符串再解析（type:'array' 走码页猜测，
          // 中文在默认 1252 码页下乱码）；xlsx/xls 保持二进制读取
          const wb =
            ext === 'csv'
              ? XLSX.read(new TextDecoder('utf-8').decode(buf), { type: 'string', cellHTML: false })
              : XLSX.read(buf, { type: 'array', cellHTML: false });
          setSheets(wb.SheetNames.map(name => readSheet(XLSX, wb.Sheets[name], name)));
          setLoading(false);
          return;
        }

        if (kind === 'slides') {
          if (ext !== 'pptx') throw new Error(t('仅支持 .pptx（旧版 .ppt 请先转换格式）'));
          // 渲染层懒加载 fflate：注入 inflate，shared 解析器保持零依赖
          const { inflateSync } = await import('fflate');
          if (signal.aborted) return;
          const list = pptxOutline(buf, inflateSync);
          setSlides(list);
          setLoading(false);
          return;
        }

        // archive：按扩展名分流 zip / tar / gz
        let list: (ZipEntry | TarEntry)[];
        if (ext === 'zip') {
          list = listZipEntries(buf);
        } else if (ext === 'tar') {
          list = listTarEntries(buf);
        } else if (ext === 'gz' || ext === 'tgz') {
          list = await listGzipEntries(buf, fileName);
        } else {
          throw new Error(t('暂不支持该压缩格式'));
        }
        if (signal.aborted) return;
        setEntries(list);
        setLoading(false);
      } catch (err) {
        if (signal.aborted) return;
        controller.abort(); // Stop the response body after an early HTTP or size rejection.
        setError(String((err as Error)?.message ?? err));
        setLoading(false);
      }
    })();

    return () => {
      controller.abort();
      wordTarget?.remove();
    };
  }, [src, kind, ext, fileName, t]);

  if (error) {
    return (
      <div className="file-media file-media-error">
        <p className="file-media-error-title">{t('无法预览')}</p>
        <p className="file-media-error-desc">{error}</p>
        <p className="file-media-error-meta">{fileName}</p>
      </div>
    );
  }

  return (
    <div className={`file-doc file-doc-${kind}`}>
      {kind === 'word' ? (
        <>
          {loading ? <p className="file-doc-note"><BrandLoading>{t('解析文档中…')}</BrandLoading></p> : null}
          <div className="file-doc-word" ref={wordHostRef} />
        </>
      ) : null}

      {kind === 'sheet' && sheets ? (
        <>
          {sheets.length > 1 ? (
            <div className="file-doc-sheet-tabs" role="tablist" aria-label={fileName}
              onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocusedSheet(undefined);
              }}>
              {sheets.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  role="tab"
                  id={`${sheetId}-tab-${i}`}
                  aria-controls={`${sheetId}-panel-${i}`}
                  aria-selected={i === activeSheet}
                  className="file-doc-sheet-tab"
                  tabIndex={i === (focusedSheet ?? activeSheet) ? 0 : -1}
                  onFocus={event => {
                    setFocusedSheet(i);
                    event.currentTarget.scrollIntoView(sheetTabScroll);
                  }}
                  onKeyDown={event => {
                    const count = sheets.length;
                    let next: number;
                    switch (event.key) {
                      case 'Home': next = 0; break;
                      case 'End': next = count - 1; break;
                      case 'ArrowLeft': next = (i + count - 1) % count; break;
                      case 'ArrowRight': next = (i + 1) % count; break;
                      default: return;
                    }
                    event.preventDefault();
                    const tab = event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined;
                    tab?.focus();
                  }}
                  onClick={event => {
                    setActiveSheet(i);
                    event.currentTarget.scrollIntoView(sheetTabScroll);
                  }}
                >
                  {s.name}
                </button>
              ))}
            </div>
          ) : null}
          {sheets[activeSheet]?.truncated ? (
            <p className="file-doc-note is-notice">
              {t('已截断：仅显示前 {{n}} 行', { n: SHEET_MAX_ROWS })}
            </p>
          ) : null}
          {sheets.map(({ name, rows }, i) => (
            <div key={name} id={`${sheetId}-panel-${i}`} className="file-doc-sheet"
              role={sheets.length > 1 ? 'tabpanel' : 'region'}
              aria-labelledby={sheets.length > 1 ? `${sheetId}-tab-${i}` : undefined}
              aria-label={sheets.length === 1 ? name : undefined}
              tabIndex={i === activeSheet ? 0 : undefined}
              hidden={i !== activeSheet}>
              {i === activeSheet ? (
                <table>
                  <tbody>
                    {rows.map((cells, row) => (
                      <tr key={row}>
                        {cells.map(cell => (
                          <td key={cell.address} rowSpan={cell.rows} colSpan={cell.columns}>
                            {cell.link ? <a href={cell.link} target="_blank" rel="noreferrer noopener">{cell.text}</a> : cell.text}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ))}
        </>
      ) : null}

      {kind === 'slides' && slides ? (
        slides.length === 0 ? (
          <p className="file-doc-note">{t('未在文档中找到幻灯片文本')}</p>
        ) : (
          <div className="file-doc-slides">
            <p className="file-doc-note">
              {t('大纲预览 · 共 {{n}} 张幻灯片', { n: slides.length })}
            </p>
            {slides.map((s) => (
              <div key={s.n} className="file-doc-slide">
                <span className="file-doc-slide-n">{s.n}</span>
                <div className="file-doc-slide-text">
                  {s.texts.length > 0 ? (
                    <>
                      <p className="file-doc-slide-title">{s.texts[0]}</p>
                      {s.texts.length > 1 ? (
                        <p className="file-doc-slide-body">{s.texts.slice(1).join('\n')}</p>
                      ) : null}
                    </>
                  ) : (
                    <p className="file-doc-slide-body">{t('（空白页）')}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      ) : null}

      {kind === 'archive' && entries ? (
        entries.length === 0 ? (
          <p className="file-doc-note">{t('空压缩包')}</p>
        ) : (
          <table className="file-doc-archive">
            <thead>
              <tr>
                <th scope="col">{t('条目')}</th>
                <th scope="col" className="num">{t('大小')}</th>
                <th scope="col">{t('修改时间')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.name}:${i}`} className={e.isDir ? 'is-dir' : undefined}>
                  <td className="name" title={e.name}>
                    {e.name}
                  </td>
                  <td className="num">{e.isDir ? '' : formatBytes(e.size)}</td>
                  <td>{e.lastModified}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}

      {loading && kind !== 'word' ? <p className="file-doc-note"><BrandLoading>{t('解析文件中…')}</BrandLoading></p> : null}
    </div>
  );
}
