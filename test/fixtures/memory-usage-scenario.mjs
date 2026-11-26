/** Production components with deterministic host data; no real IPC/model/Electron acceptance. */
export default async function ({ page, capture, assert, width }) {
  const read = () => page.evaluate(() => window.__memoryUsage.telemetry);
  const safeCapture = async label => {
    const geometry = await page.evaluate(() => {
      const viewport = innerWidth;
      const clipped = [...document.querySelectorAll('.knowledge-card, .memory-processing-summary, .knowledge-toolbar, .knowledge-header')]
        .filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.right > viewport + 1 || box.left < -1 || element.scrollWidth > element.clientWidth + 1); })
        .map(element => ({ className: element.className, text: element.textContent.slice(0, 100), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      return { overflow: document.documentElement.scrollWidth > viewport + 1, clipped };
    });
    assert.equal(geometry.overflow, false, `document overflow at ${width}px`);
    assert.deepEqual(geometry.clipped, [], `production content clipping at ${width}px`);
    await capture(label);
  };
  await page.waitForFunction(() => window.__memoryUsage?.telemetry.ready);
  const processing = page.getByRole('region', { name: '记忆整理记录', exact: true });
  await processing.getByText('正在整理记忆', { exact: true }).waitFor();
  await processing.locator('.memory-processing-list article').first().waitFor();
  assert.ok((await read()).activeListeners > 0);
  await safeCapture('processing-running');

  // Change only the fixture's host state; the real onChanged subscription reloads the component.
  await page.evaluate(() => window.__memoryUsage.showFailure());
  await processing.getByRole('button', { name: '失败', exact: true }).click();
  const failedCard = processing.locator('.memory-processing-list article').first();
  await failedCard.getByText(/示例提供商请求超时/).waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(element => element.textContent === '重试失败项');
    return button && !button.disabled;
  });
  await safeCapture('processing-failed-detail');
  await processing.getByRole('button', { name: '重试失败项', exact: true }).click();
  await page.waitForFunction(() => window.__memoryUsage.telemetry.retryCount === 1);
  await processing.getByText('正在整理记忆', { exact: true }).waitFor();
  await processing.getByRole('button', { name: '待处理', exact: true }).click();
  await processing.locator('.memory-processing-list').getByText('正在整理', { exact: true }).waitFor();
  await safeCapture('processing-retry-running');

  await page.evaluate(() => window.__memoryUsage.finishRetry());
  await processing.getByRole('button', { name: '已处理', exact: true }).click();
  await processing.locator('.memory-processing-list').getByText('已有相同知识', { exact: true }).waitFor();
  await processing.getByText('处理说明：重试后核对到已有相同知识，未新建重复条目。', { exact: true }).waitFor();
  assert.ok((await processing.textContent()).includes('处理说明：这是本次任务的事实，留入有保留期的历史，不自动晋升为经验。'));
  assert.ok((await processing.textContent()).includes('处理说明：缺少支持这一泛化结论的原始依据，本次不保留。'));
  await safeCapture('processing-completed-results');
  await processing.locator('.memory-processing-list article').last().scrollIntoViewIfNeeded();
  await safeCapture('processing-discard-reason');

  await processing.getByRole('button', { name: '待关注', exact: true }).click();
  await processing.getByText('没有待关注的整理事务。已处理和已归档的记录仍可从上方筛选查看。', { exact: true }).waitFor();
  await safeCapture('processing-attention-empty');
  await processing.getByRole('button', { name: '全部记录', exact: true }).click();
  await processing.getByText('处理说明：重试后核对到已有相同知识，未新建重复条目。', { exact: true }).waitFor();
  assert.equal(await processing.getByText('七天前已完成的整理记录，当前只在已归档中展示。', { exact: true }).count(), 0);
  await processing.getByRole('button', { name: '已处理', exact: true }).click();
  const savedRecord = processing.locator('.memory-processing-list article').filter({ hasText: '组件卸载需要释放事件订阅，并记录适用范围与例外。' });
  await savedRecord.getByRole('button', { name: '归档记录', exact: true }).click();
  await page.waitForFunction(() => window.__memoryUsage.telemetry.archiveChanges.length === 1);
  await savedRecord.waitFor({ state: 'detached' });
  await processing.evaluate(element => { element.scrollTop = 0; });
  await safeCapture('processing-record-archived');
  await processing.getByRole('button', { name: '已归档', exact: true }).click();
  await savedRecord.waitFor();
  await processing.getByText('七天前已完成的整理记录，当前只在已归档中展示。', { exact: true }).waitFor();
  assert.equal(await savedRecord.getByRole('button', { name: '归档记录', exact: true }).count(), 0);
  await processing.evaluate(element => { element.scrollTop = 0; });
  await safeCapture('processing-archived-records');
  await savedRecord.getByRole('button', { name: '移回记录', exact: true }).click();
  await page.waitForFunction(() => window.__memoryUsage.telemetry.archiveChanges.length === 2);
  await savedRecord.waitFor({ state: 'detached' });
  await processing.getByRole('button', { name: '已处理', exact: true }).click();
  await savedRecord.getByRole('button', { name: '归档记录', exact: true }).waitFor();
  await savedRecord.scrollIntoViewIfNeeded();
  await safeCapture('processing-record-restored');
  assert.equal((await read()).retryCount, 1);
  assert.ok((await read()).archiveChanges.every(item => item.knowledgeStatus === 'active' && item.processCount === 1));
  assert.equal((await read()).calls.filter(item => item.path === 'knowledge.decide').length, 0);

  await processing.getByRole('button', { name: '打开记忆子系统对话', exact: true }).click();
  await processing.getByRole('button', { name: '模型与检索设置', exact: true }).click();
  assert.equal((await read()).conversationOpens, 1);
  assert.equal((await read()).settingsOpens, 1);
  // This is the production result button and shared route, not a direct view-state setter.
  await processing.getByRole('button', { name: '查看对应记忆', exact: true }).first().click();
  const knowledge = page.getByRole('region', { name: '记忆中心', exact: true });
  const targetSummary = await page.evaluate(() => window.__memoryUsage.targetSummary);
  await knowledge.getByRole('heading', { name: targetSummary, exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '知识列表', exact: true }).getAttribute('aria-selected'), 'true');
  await page.waitForFunction(() => window.__memoryUsage.telemetry.activeListeners === 0);
  assert.ok((await read()).unsubscriptions > 0);
  await knowledge.getByRole('textbox', { name: '搜索记忆', exact: true }).fill('');
  await safeCapture('knowledge-before-delete');

  await knowledge.getByRole('button', { name: '删除', exact: true }).click();
  await page.waitForFunction(() => window.__memoryUsage.telemetry.deletedReceipts.length === 1);
  await knowledge.getByRole('heading', { name: targetSummary, exact: true }).waitFor({ state: 'detached' });
  await knowledge.getByRole('heading', { name: '目前没有匹配的知识', exact: true }).waitFor();
  const confirmed = (await read()).deletedReceipts[0];
  assert.equal(confirmed.status, 'rejected'); assert.equal(confirmed.revision, 3);
  assert.equal(confirmed.namespace, 'worker');
  await safeCapture('knowledge-deleted');

  // Re-send the old parent's sharedSnapshot through the public fixture host boundary.
  // The production component must keep its acknowledged deletion revision and cleared query.
  await page.evaluate(() => window.__memoryUsage.pushStaleKnowledgeSnapshot());
  await page.waitForFunction(() => window.__memoryUsage.telemetry.sharedTargetRevision === 2);
  assert.equal(await knowledge.getByRole('heading', { name: targetSummary, exact: true }).count(), 0);
  assert.equal(await knowledge.getByRole('textbox', { name: '搜索记忆', exact: true }).inputValue(), '');
  await safeCapture('knowledge-stale-snapshot-keeps-deleted');

  await knowledge.getByRole('button', { name: '任务历史', exact: true }).click();
  const historyType = knowledge.getByRole('combobox', { name: '历史类型', exact: true });
  await historyType.click();
  await page.getByRole('option', { name: '退场与删除记录', exact: true }).waitFor();
  await safeCapture('history-type-open');
  await page.getByRole('option', { name: '退场与删除记录', exact: true }).click();
  assert.equal(await historyType.evaluate(el => el.matches(':open')), false);
  await knowledge.getByRole('heading', { name: targetSummary, exact: true }).waitFor();
  await knowledge.getByText('已删除', { exact: true }).waitFor();
  assert.equal(await knowledge.getByRole('button', { name: '删除', exact: true }).count(), 0);
  assert.equal(await knowledge.getByRole('button', { name: '修订内容与条件', exact: true }).count(), 0);
  assert.equal(await knowledge.getByRole('button', { name: '按含义查找相关记忆', exact: true }).count(), 0);
  await safeCapture('history-deleted-read-only');
  const sources = knowledge.getByRole('button', { name: '查看依据与历史', exact: true });
  await sources.click();
  await knowledge.getByText(/修订历史：/).waitFor();
  await knowledge.locator('.knowledge-details').scrollIntoViewIfNeeded();
  await safeCapture('history-deleted-sources');
  await knowledge.getByRole('button', { name: '收起依据', exact: true }).click();
  await historyType.click();
  await page.getByRole('option', { name: '任务事实', exact: true }).click();
  await knowledge.getByRole('heading', { name: '本次隔离夹具完成了事件订阅卸载回归', exact: true }).waitFor();
  assert.equal(await knowledge.getByRole('heading', { name: targetSummary, exact: true }).count(), 0);
  assert.equal(await knowledge.getByRole('button', { name: '查询原始会话（含切换前历史）', exact: true }).getAttribute('aria-expanded'), 'false');
  await safeCapture('history-facts-separated');

  const final = await read();
  assert.equal(final.retryCount, 1); assert.equal(final.staleSnapshots, 1);
  assert.ok(final.navigations.some(item => item.tab === 'entries' && item.entryId === confirmed.id));
  assert.ok(final.inspected.some(item => item.input.state === 'failed'));
  assert.ok(final.inspected.some(item => item.input.state === 'queued'));
  assert.ok(final.inspected.some(item => item.input.state === 'done'));
  assert.ok(final.inspected.some(item => item.input.state === 'attention' && item.input.visibility === 'visible'));
  assert.ok(final.inspected.some(item => item.input.state === 'all' && item.input.visibility === 'archived'));
  assert.ok(final.inspected.every(item => item.workspaceId === 'memory-usage-fixture' && item.input.limit === 30));
  assert.equal(final.archiveChanges.length, 2);assert.deepEqual(final.archiveChanges.map(item => item.archived), [true, false]);
  assert.equal(final.calls.filter(item => item.path === 'knowledge.decide').length, 1);
  assert.equal(final.calls.filter(item => item.path === 'knowledge.historySources').length, 0);
  assert.deepEqual(await page.evaluate(() => window.__uiFixture.unmocked), []);
  // Teardown is part of this fixture's boundary: its own 30s poll and production subscription must release.
  await page.evaluate(() => window.__memoryUsage.dispose());
  await page.waitForFunction(() => !window.__memoryUsage.telemetry.snapshotPollActive && window.__memoryUsage.telemetry.activeListeners === 0);
}
