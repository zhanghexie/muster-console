import assert from 'node:assert/strict';
import path from 'node:path';
import {dailySelection,testProfile} from './helpers/profiles.mjs';
const root=path.resolve(import.meta.dirname,'..');
const guard='capability-ui-controls.mjs';
assert.equal(testProfile(root,guard),'daily');
// Even a saturated dependency selection cannot displace the UI contract guard.
const files=[guard,...Array.from({length:25},()=> 'chat-time.mjs')];
for(const broad of [false,true]){
 const select=()=>({selected:files.slice(1),matched:files.slice(1),reason:broad?'all-config':'affected'});
 const result=dailySelection(root,files,['src/renderer/src/components/KnowledgePanel.tsx'],select);
 assert.ok(result.selected.includes(guard),'renderer changes must always run native-control guard');
 assert.ok(result.selected.length<=16);
}
const unrelated=dailySelection(root,[guard],['docs/example.md'],()=>({selected:[],matched:[],reason:'none'}));
assert.deepEqual(unrelated.selected,[]);
console.log('native-select-policy: renderer guard cannot be omitted by daily sampling');
