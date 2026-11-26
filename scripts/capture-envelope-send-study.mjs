import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const out = '.tmp/envelope-study';
await fs.mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:true,channel:'chrome'});
try {
  const page = await browser.newPage({viewport:{width:736,height:700}});
  const errors = [];
  page.on('pageerror',error => errors.push(String(error)));
  const html = await fs.readFile('docs/prototypes/envelope-send/envelope-send.html','utf8');
  await page.setContent(`<html><head><meta charset="utf-8"></head><body style="margin:0">${html}</body></html>`);
  const duration = Number(await page.locator('#envelope-send-study').getAttribute('data-duration'));
  const fold = await page.locator('#envelope-send-study').evaluate(element => parseFloat(element.style.getPropertyValue('--es-top-duration')));
  // Preserve the same poses and equal-time flight samples when only the leading fold length changes.
  const actualTime = time => time <= 280 ? time * fold / 280 : time + fold - 280;
  await page.screenshot({path:`${out}/revised-ready.png`});
  await page.getByRole('button',{name:'寄出这页'}).click();
  await page.waitForFunction(() => document.querySelector('#envelope-send-study').dataset.phase === 'sent');
  await page.waitForFunction(() => !document.querySelector('.es-presence'));
  await page.screenshot({path:`${out}/revised-sent.png`});
  await page.getByRole('button',{name:'再寄一次'}).click();
  await page.getByRole('button',{name:'暂停'}).click();
  const still = await page.locator('.es-top').evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.ready));
    return getComputedStyle(element).transform;
  });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.es-top').evaluate(element => getComputedStyle(element).transform), still, 'pause freezes native CSS interpolation');

  const seek = async time => {
    // Set the actual preview slider. Native prototype setter allows React to see the input event.
    await page.getByRole('slider',{name:'动画进度'}).evaluate((element,value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,String(value));
      element.dispatchEvent(new Event('input',{bubbles:true}));
    },Math.round(actualTime(time) / duration * 1000));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const sample = async time => {
    await seek(time);
    return page.evaluate(() => {
      const matrix = selector => {
        const value = new DOMMatrixReadOnly(getComputedStyle(document.querySelector(selector)).transform);
        return {x:value.m41,y:value.m42,a:value.m11,b:value.m12,c:value.m21,d:value.m22,tilt:value.m23};
      };
      const box = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
      };
      return {flight:matrix('.es-flight'),insert:matrix('.es-insert'),lid:matrix('.es-lid-pivot'),top:matrix('.es-top'),bottom:matrix('.es-bottom'),pocket:box('.es-envelope-pocket'),paper:box('.es-paper'),pocketSurface:matrix('.es-pocket-surface'),insertDistance:parseFloat(getComputedStyle(document.querySelector('#envelope-send-study')).getPropertyValue('--es-third')) * 1.08};
    });
  };
  const frames = [];
  for (const time of [0,80,150,160,240,280,320,400,480,540,560,600,660,720,800]) {
    const state = await sample(time);
    frames.push({time,actualTime:actualTime(time),...state});
    await page.screenshot({path:`${out}/revised-${time}.png`});
    assert.equal(state.flight.x,0,'flight must be straight up');
    assert.equal(state.flight.a,1,'flight has no shrinking or spinning');
    assert.equal(state.flight.b,0);
  }
  const folded = frames.filter(frame => frame.time <= 280);
  for (const frame of folded) {
    assert(Math.abs(frame.top.d - frame.bottom.d) < .002, 'top and bottom thirds must fold at the same angle and time');
    assert(Math.abs(frame.top.tilt + frame.bottom.tilt) < .002, 'top and bottom folds must rotate in opposite directions');
    assert.deepEqual(frame.pocket,folded[0].pocket,'the envelope pocket must stay fixed throughout folding');
    assert.equal(frame.pocketSurface.y,0,'the envelope front cannot rise to simulate reveal');
  }
  for (const frame of frames) {
    assert(Math.abs(frame.pocket.y - frame.flight.y - folded[0].pocket.y) < .01,'the pocket must follow only the shared flight, without its own motion');
    // DOMRect subtraction during subpixel translation can differ by ~0.00002px.
    assert(Math.abs(frame.pocket.width - folded[0].pocket.width) < .01,'pocket width cannot change while paper folds or enters');
    assert(Math.abs(frame.pocket.height - folded[0].pocket.height) < .01,'pocket height cannot change while paper folds or enters');
  }
  const atMouth = frames.find(frame => frame.time === 280);
  assert(atMouth.paper.y + atMouth.paper.height < atMouth.pocket.y,'the folded paper must clear the mouth before changing depth');
  const inserted = frames.find(frame => frame.time === 660);
  assert(inserted.paper.y >= inserted.pocket.y && inserted.paper.y + inserted.paper.height <= inserted.pocket.y + inserted.pocket.height,'fully inserted paper must fit inside the stationary body');
  const rise = [480,540,600,660].map(time => -frames.find(frame => frame.time === time).flight.y);
  assert(rise.every((value,index) => !index || value > rise[index - 1]),'ascent cannot stop or reverse');
  assert(rise[3] - rise[2] > rise[2] - rise[1] && rise[2] - rise[1] > rise[1] - rise[0], 'equal-time upward displacement must accelerate while the envelope is visible');
  const during = frames.find(frame => frame.time === 560);
  assert(during.flight.y < 0 && during.insert.y > 0 && during.insert.y < during.insertDistance,'paper is still entering during ascent');
  assert(during.lid.d > -1 && during.lid.d < 1,'lid rotates during ascent and insertion');
  await seek(560);
  const occluded = await page.locator('.es-envelope-pocket').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return !!document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height * .85)?.closest('.es-envelope-pocket');
  });
  assert(occluded,'pocket front must occlude the inserted sheet');
  const backward = await sample(160);
  assert(backward.top.d > -.99,'backward scrubbing restores folded sheet geometry');
  await fs.writeFile(`${out}/revised-motion.json`,JSON.stringify({rise,frames},null,2));

  await page.getByRole('button',{name:'还原'}).click();
  await page.getByRole('button',{name:'切换明暗主题'}).click();
  await page.setViewportSize({width:390,height:730});
  await page.screenshot({path:`${out}/revised-dark-narrow.png`});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
  await seek(150);
  await page.screenshot({path:`${out}/revised-dark-fold.png`});
  await seek(400);
  await page.screenshot({path:`${out}/revised-dark-open.png`});
  await seek(560);
  await page.screenshot({path:`${out}/revised-dark-insert.png`});
  await seek(660);
  await page.screenshot({path:`${out}/revised-dark-sealed.png`});
  await page.getByRole('button',{name:'继续'}).click();
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(() => document.querySelector('#envelope-send-study').dataset.phase === 'sent');
  await page.waitForFunction(() => !document.querySelector('.es-presence'));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({errors,normalPlayback:'complete',pause:'frozen interpolation',simultaneousFolds:'equal angle and time',foldDuration:fold,pocket:'fixed geometry throughout folding',paper:'clears mouth and fits inside body',rise,overlap:'insertion + lid + upward motion',occlusion:'pocket covers paper',narrow:'no overflow',reduced:'immediate completion'}));
} finally { await browser.close(); }
