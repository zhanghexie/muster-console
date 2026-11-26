import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const root=new URL('../',import.meta.url);
for(const file of ['KnowledgeCenter','KnowledgePanel','KnowledgeHistory','KnowledgeGovernance','MemoryOverview','MemoryProcessingView','MemoryIntentTab','MemoryCuratorView','settings/MemoryPane']){
 const source=ts.createSourceFile(file,fs.readFileSync(new URL(`src/renderer/src/components/${file}.tsx`,root),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 function visit(node){
  if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&ts.isIdentifier(node.tagName)){
   const tag=node.tagName.text;
   assert.notEqual(tag,'select',`${file}: use CustomSelect`);
   if(tag==='input'||tag==='textarea'){
    const attrs=node.attributes.properties;
    const type=attrs.find(a=>ts.isJsxAttribute(a)&&a.name.text==='type')?.initializer;
    if(type&&ts.isStringLiteral(type)&&['checkbox','radio'].includes(type.text))return;
    const cls=attrs.find(a=>ts.isJsxAttribute(a)&&a.name.text==='className')?.initializer;
    assert.ok(cls&&ts.isStringLiteral(cls)&&/(?:^|\s)(?:ui-input|s-input)(?:\s|$)/.test(cls.text),`${file}: ${tag} must use the existing input skin`);
   }
  }
  ts.forEachChild(node,visit);
 }
 visit(source);
}
const css=fs.readFileSync(new URL('src/renderer/src/styles/memory.css',root),'utf8');
for(const [,selector,body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
 if(!/\.knowledge-/.test(selector)||!/(?:\binput\b|\btextarea\b|\.ui-input|\.c-select-trigger)/.test(selector))continue;
 assert.doesNotMatch(body,/(?:^|;)\s*(?:background(?:-\w+)?|color|border(?:-\w+)?|padding(?:-\w+)?|box-shadow|outline(?:-\w+)?|font(?:-\w+)?)\s*:/,'memory controls own layout, not a parallel skin');
}
console.log('memory-control-contract: all memory inputs and dropdowns use shared controls');
