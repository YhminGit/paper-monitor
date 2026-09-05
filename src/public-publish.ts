import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {exportPublicLibrary} from './public-export.js';

export const PUBLIC_REPOSITORY = 'YhminGit/paper-monitor';
export const PUBLIC_BRANCH = 'master';
export const PUBLIC_URL = 'https://yhmingit.github.io/paper-monitor/';
export const PUBLIC_FILES = ['public-site/data/library.json','public-site/data/latest.md'] as const;
type Json = Record<string,any>;
export type GitHubApi = (method:'GET'|'POST'|'PATCH', endpoint:string, data?:Json) => Promise<Json>;

/** gh owns authentication. No tokens, shell interpolation or credential extraction. */
const githubApi:GitHubApi = (method,endpoint,data) => new Promise((resolve,reject)=>{
  const args=['api','--hostname','github.com','--method',method,endpoint,'-H','Accept: application/vnd.github+json'];
  if(data)args.push('--input','-');
  const child=spawn('gh',args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,GH_PROMPT_DISABLED:'1'}});
  const timeout=setTimeout(()=>{
    child.kill('SIGKILL');
    reject(new Error('GitHub request timed out. Its remote result may be uncertain; inspect the branch before retrying.'));
  },45_000);
  timeout.unref();
  let stdout='';
  // Discard stderr: API/server errors can echo submitted content or account paths.
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.resume();
  child.on('error',()=>{clearTimeout(timeout);reject(new Error('GitHub CLI could not start. Install gh and sign in to the authorized account.'));});
  child.on('close',code=>{
    clearTimeout(timeout);
    if(code!==0){reject(new Error(`GitHub ${method} failed; check authentication, repository permissions or concurrent changes. No force update was used.`));return;}
    try{resolve(JSON.parse(stdout));}catch{reject(new Error('GitHub returned an unreadable response.'));}
  });
  child.stdin.on('error',()=>{});child.stdin.end(data?JSON.stringify(data):undefined);
});
function sha(value:unknown):string {
  if(typeof value!=='string'||! /^[a-f0-9]{40}$/.test(value))throw new Error('GitHub returned an invalid object identifier.');
  return value;
}
export function blobHash(content:string):string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
}

/** Publish exactly two sanitized artifacts; do not stage, commit or push local source edits. */
export async function publishArtifacts(contents:Record<string,string>,api:GitHubApi=githubApi) {
  if(Object.keys(contents).length!==PUBLIC_FILES.length||PUBLIC_FILES.some(file=>typeof contents[file]!=='string')||Object.keys(contents).some(file=>!PUBLIC_FILES.includes(file as any)))throw new Error('Only the approved public snapshot and overview may be published.');
  const account=await api('GET','user');
  if(String(account.login).toLowerCase()!=='yhmingit')throw new Error('Sign in to the authorized YhminGit GitHub account before publishing.');
  const prefix=`repos/${PUBLIC_REPOSITORY}`;
  const repo=await api('GET',prefix);
  if(repo.full_name?.toLowerCase()!==PUBLIC_REPOSITORY.toLowerCase()||repo.private!==false||repo.default_branch!==PUBLIC_BRANCH)throw new Error('Public repository or default branch differs from the approved deployment.');
  const ref=await api('GET',`${prefix}/git/ref/heads/${PUBLIC_BRANCH}`);
  if(ref.object?.type!=='commit')throw new Error('The publishing branch does not refer to a commit.');
  const parent=sha(ref.object.sha);
  const commit=await api('GET',`${prefix}/git/commits/${parent}`);
  const base=sha(commit.tree?.sha);
  const current=await api('GET',`${prefix}/git/trees/${base}?recursive=1`);
  if(current.truncated||!Array.isArray(current.tree))throw new Error('Could not inspect the complete current public tree.');
  const changes=PUBLIC_FILES.filter(file=>!current.tree.some((entry:Json)=>entry.path===file&&entry.type==='blob'&&entry.mode==='100644'&&entry.sha===blobHash(contents[file])));
  if(!changes.length)return {changed:false,commit:parent,url:PUBLIC_URL};
  const entries=[];
  for(const file of changes){
    const blob=await api('POST',`${prefix}/git/blobs`,{content:contents[file],encoding:'utf-8'});
    const blobSha=sha(blob.sha);
    if(blobSha!==blobHash(contents[file]))throw new Error('GitHub blob checksum did not match the approved public content.');
    entries.push({path:file,mode:'100644',type:'blob',sha:blobSha});
  }
  const tree=await api('POST',`${prefix}/git/trees`,{base_tree:base,tree:entries});
  const newCommit=await api('POST',`${prefix}/git/commits`,{message:'Update sanitized public research library',tree:sha(tree.sha),parents:[parent],author:{name:'YhminGit',email:'109589703+YhminGit@users.noreply.github.com'}});
  const newSha=sha(newCommit.sha);
  // A concurrent push fails safely; never overwrite another user's branch update.
  await api('PATCH',`${prefix}/git/refs/heads/${PUBLIC_BRANCH}`,{sha:newSha,force:false});
  return {changed:true,commit:newSha,url:PUBLIC_URL};
}
export async function publishPublic(root=process.cwd()) {
  const exported=await exportPublicLibrary(root);
  // Publish the exact sanitized bytes, never files another process could replace after export.
  const result=await publishArtifacts(exported.contents);
  process.stdout.write(`${result.changed?'Published a public snapshot commit; GitHub Pages deployment is now queued':'Public snapshot is unchanged'}. ${exported.paperCount} papers. ${result.url}\nCommit: ${result.commit}\n`);
  return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  publishPublic().catch(()=>{process.stderr.write('Public publishing failed. The local library remains available; check GitHub authentication/permissions and inspect the remote branch before retrying.\n');process.exitCode=1;});
}
