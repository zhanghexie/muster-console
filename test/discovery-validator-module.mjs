import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), root=process.cwd();
const tmp=fs.mkdtempSync(path.join(root,'.tmp','discovery-validator-'));
try {
  const output=path.join(tmp,'validator.cjs');
  await require('esbuild').build({entryPoints:[path.join(root,'src/main/capabilities/validateArguments.ts')],outfile:output,
    bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',logLevel:'silent'});
  // A static import becomes require() and throws ERR_PACKAGE_PATH_NOT_EXPORTED
  // in the real main bundle; this loads the same CommonJS shape before any UI.
  const {validateDiscoveredArguments}=require(output);
  const schema={type:'object',properties:{text:{type:'string'}},required:['text']};
  assert.deepEqual(await validateDiscoveredArguments('example',schema,{text:'hello'}),{text:'hello'});
  await assert.rejects(validateDiscoveredArguments('example',schema,{}),/text/);
  assert.ok(!/require\(["']@earendil-works\/pi-ai\/utils\/validation/.test(fs.readFileSync(output,'utf8')));
  console.log('discovery-validator-module: OK (production CommonJS load, ESM-only dependency, schema rejection)');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
