// Compare production controls with the existing shared skin, not copied CSS values.
export async function checkInputs(page, scope, assert, {settings=false}={}) {
  await page.waitForFunction(()=>!document.querySelector('.is-shown .acc[data-mp-stage=out]'));
  const inputs=scope.locator('input:not([type=checkbox]),textarea');
  for(const input of await inputs.all()) {
    if(!await input.isVisible()||!await input.isEnabled())continue;
    await input.focus();
    const result=await input.evaluate((el,settings)=>{
      const reference=document.createElement(el.tagName.toLowerCase());
      reference.className=settings?'s-input':'ui-input';
      const host=settings?document.querySelector('.s-rows'):document.querySelector('main');
      host.append(reference);
      const properties=['paddingLeft','paddingRight','paddingTop','paddingBottom','borderRadius','fontSize','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','boxShadow','outlineStyle'];
      const actual=getComputedStyle(el),expected=getComputedStyle(reference);
      const differences=properties.filter(key=>actual[key]!==expected[key]).map(key=>`${key}: ${actual[key]} != ${expected[key]}`);
      const background=actual.backgroundColor;
      reference.focus();
      const focus=getComputedStyle(reference).borderColor;
      reference.remove();el.focus();
      const focused=getComputedStyle(el);
      const r=el.getBoundingClientRect();
      let contained=true;
      for(let p=el.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(['hidden','auto','scroll','clip'].includes(s.overflowX))contained&&=r.left>=b.left-1&&r.right<=b.right+1;}
      return {differences,focus,actualFocus:focused.borderColor,background,focusedBackground:focused.backgroundColor,contained};
    },settings);
    assert.deepEqual(result.differences,[],'control must inherit the shared input skin');
    assert.equal(result.actualFocus,result.focus,'focus uses the shared surface-matched border');
    assert.equal(result.background,result.focusedBackground,'focus must not recolor the surface');
    assert.ok(result.contained,'input borders must remain inside horizontal clips');
  }
}

export async function checkMenus(page,scope,assert,capture,prefix){
  assert.equal(await scope.locator('select:not(.c-select-native)').count(),0);
  let i=0;
  for(const trigger of await scope.locator('.c-select-trigger').all()){
    if(!await trigger.isVisible()||!await trigger.isEnabled())continue;
    await trigger.click();
    const menu=page.locator('select:open');
    await menu.waitFor();
    assert.ok(await menu.locator('option').count()>0);
    const viewport=page.viewportSize();
    const bounds=await page.evaluate(()=>{const r=document.activeElement.getBoundingClientRect();return {x:r.x,width:r.width};});
    assert.ok(bounds.x>=0&&bounds.x+bounds.width<=viewport.width+1,'focused option must fit within the viewport');
    const button=await trigger.boundingBox();
    assert.ok(button.x>=0&&button.x+button.width<=viewport.width+1,'dropdown trigger must fit within the viewport');
    await page.keyboard.press('ArrowDown');
    await capture(`${prefix}-menu-${++i}`);
    await page.keyboard.press('Escape');
    await menu.waitFor({state:'hidden'});
  }
}
