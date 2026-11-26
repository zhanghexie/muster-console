import React from 'react';
import { createRoot } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';
import '../../src/renderer/src/i18n';
import { FileDocPreview } from '../../src/renderer/src/components/FileDocPreview';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';

const bytes = zipSync({
  '[Content_Types].xml': strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  </Types>`),
  '_rels/.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  </Relationships>`),
  'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>合成文档 · Word preview</w:t></w:r></w:p>
    <w:p><w:r><w:t>排版预览 · A formatted paragraph.</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:left="720" w:right="720" w:top="720" w:bottom="720"/></w:sectPr>
  </w:body></w:document>`)
});
const fetch = window.fetch.bind(window);
window.fetch = (url, options) => typeof url === 'string' && url.startsWith('muster-ws:')
  ? Promise.resolve(new Response(new Uint8Array(bytes).buffer))
  : fetch(url, options);

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
createRoot(document.getElementById('root')!).render(
  <div className="file-editor-main" style={{ display: 'flex', height: '100vh', padding: 12 }}>
    <FileDocPreview workspaceId="fixture" path="report.docx" kind="word" />
  </div>
);
