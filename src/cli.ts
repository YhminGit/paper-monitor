import { parseArgs } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { collect, finalize, mergeReviews } from './monitor.js';
import { loadLibrary, readJson } from './storage.js';
import { credentialStatus, STATE, JOURNALS } from './config.js';
import { safeError } from './http.js';
const {values,positionals}=parseArgs({allowPositionals:true,options:{journal:{type:'string'},since:{type:'string'},limit:{type:'string'},'enrich-limit':{type:'string'},'download-limit':{type:'string'},refresh:{type:'boolean'},help:{type:'boolean'}}});
const number=(value:string|undefined)=>{if(value===undefined)return undefined;const n=Number(value);if(!Number.isInteger(n)||n<0)throw new Error('Limits must be nonnegative integers');return n;};
try {
 const command=positionals[0]||'status';
 if(values.help||command==='help') {
  process.stdout.write('Paper Monitor\n  collect [--journal ID] [--enrich-limit 100] [--download-limit 10] [--refresh]\n  finalize RUN_ID [--download-limit 10]\n  status\n  unlock (only clears a lock whose PID is no longer alive)\nJournal IDs: '+JOURNALS.map(j=>j.id).join(', ')+'\n');
 }else if(command==='collect')await collect({journal:values.journal,since:values.since,limit:number(values.limit),enrichLimit:number(values['enrich-limit']),downloadLimit:number(values['download-limit']),refresh:values.refresh});
 else if(command==='finalize') {if(!positionals[1])throw new Error('Provide a run ID');await finalize(positionals[1],{downloadLimit:number(values['download-limit'])});}
 else if(command==='merge-reviews') {if(!positionals[1])throw new Error('Provide a run ID');await mergeReviews(positionals[1],positionals.slice(2));}
 else if(command==='status') {const library=await loadLibrary();process.stdout.write(JSON.stringify({...library,papers:undefined,paperCount:library.papers.length,credentials:credentialStatus()},null,2)+'\n');}
 else if(command==='unlock') {
  const file=path.join(STATE,'monitor.lock');const lock=await readJson<{pid:number}>(file);
  try {process.kill(lock.pid,0);throw new Error(`PID ${lock.pid} is alive; lock retained`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  await unlink(file);process.stdout.write('Removed a stale monitor lock.\n');
 }else throw new Error('Unknown command; use npm run monitor -- help');
}catch(error){process.stderr.write(safeError(error)+'\n');process.exitCode=1;}
