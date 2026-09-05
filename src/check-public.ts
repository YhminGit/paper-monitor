import {readdir,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {safePublicUrl} from './public-export.js';

const forbiddenKeys=new Set(['path','sha256','bytes','error','credentials','credentialStatus','textPath','runId','lastRunId','reviewedFingerprint']);
const privateMarker=/(?:[a-z]:[\\/](?:users|windows|temp)[\\/]|\/(?:home|Users|private|tmp|var|mnt)\/|https?:\/\/(?:127\.0\.0\.1|localhost)(?=[:/])|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})/i;
export function checkPublicSnapshot(library:any):void {
  if(library?.schemaVersion!==1||!Array.isArray(library.papers)||!Array.isArray(library.journals)||!Array.isArray(library.sources))throw new Error('Invalid public snapshot.');
  const visit=(value:any):void=>{
    if(typeof value==='string'){
      if(privateMarker.test(value))throw new Error('A private marker reached public data.');
      if(/^https?:\/\//i.test(value)&&!safePublicUrl(value))throw new Error('An unsafe URL reached public data.');
    }else if(Array.isArray(value))value.forEach(visit);
    else if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){if(forbiddenKeys.has(key))throw new Error('A private field reached public data.');visit(item);}
  };visit(library);
  if(new Set(library.papers.map((p:any)=>p.id)).size!==library.papers.length)throw new Error('Duplicate public paper.');
  for(const p of library.papers){
    if(!['both','learning-analytics','ai'].includes(p.relevance?.topic)||p.relevance.evidence?.length||p.aliases?.length||p.provenance?.length)throw new Error('Private or excluded paper metadata reached the public snapshot.');
    if(p.pdf?.status!=='unavailable')throw new Error('Local PDF state reached the public snapshot.');
    if(p.abstract&&(p.publicContent?.abstract!=='licensed'||!p.publicContent.license||!p.abstractSource||!p.authors?.length))throw new Error('A public abstract lacks licence attribution.');
    if(p.summary&&(!p.summarySource||!p.summaryGeneratedAt||p.summary.trim().split(/\s+/).length<150||p.summary.trim().split(/\s+/).length>250))throw new Error('A public summary lacks provenance.');
  }
  if(library.journals.some((j:any)=>j.feeds?.length))throw new Error('Private collection feeds reached public metadata.');
}
export async function checkPublicBuild(root=process.cwd()) {
  const directory=path.join(root,'dist-public');
  const files:string[]=[];
  async function walk(current:string){
    for(const entry of await readdir(current)){
      const file=path.join(current,entry),info=await lstat(file);
      if(info.isSymbolicLink())throw new Error('Public build must not contain symlinks.');
      if(info.isDirectory())await walk(file);else if(info.isFile())files.push(path.relative(directory,file).replace(/\\/g,'/'));else throw new Error('Unexpected public artifact.');
    }
  }await walk(directory);
  for(const file of files)if(!['index.html','data/library.json','data/latest.md'].includes(file)&&!/^assets\/index-[a-zA-Z0-9_-]+\.(?:js|css)$/.test(file))throw new Error('Unapproved file in the public deployment artifact.');
  if(!['index.html','data/library.json','data/latest.md'].every(file=>files.includes(file))||!files.some(file=>file.endsWith('.js')))throw new Error('Incomplete public build.');
  const snapshot=JSON.parse(await readFile(path.join(directory,'data/library.json'),'utf8'));checkPublicSnapshot(snapshot);
  for(const file of files.filter(file=>file.endsWith('.js')||file==='data/latest.md')){
    const content=await readFile(path.join(directory,file),'utf8');
    if(privateMarker.test(content)||content.includes('/api/'))throw new Error('A local endpoint or private marker reached the public artifact.');
  }
  return {files:files.length,papers:snapshot.papers.length};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  checkPublicBuild().then(result=>process.stdout.write(`Public artifact verified: ${result.files} approved files, ${result.papers} papers; no local endpoints or PDFs.\n`)).catch(()=>{process.stderr.write('Public artifact validation failed; do not upload the build.\n');process.exitCode=1;});
}
