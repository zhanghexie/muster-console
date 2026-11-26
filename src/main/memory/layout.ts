/** Current host-owned memory layout. No legacy discovery, migration or cleanup. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const MEMORY_HOME_REL = path.join('.muster', 'memory');
export const JOURNAL_HOME_REL = path.join(MEMORY_HOME_REL, 'journal');
export const RUNTIME_HOME_REL = path.join(MEMORY_HOME_REL, 'runtime');
export function assertKnowledgeDirectory(root:string,directory:string):void {
  const base=path.resolve(root),target=path.resolve(directory),relative=path.relative(base,target);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('记忆目录越界');
  let cursor=target;
  while(cursor!==base){if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw new Error('记忆目录不能经过符号链接');cursor=path.dirname(cursor);}
  if(fs.existsSync(base)&&fs.lstatSync(base).isSymbolicLink())throw new Error('记忆控制目录不能是符号链接');
}
export function memoryPath(root:string,relative:string):string {
  const target=path.resolve(root,relative);assertKnowledgeDirectory(root,target);return target;
}
export function ensureMemoryLayout(root:string):void {
  fs.mkdirSync(memoryPath(root,MEMORY_HOME_REL),{recursive:true});
}
export function knowledgeDirectory(root:string,namespace:'worker'|'scheduler'):string {
  ensureMemoryLayout(root);return memoryPath(root,path.join(MEMORY_HOME_REL,'knowledge',namespace));
}
export function curatorDirectory(root:string,workspaceId:string):string {
  ensureMemoryLayout(root);return memoryPath(root,path.join(MEMORY_HOME_REL,'curator',createHash('sha256').update(workspaceId).digest('hex').slice(0,24)));
}
