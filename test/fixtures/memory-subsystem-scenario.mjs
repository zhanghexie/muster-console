export default async function({page,capture,assert}){
  const state=()=>page.evaluate(()=>window.__memorySubsystem.telemetry);
  const waitMotion=async()=>{
    const time=await page.evaluate(()=>parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-panel'))||280);
    await page.waitForTimeout(time+90);
  };
  await page.locator('.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-notify-chat').first().click();
  const panel=page.locator('.agent-float-panel'), header=panel.locator('.agent-header');
  const open=panel.getByRole('button',{name:'打开记忆子系统',exact:true});
  await open.waitFor();await waitMotion();
  assert.equal(await header.getByText('调度 Agent',{exact:true}).count(),0,'the scheduler header does not show a role subtitle');
  const divider=await header.evaluate(el=>{
    const style=getComputedStyle(el);
    return {width:style.borderBottomWidth,style:style.borderBottomStyle,color:style.borderBottomColor};
  });
  assert.equal(divider.width,'1px');assert.equal(divider.style,'solid');assert.notEqual(divider.color,'rgba(0, 0, 0, 0)');
  assert.equal((await state()).reads,0,'dispatch opens without reading or starting memory');
  const dispatch=panel.locator('[data-agent-purpose="dispatch"]');
  const dispatchEditor=dispatch.getByRole('textbox');
  await dispatchEditor.fill('调度草稿独立保留');
  await capture('dispatch-composer');
  await open.click();
  const sheet=panel.locator('.agent-memory-sheet'),host=panel.locator('.agent-memory-sheet-host');
  await sheet.waitFor();await waitMotion();
  const sheetHeader=sheet.locator('.agent-memory-sheet-header');
  const title=sheetHeader.getByRole('heading',{name:'记忆子系统',exact:true});
  const reset=sheetHeader.getByRole('button',{name:'重置记忆会话',exact:true});
  const close=sheetHeader.getByRole('button',{name:'关闭记忆子系统',exact:true});
  const [hb,tb,rb,cb]=await Promise.all([sheetHeader.boundingBox(),title.boundingBox(),reset.boundingBox(),close.boundingBox()]);
  assert.ok(Math.abs(tb.x+tb.width/2-hb.x-hb.width/2)<=1,'the subsystem title must be centered in the header');
  assert.ok(rb.x+rb.width<tb.x&&cb.x>tb.x+tb.width,'reset stays on the left, collapse on the right');
  assert.equal(await close.locator('svg').count(),0,'collapse is text only');
  assert.equal(await sheet.locator('.memory-curator-status').count(),0,'no top status toolbar');
  assert.equal(await sheet.getByRole('button',{name:'暂停整理',exact:true}).count(),0);
  const geometry=async()=>{
    const h=await header.boundingBox(),s=await sheet.boundingBox(),p=await panel.boundingBox();
    assert.ok(h&&s&&p);assert.ok(s.y>=h.y+h.height-1,'sheet never covers the dispatcher header');
    assert.ok(Math.abs(s.y-h.y-h.height)<=1,'the memory panel fills the dispatcher body, exposing only its header');
    assert.ok(s.y+s.height<=p.y+p.height+1,'sheet remains inside its host panel');
    const viewport=page.viewportSize();
    for(const box of [h,s,p])assert.ok(box.x>=-1&&box.x+box.width<=viewport.width+1,'the complete panel and its header must remain in the viewport');
    const overflow=await sheet.evaluate(el=>el.scrollWidth>el.clientWidth+1);assert.equal(overflow,false);
  };
  await geometry();
  const palette=await sheet.evaluate(el=>{
    const panel=el.closest('.agent-float-panel');
    const tokens=['--fg-primary','--fg-secondary','--fg-muted','--fg-selected-primary','--fg-selected-secondary',
      '--interaction-hover','--interaction-selected','--border-focus'];
    const surface=node=>{
      const style=getComputedStyle(node);
      return {background:style.backgroundColor,tokens:Object.fromEntries(tokens.map(token=>[token,style.getPropertyValue(token).trim()]))};
    };
    const input=node=>{
      const style=getComputedStyle(node.querySelector('.chat-input-shell'));
      return {background:style.backgroundColor,color:style.color,border:style.borderTopColor};
    };
    return {dispatch:surface(panel),memory:surface(el),dispatchInput:input(panel.querySelector('[data-agent-purpose="dispatch"]')),memoryInput:input(el)};
  });
  assert.deepEqual(palette.memory,palette.dispatch,'the memory subsystem must inherit the dispatcher surface and foreground/interaction palette');
  assert.deepEqual(palette.memoryInput,palette.dispatchInput,'memory and dispatch input shells must have the same palette');
  const dockColors=await sheet.evaluate(el=>({
    sheet:getComputedStyle(el).backgroundColor,
    dock:getComputedStyle(el.querySelector('.agent-chat-composer-wrap')).backgroundColor,
  }));
  assert.equal(dockColors.dock,dockColors.sheet,'the composer bottom padding must use the sheet background, without a dark strip');
  assert.equal((await state()).sent.length,0);assert.equal((await state()).reads,1);
  assert.equal(await panel.getByRole('navigation',{name:'选择 Agent'}).count(),0);
  const input=sheet.getByRole('textbox',{name:'询问或更正记忆'});
  assert.equal(await input.evaluate(el=>getComputedStyle(el).resize),'none','no native textarea resize grip');
  assert.equal(await sheet.locator('.send-btn-icon svg').count(),1,'same send control as dispatch');
  await capture('subsystem-open');
  await panel.getByRole('button',{name:'收起记忆子系统',exact:true}).click();
  await page.waitForTimeout(35);
  await capture('subsystem-exiting',{animations:'allow',caret:'initial'});
  await open.click();await waitMotion();await geometry();
  await input.fill('第一行');await input.press('Shift+Enter');await input.type('第二行');
  assert.equal(await input.inputValue(),'第一行\n第二行');
  await capture('subsystem-multiline');
  await input.press('Enter');await page.waitForFunction(()=>window.__memorySubsystem.telemetry.sent.length===1);
  await input.waitFor();assert.equal(await input.inputValue(),'');
  assert.equal((await state()).sent[0],'第一行\n第二行');
  await page.evaluate(()=>window.__memorySubsystem.accept(false));
  await input.fill('发送失败后仍保留的记忆草稿');
  await sheet.getByRole('button',{name:'发送',exact:true}).click();
  await sheet.getByRole('alert').filter({hasText:'消息未发送'}).waitFor();
  assert.equal(await input.inputValue(),'发送失败后仍保留的记忆草稿');
  await capture('subsystem-send-failed');
  await input.press('Escape');await waitMotion();
  assert.equal(await host.evaluate(el=>el.hidden),true);
  assert.equal(await open.evaluate(el=>el===document.activeElement),true,'Escape restores the brain trigger focus');
  assert.equal(await dispatchEditor.textContent(),'调度草稿独立保留');
  await open.click();await waitMotion();assert.equal(await input.inputValue(),'发送失败后仍保留的记忆草稿');
  const closedBefore=(await state()).cleared;
  const headerBox=await header.boundingBox();await page.mouse.click(headerBox.x+12,headerBox.y+12);await waitMotion();
  assert.equal(await host.evaluate(el=>el.hidden),true);assert.equal((await state()).cleared,closedBefore,'header close never resets dispatch');
  await open.click();await waitMotion();await geometry();
  // Retain real transitions for reversal: close, reopen while exit is still running.
  await panel.getByRole('button',{name:'收起记忆子系统',exact:true}).click();
  await page.waitForTimeout(35);await open.click();await waitMotion();await geometry();
  assert.equal(await input.inputValue(),'发送失败后仍保留的记忆草稿');
  await capture('subsystem-reopened');
  assert.equal((await state()).sent.length,2);assert.equal((await state()).reads,2,'one initial read and one refresh after the accepted send; opening again remains read-only');
  assert.deepEqual(await page.evaluate(()=>window.__uiFixture.unmocked),[]);
}
