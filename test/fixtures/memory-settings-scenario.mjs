import {checkInputs,checkMenus} from './memory-control-checks.mjs';
export default async function({page,capture,assert}){
 await page.getByRole('button',{name:'记忆子系统 LLM'}).click();
 await capture('llm-picker');
 await page.getByRole('option',{name:'已配置供应商 · 知识审查模型'}).click();
 await page.getByRole('button',{name:'保存记忆子系统模型'}).click();
 await page.getByText('已保存记忆处理配置').waitFor();
 assert.equal(await page.locator('select:not(.c-select-native)').count(),0);
 await capture('saved');
 const pane=page.getByTestId('memory-settings');
 await checkInputs(page,pane,assert,{settings:true});
 await checkMenus(page,pane,assert,capture,'settings');
 await capture('settings');
}
