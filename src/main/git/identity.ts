import {execFile} from 'node:child_process';
import {gitCommandArgs,gitCommandEnvironment} from './gitEnvironment';
export interface GitIdentity {root:string;branch:string|null;commit:string|null}

/** Read-only identity; missing/unborn/detached states stay explicit, never guessed. */
export async function readGitIdentity(cwd:string):Promise<GitIdentity|null> {
  const run=(args:string[])=>new Promise<string|null>(resolve=>{
    execFile('git',gitCommandArgs(['--no-optional-locks',...args]),{cwd,windowsHide:true,timeout:2000,maxBuffer:8192,
      env:{...gitCommandEnvironment(),GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1'}},(error,stdout)=>resolve(error?null:stdout.trim()));
  });
  const [root,branch,commit]=await Promise.all([run(['rev-parse','--show-toplevel']),run(['symbolic-ref','--quiet','--short','HEAD']),run(['rev-parse','--verify','HEAD'])]);
  if(!root) return null;
  return {root,branch,commit};
}
