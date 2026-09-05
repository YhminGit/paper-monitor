import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fairDownloadQueue,needsReview,reviewFingerprint,validateSummarySource} from '../src/monitor.js';
import {extractAuthorAbstract} from '../src/downloads.js';
import {isAvailabilityNote,reconstructAbstract} from '../src/enrichment.js';
import type {Paper} from '../src/types.js';
const make=(id:string,journalId='jla'):Paper=>({id,journalId,doi:'10.1/'+id,title:'Research '+id,authors:[],aliases:[],url:'https://example.org/'+id,keywords:[],articleType:'journal-article',firstSeenAt:'2025-01-01',updatedAt:'2025-01-01',relevance:{topic:'ai',method:'codex',confidence:'medium',reason:'Reviewed title',evidence:[]},pdf:{status:'pending'},oaLocations:[],provenance:[],milestones:[]});
test('new author abstracts trigger revised semantic review without endlessly queuing unchanged decisions',()=>{
 const p=make('one');p.relevance.reviewedFingerprint=reviewFingerprint(p);
 assert.equal(needsReview(p),false);p.abstract='New evidence of learning analytics using AI.';assert.equal(needsReview(p),true);
 p.relevance.reviewedFingerprint=reviewFingerprint(p);assert.equal(needsReview(p),false);
});
test('download batches rotate through journals instead of starving smaller collections',()=>{
 const papers=[make('a'),make('b'),make('c'),make('d','bjet'),make('e','caeai')];
 assert.deepEqual(fairDownloadQueue(papers).map(p=>p.id),['a','d','e','b','c']);
 assert.deepEqual(papers.map(p=>p.id),['a','b','c','d','e']);
});
test('PDF abstract recovery requires explicit boundaries and labels the actual source page',()=>{
 const abstract=Array.from({length:70},(_,i)=>'word'+i).join(' ')+'.';
 assert.deepEqual(extractAuthorAbstract('[Page 1]\nHighlights\n[Page 2]\nA B S T R A C T '+abstract+' 1. Introduction More text.'),{abstract,page:2});
 assert.equal(extractAuthorAbstract('ABSTRACT '+abstract),undefined);
 assert.equal(extractAuthorAbstract('Abstract A short note. 1. Introduction'),undefined);
});
test('repository availability notes never masquerade as author abstracts',()=>{
 assert.equal(isAvailabilityNote('Contains fulltext : 324977.pdf (Publisher’s version ) (Open Access)'),true);
 assert.equal(reconstructAbstract({Contains:[0],fulltext:[1],':':[2],'324977.pdf':[3]}),undefined);
 assert.equal(isAvailabilityNote('Our study contains fulltext analysis of student essays.'),false);
});
test('generated summary provenance requires a registered checksum and actual extracted text',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'paper-summary-test-'));
 try {
  await mkdir(path.join(root,'pdf'));const bytes=Buffer.from('%PDF-1.7 registered validation fixture %%EOF');
  await writeFile(path.join(root,'pdf','paper.pdf'),bytes);await writeFile(path.join(root,'pdf','paper.pdf.txt'),'Verified extracted text. '.repeat(20));
  const p=make('p');p.pdf={status:'downloaded',path:'pdf/paper.pdf',sourceUrl:'https://example.org/paper.pdf',sha256:createHash('sha256').update(bytes).digest('hex')};
  await validateSummarySource(p,root);
  await assert.rejects(validateSummarySource({...p,pdf:{...p.pdf,sourceUrl:undefined}},root),/source URL/);
  await assert.rejects(validateSummarySource({...p,pdf:{...p.pdf,sha256:'wrong'}},root),/checksum/);
  await writeFile(path.join(root,'pdf','paper.pdf.txt'),'');await assert.rejects(validateSummarySource(p,root),/nonempty/);
 } finally {await rm(root,{recursive:true,force:true});}
});
