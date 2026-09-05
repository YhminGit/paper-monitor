import { mkdir, readFile, rename, writeFile, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { STATE, LIBRARY_PATH, COVERAGE_START, JOURNALS } from './config.js';
import type { Library } from './types.js';
export async function replaceFile(from:string,to:string,replace=rename,pause:(ms:number)=>Promise<unknown>=delay) {
 // Windows indexers and sync clients can briefly hold the destination open.
 // Retry atomic replacement; never remove the valid destination as a workaround.
 for(let attempt=0;;attempt++) {
  try {await replace(from,to);return;}
  catch(error) {
   if(attempt>=5||!['EPERM','EBUSY','EACCES'].includes((error as NodeJS.ErrnoException).code||''))throw error;
   await pause(100*2**attempt);
  }
 }
}
export async function atomicWrite(file: string, content: string) {
 await mkdir(path.dirname(file),{recursive:true});
 const temp = `${file}.${randomUUID()}.tmp`;
 await writeFile(temp,content,'utf8');
 try { await replaceFile(temp,file); } catch(error) { await unlink(temp).catch(()=>{}); throw error; }
}
export async function writeJson(file: string, value: unknown) { await atomicWrite(file,JSON.stringify(value,null,2)+'\n'); }
export async function readJson<T>(file: string, fallback?: T): Promise<T> {
 try { return JSON.parse(await readFile(file,'utf8')); }
 catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT' && fallback!==undefined) return fallback; throw error; }
}
export function emptyLibrary(): Library { return { schemaVersion:1,generatedAt:new Date(0).toISOString(),coverageStart:COVERAGE_START,journals:JOURNALS,papers:[],sources:JOURNALS.map(j=>({journalId:j.id,status:'never',discovered:0,errors:[]})) }; }
export async function loadLibrary() { return readJson<Library>(LIBRARY_PATH,emptyLibrary()); }
export async function withMonitorLock<T>(task: ()=>Promise<T>): Promise<T> {
 await mkdir(STATE,{recursive:true}); const file=path.join(STATE,'monitor.lock');
 let lock;
 try { lock=await open(file,'wx'); }
 catch(error) { if((error as NodeJS.ErrnoException).code==='EEXIST') throw new Error('Another monitor run owns .state/monitor.lock. Inspect its PID before using unlock.'); throw error; }
 await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
 try { return await task(); } finally { await lock.close(); await unlink(file).catch(()=>{}); }
}
