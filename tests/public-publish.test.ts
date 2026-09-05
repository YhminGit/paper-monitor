import test from 'node:test';
import assert from 'node:assert/strict';
import {blobHash,publishArtifacts,PUBLIC_FILES,type GitHubApi} from '../src/public-publish.js';
const parent='a'.repeat(40),base='b'.repeat(40),newTree='c'.repeat(40),newCommit='d'.repeat(40);
const contents=Object.fromEntries(PUBLIC_FILES.map((file,i)=>[file,`safe public artifact ${i}`]));
interface MockOptions {
 unchanged?:boolean;wrongAccount?:boolean;concurrent?:boolean;unchangedFiles?:readonly string[];
 repo?:Record<string,unknown>;ref?:Record<string,unknown>;baseSha?:string;truncated?:boolean;missingTree?:boolean;
 blobSha?:string;treeSha?:string;commitSha?:string;failAt?:number;
}
function mock(options:MockOptions={}){
  const calls:Array<{method:string;endpoint:string;data?:any}>=[];
  const api:GitHubApi=async(method,endpoint,data)=>{
    calls.push({method,endpoint,data});
    if(calls.length===options.failAt)throw new Error('Injected transport failure');
    if(endpoint==='user')return {login:options.wrongAccount?'somebody-else':'YhminGit'};
    if(endpoint==='repos/YhminGit/paper-monitor')return {full_name:'YhminGit/paper-monitor',private:false,default_branch:'master',...options.repo};
    if(endpoint.includes('/git/ref/'))return {object:{type:'commit',sha:parent},...options.ref};
    if(method==='GET'&&endpoint.includes('/git/commits/'))return {tree:{sha:options.baseSha??base}};
    if(method==='GET'&&endpoint.includes('/git/trees/'))return {truncated:options.truncated??false,tree:options.missingTree?undefined:(options.unchanged?PUBLIC_FILES:options.unchangedFiles??[]).map(file=>({path:file,mode:'100644',type:'blob',sha:blobHash(contents[file])}))};
    if(endpoint.endsWith('/git/blobs'))return {sha:options.blobSha??blobHash(data!.content)};
    if(endpoint.endsWith('/git/trees'))return {sha:options.treeSha??newTree};
    if(endpoint.endsWith('/git/commits'))return {sha:options.commitSha??newCommit};
    if(method==='PATCH'){if(options.concurrent)throw new Error('Concurrent update');return {object:{sha:newCommit}};}
    throw new Error('Unexpected request');
  };return {api,calls};
}
test('public publisher atomically changes only approved files and never forces a reference',async()=>{
  const {api,calls}=mock();const result=await publishArtifacts(contents,api);assert.equal(result.changed,true);
  const tree=calls.find(c=>c.endpoint.endsWith('/git/trees'))!.data;
  assert.equal(tree.base_tree,base);assert.deepEqual(tree.tree.map((e:any)=>e.path),[...PUBLIC_FILES]);
  assert.deepEqual(calls.at(-1)!.data,{sha:newCommit,force:false});
  assert.deepEqual(calls.find(c=>c.endpoint.endsWith('/git/commits'))!.data.parents,[parent]);
});
test('unchanged public snapshots do not create any GitHub writes',async()=>{
  const {api,calls}=mock({unchanged:true});assert.equal((await publishArtifacts(contents,api)).changed,false);assert.ok(calls.every(c=>c.method==='GET'));
});
test('public publisher rejects extra/private files before contacting GitHub',async()=>{
  const {api,calls}=mock();await assert.rejects(publishArtifacts({...contents,'.env':'private'},api),/approved/);assert.equal(calls.length,0);
});

test('public publisher rejects missing or non-string artifacts before contacting GitHub',async()=>{
 for(const input of [{[PUBLIC_FILES[0]]:contents[PUBLIC_FILES[0]]},{...contents,[PUBLIC_FILES[1]]:null}]){
  const {api,calls}=mock();await assert.rejects(publishArtifacts(input as Record<string,string>,api),/approved/);assert.equal(calls.length,0);
 }
});

test('public publisher refuses wrong destinations and private or unexpected branches without writes',async()=>{
 for(const repo of [{full_name:'YhminGit/another-repository'},{private:true},{default_branch:'main'},{private:undefined}]){
  const {api,calls}=mock({repo});await assert.rejects(publishArtifacts(contents,api),/approved deployment/);
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.method==='GET'));
 }
});

test('public publisher refuses malformed references and incomplete tree reads before writing',async()=>{
 for(const options of [{ref:{object:{type:'tag',sha:parent}}},{ref:{object:{type:'commit',sha:'invalid'}}},{baseSha:'invalid'},{truncated:true},{missingTree:true}]){
  const {api,calls}=mock(options);await assert.rejects(publishArtifacts(contents,api));assert.ok(calls.every(call=>call.method==='GET'));
 }
});

test('one-file updates preserve the remote tree and upload only changed approved bytes',async()=>{
 const {api,calls}=mock({unchangedFiles:[PUBLIC_FILES[0]]});await publishArtifacts(contents,api);
 const blobs=calls.filter(call=>call.endpoint.endsWith('/git/blobs'));
 assert.equal(blobs.length,1);assert.deepEqual(blobs[0].data,{content:contents[PUBLIC_FILES[1]],encoding:'utf-8'});
 const tree=calls.find(call=>call.endpoint.endsWith('/git/trees'))!.data;
 assert.equal(tree.base_tree,base);assert.deepEqual(tree.tree,[{path:PUBLIC_FILES[1],mode:'100644',type:'blob',sha:blobHash(contents[PUBLIC_FILES[1]])}]);
});

test('invalid or mismatched object identifiers never reach a branch update',async()=>{
 for(const options of [{blobSha:'invalid'},{blobSha:'e'.repeat(40)},{treeSha:'invalid'},{commitSha:'invalid'}]){
  const {api,calls}=mock(options);await assert.rejects(publishArtifacts(contents,api),/identifier|checksum/);
  assert.ok(calls.every(call=>call.method!=='PATCH'));
  if(options.blobSha)assert.equal(calls.filter(call=>call.endpoint.endsWith('/git/blobs')).length,1);
 }
});

test('every GitHub read or write failure stops immediately without retries or later writes',async()=>{
 // Five reads, two blobs, one tree, one commit, then the single atomic reference update.
 for(let failAt=1;failAt<=10;failAt++){
  const {api,calls}=mock({failAt});await assert.rejects(publishArtifacts(contents,api),/Injected transport failure/);
  assert.equal(calls.length,failAt);assert.equal(calls.filter(call=>call.method==='PATCH').length,failAt===10?1:0);
 }
});

test('blob checksums use Git UTF-8 byte lengths rather than JavaScript string lengths',()=>{
 assert.equal(blobHash(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
 assert.equal(blobHash('学习'),'bb1bcd9d29322e25bb928bb5a64f174e8b069f22');
});
test('public publisher refuses a different account and never retries a conflicting branch update',async()=>{
  const wrong=mock({wrongAccount:true});await assert.rejects(publishArtifacts(contents,wrong.api),/authorized/);assert.equal(wrong.calls.length,1);
  const concurrent=mock({concurrent:true});await assert.rejects(publishArtifacts(contents,concurrent.api),/Concurrent/);assert.equal(concurrent.calls.filter(c=>c.method==='PATCH').length,1);
});
