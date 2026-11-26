import fs from 'node:fs';
import {waitFor} from '@testing-library/react';

const html=fs.readFileSync('resources/extensions/daily-report/ui/panel.html','utf8');
const script=html.match(/<script>\s*([\s\S]*?)<\/script>/)![1];
let dom:{window:Window & typeof globalThis;remove:()=>void};
afterEach(()=>dom?.remove());
function mount(read:(day:string)=>Promise<{content:string}>,list:()=>Promise<{dates:string[]}>=async()=>({dates:[]})){
  const iframe=document.createElement('iframe');document.body.append(iframe);
  dom={window:iframe.contentWindow as Window & typeof globalThis,remove:()=>iframe.remove()};
  dom.window.document.open();dom.window.document.write(html.replace(/<script[\s\S]*?<\/script>/g,''));dom.window.document.close();
  const ma={ready:Promise.resolve({extId:'daily-report'}),journal:{read:vi.fn(read),list:vi.fn(list)},
    llm:{chat:vi.fn(async(_messages:Array<{role:string;content:string}>)=>({text:'# 手动日报'}))},
    data:{read:vi.fn(async()=>null),write:vi.fn(async(_path:string,_content:string)=>{}),list:vi.fn(async()=>[])},
    commands:{execute:vi.fn(async()=>[])},
    fs:{list:vi.fn(async()=>[])},notify:vi.fn(async()=>{}),storage:{set:vi.fn(async()=>{})}};
  (dom.window as unknown as {ma:unknown}).ma=ma;
  new Function('document','window','ma',script)(dom.window.document,dom.window,ma);
  return ma;
}
const journal=(topic:string)=>`<!-- muster-journal:fixture:1 -->\n## [${topic}] 已完成\n- 问题：历史问题\n- 要点：真实结果\n<!-- /muster-journal:fixture -->`;
it('renders blocked and paused journal entries while hiding topic metadata',async()=>{
  mount(async()=>({content:'<!-- muster-journal:a:1 -->\n## [等待依赖] 阻塞\n<!-- muster-topic:release -->\n- 问题：缺少接口\n- 要点：等待确认\n<!-- /muster-journal:a -->\n<!-- muster-journal:b:1 -->\n## [后续安排] 搁置\n- 问题：优先级调整\n- 要点：暂缓\n<!-- /muster-journal:b -->'}));
  await waitFor(()=>expect(dom.window.document.querySelector('#detail')?.textContent).toContain('等待依赖'));
  expect(dom.window.document.querySelector('#detail')?.textContent).toContain('后续安排');
  expect(dom.window.document.querySelector('#detail')?.textContent).toContain('阻塞');
  expect(dom.window.document.querySelector('#detail')?.textContent).toContain('搁置');
  expect(dom.window.document.querySelector('#detail')?.textContent).not.toContain('muster-topic');
});
it('reads host journals, hides host metadata and switches dates through keyboard navigation',async()=>{
  const ma=mount(async day=>({content:journal(day)}));
  await waitFor(()=>expect(dom.window.document.querySelector('.entry .t')?.textContent).toContain('已完成'));
  expect(dom.window.document.querySelector('#detail')?.textContent).not.toContain('muster-journal');
  const initial=ma.journal.read.mock.calls[0][0];
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  await waitFor(()=>expect(ma.journal.read).toHaveBeenCalledTimes(2));
  const selected=ma.journal.read.mock.calls[1][0];expect(selected).not.toBe(initial);
  await waitFor(()=>expect(dom.window.document.querySelector('.entry .t')?.textContent).toContain(selected));
});
it('shows migration/read failures instead of claiming the day has no records',async()=>{
  const ma=mount(async()=>{throw new Error('迁移目标已变化');},async()=>{throw new Error('迁移校验失败');});
  await waitFor(()=>expect(dom.window.document.querySelector('#detail')?.textContent).toContain('迁移目标已变化'));
  expect(ma.notify).toHaveBeenCalledWith(expect.stringContaining('迁移校验失败'));
  expect(dom.window.document.querySelector('#detail')?.textContent).not.toContain('没有日志记录');
});
it('a late failure from the old date cannot replace a newer date',async()=>{
  let rejectOld!:(reason:Error)=>void;let count=0;
  const ma=mount(async()=>++count===1?new Promise((_resolve,reject)=>{rejectOld=reject;}):{content:journal('新日期')});
  await waitFor(()=>expect(ma.journal.read).toHaveBeenCalledTimes(1));
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  await waitFor(()=>expect(dom.window.document.querySelector('.entry .t')?.textContent).toContain('新日期'));
  rejectOld(new Error('旧日期失败'));await Promise.resolve();await Promise.resolve();
  expect(dom.window.document.querySelector('#detail')?.textContent).not.toContain('旧日期失败');
});

it('only generates the selected day after a click, including past-day regeneration',async()=>{
  const yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);
  const pastDay=`${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;
  const ma=mount(async day=>({content:journal(day)}),async()=>({dates:[pastDay]}));
  await waitFor(()=>expect(dom.window.document.querySelector('#genBtn')).not.toBeNull());
  expect(ma.llm.chat).not.toHaveBeenCalled();
  expect(dom.window.document.querySelector('#genStatus')?.textContent).toBe('当前工作区');
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  await waitFor(()=>expect(dom.window.document.querySelector('#genBtn')).not.toBeNull());
  await waitFor(()=>expect(dom.window.document.querySelector('.d-head')?.textContent).toContain(ma.journal.read.mock.calls[1][0]));
  expect(ma.llm.chat).not.toHaveBeenCalled();
  (dom.window.document.querySelector('#genBtn') as HTMLButtonElement).click();
  await waitFor(()=>expect(ma.data.write).toHaveBeenCalledWith(expect.stringMatching(/^reports\/\d{4}-\d{2}-\d{2}\.md$/),'# 手动日报'));
  expect(ma.llm.chat).toHaveBeenCalledTimes(1);
  await waitFor(()=>expect(dom.window.document.querySelector('#regenBtn')).not.toBeNull());
  (dom.window.document.querySelector('#regenBtn') as HTMLButtonElement).click();
  await waitFor(()=>expect(ma.llm.chat).toHaveBeenCalledTimes(2));
  await waitFor(()=>expect(ma.notify).toHaveBeenCalledTimes(2));
});
it('pins generation to the clicked date when navigation happens during the initial read',async()=>{
  let resolveBusy!:(value:{content:string})=>void;let count=0;
  const ma=mount(async day=>++count===2?new Promise(resolve=>{resolveBusy=resolve;}):{content:journal(day)});
  await waitFor(()=>expect(dom.window.document.querySelector('#genBtn')).not.toBeNull());
  const clickedDay=ma.journal.read.mock.calls[0][0];
  (dom.window.document.querySelector('#genBtn') as HTMLButtonElement).click();
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  await waitFor(()=>expect(ma.journal.read).toHaveBeenCalledTimes(3));
  resolveBusy({content:journal(clickedDay)});
  await waitFor(()=>expect(ma.llm.chat).toHaveBeenCalledTimes(1));
  expect(ma.data.write).toHaveBeenCalledWith(`reports/${clickedDay}.md`,'# 手动日报');
  expect(ma.llm.chat.mock.calls[0][0][1].content).toContain(`日期：${clickedDay}`);
  await waitFor(()=>expect(ma.notify).toHaveBeenCalledWith('日报已生成'));
});
