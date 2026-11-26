import React from 'react';
import { createRoot } from 'react-dom/client';
import { utils, write } from 'xlsx';
import '../../src/renderer/src/i18n';
import { FileDocPreview } from '../../src/renderer/src/components/FileDocPreview';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';

const workbook = utils.book_new();
const sheet = utils.aoa_to_sheet([
  ['月份 Period', '员工人数 Headcount', '销售总额 Total revenue', '增长幅度 Change', '最右一列 Final column'],
  ['一月 January', 14, 125_000, 0.035, '完整的窄栏表格 · Narrow table'],
  ['二月 February', 19, 135_000, 0.125, '格式化数字 · Formatted totals'],
  ['三月 March', '合并的报告数据 · Merged cells', '', '', '最后一列 · Final column']
]);
sheet['!merges'] = [utils.decode_range('B4:D4')];
sheet.D2.z = sheet.D3.z = '0.0%';
utils.book_append_sheet(workbook, sheet, '季度概览 Quarterly overview');
utils.book_append_sheet(workbook, utils.aoa_to_sheet([['项目编号 Project number', 'A-210']]), '年度预算 Annual budget');
utils.book_append_sheet(workbook, utils.aoa_to_sheet([['员工总数 Total headcount', 42]]), '员工统计 Employee headcounts');
const details = utils.aoa_to_sheet([['本月汇总 Monthly total', 25_000]]);
details.B1.z = '#,##0';
utils.book_append_sheet(workbook, details, '其他明细 Extra details');
const bytes = write(workbook, { type: 'array', bookType: 'xlsx' });
const fetch = window.fetch.bind(window);
window.fetch = (url, options) => typeof url === 'string' && url.startsWith('muster-ws:')
  ? Promise.resolve(new Response(bytes))
  : fetch(url, options);

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
createRoot(document.getElementById('root')!).render(
  <div className="file-doc-fixture" style={{ background: 'var(--surface-canvas)', color: 'var(--canvas-fg-primary)', height: '100vh', padding: 12 }}>
    <div className="file-editor-main" style={{ display: 'flex', height: 240 }}>
      <FileDocPreview workspaceId="fixture" path="report.xlsx" kind="sheet" />
    </div>
    <MarkdownBody className="chat-text" text={[
      '### 交付状态 · Delivery status',
      '',
      '| 项目 | QuarterOne | QuarterTwo | QuarterThree | QuarterFour | YearToDate | 完成时间 | 复核人 | 最后一列 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 工作台 | 1 | 2 | 3 | 4 | 已出 | 12 月 | 主管 | 末列内容 |'
    ].join('\n')} />
  </div>
);
