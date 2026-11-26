export default async function ({ page, capture, assert }) {
 await page.waitForTimeout(160);
 await page.evaluate(() => { window.firstOrbit = document.querySelector('.brand-loader-orbit'); window.firstAnimation = window.firstOrbit.getAnimations()[0]; window.firstTime = window.firstAnimation.currentTime; });
 await capture('html', {animations:'allow'});
 await page.evaluate(() => window.mountBoot());
 await page.waitForTimeout(180);
 const state = await page.evaluate(() => ({ sameNode: window.firstOrbit === document.querySelector('.brand-loader-orbit'), sameAnimation: window.firstAnimation === window.firstOrbit.getAnimations()[0], delta: window.firstAnimation.currentTime - window.firstTime, count: document.querySelectorAll('.boot-skel').length }));
 assert.equal(state.sameNode,true); assert.equal(state.sameAnimation,true); assert.equal(state.count,1); assert.ok(state.delta>100);
 await capture('react-waiting', {animations:'allow'});
 await page.evaluate(() => window.finishBootFixture());
 await page.getByText('主界面已就绪').waitFor();
 assert.equal(await page.locator('.boot-skel').count(),0);
}
