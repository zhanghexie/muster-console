import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
const require = createRequire(import.meta.url);
const d3 = fs.readFileSync(path.resolve(path.dirname(require.resolve('d3')), '../dist/d3.min.js'), 'utf8');
const scripts = ['bridge', 'expressions', 'components', 'data-components'].map(name => fs.readFileSync(`src/main/uiRuntime/${name}.js`, 'utf8'));
const failures = [], console = new VirtualConsole();
console.on('jsdomError', error => failures.push(error.message));
const dom = new JSDOM(`<!doctype html><html><head><script>${d3}</script>${scripts.map(source => `<script>${source}</script>`).join('')}</head><body><div id="ma-ui-content">
<script type="application/json" id="projects">{"columns":[{"key":"name","label":"项目"},{"key":"cost","label":"费用","num":true}],"rows":[{"id":"a","name":"甲","status":"doing","cost":3},{"id":"b","name":"乙","status":"done","cost":7},{"id":"c","name":"丙","status":"doing","cost":0}]}</script>
<ma-select name="status" label="状态"><option value="all">全部</option><option value="doing">进行中</option></ma-select>
<ma-table id="projects-table" source="projects" filter="status" filter-key="status" selection="selected">
<template data-column="cost"><ma-text bind="row.cost"></ma-text></template></ma-table>
<ma-text id="detail" bind="selected.name"></ma-text>
<ma-chart id="cost-chart" source="projects" filter="status" filter-key="status" label-key="name" value-key="cost" unit="元"></ma-chart>
<ma-chart id="single" type="line"><script type="application/json">{"labels":["仅一项"],"series":[5]}</script></ma-chart>
<ma-chart id="zero"><script type="application/json">{"labels":["零"],"series":[0]}</script></ma-chart>
<ma-chart id="negative"><script type="application/json">{"labels":["负","正"],"series":[-2,3]}</script></ma-chart>
<ma-chart id="series"><script type="application/json">{"labels":["一","二"],"series":[{"name":"收入","values":[2,3]},{"name":"支出","values":[1,2]}]}</script></ma-chart>
</div></body></html>`, {
  url: 'https://fixture.invalid/data', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console,
  beforeParse(window) { window.TextEncoder = TextEncoder; window.ResizeObserver = class { observe() {} disconnect() {} }; }
});
try {
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  const document = dom.window.document, api = dom.window.maUi;
  assert.equal(document.querySelectorAll('ma-table tbody tr').length, 3);
  assert.equal(document.querySelector('ma-table tbody ma-text').textContent, '3', 'cell slots receive row data');
  await api.set('status', 'doing');
  assert.equal(document.querySelectorAll('ma-table tbody tr').length, 2);
  assert.equal(document.querySelectorAll('#cost-chart rect').length, 2, 'table and chart share the same filter');
  document.querySelector('.ma-row-select').click();
  assert.equal(document.getElementById('detail').textContent, '甲');
  assert.equal(api.getWidgetState().modelContent.selected.id, 'a');
  document.getElementById('projects-table-sort-1').focus();
  document.getElementById('projects-table-sort-1').click();
  assert.equal(document.querySelector('ma-table tbody tr').textContent, '丙0');
  assert.equal(document.querySelectorAll('ma-table th')[1].getAttribute('aria-sort'), 'ascending');
  assert.equal(document.activeElement.id, 'projects-table-sort-1');
  const stableRow = document.querySelector('ma-table tbody tr');
  await api.setUi('unrelated-presentation', true);
  assert.equal(document.querySelector('ma-table tbody tr'), stableRow, 'unrelated updates/echo acks must retain row actions and feedback');
  const saved = api.getWidgetState();
  await api.set('status', 'all');
  await api.setWidgetState(saved);
  assert.equal(document.querySelectorAll('ma-table tbody tr').length, 2);
  assert.equal(document.querySelector('ma-table tbody tr').textContent, '丙0');
  document.querySelector('#series .ma-series-toggle').click();
  assert.equal(document.querySelector('#series .ma-series-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelectorAll('#series rect').length, 2);
  assert.equal(document.querySelectorAll('#single circle').length, 1);
  assert.equal(document.querySelectorAll('#negative rect').length, 2);
  for (const node of document.querySelectorAll('svg [d],svg [cx],svg [cy],svg [height]')) {
    for (const attribute of ['d', 'cx', 'cy', 'height']) assert.ok(!/NaN|Infinity/.test(node.getAttribute(attribute) || ''), `${node.id}: finite ${attribute}`);
  }
  assert.equal(document.querySelector('#zero rect').getAttribute('height'), '0');
  assert.deepEqual(failures, []);
  process.stdout.write('ui-widget-data-components: shared filter/selection/detail/cell slot/sorting restore/series/single point/zero/negative checks passed\n');
} finally { dom.window.close(); }
