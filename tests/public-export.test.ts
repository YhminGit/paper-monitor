import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublicLibrary, exportPublicLibrary, safePublicUrl } from '../src/public-export.js';
import type { Library, Paper } from '../src/types.js';

const now='2026-09-06T00:00:00Z';
const article='https://learning-analytics.info/index.php/JLA/article/view/1234';
const oai='https://learning-analytics.info/index.php/JLA/oai?verb=ListRecords&metadataPrefix=oai_dc&from=2025-01-01';
const ccby='https://creativecommons.org/licenses/by/4.0/';
function paper(overrides:Partial<Paper>={}):Paper {
 return {id:'doi:10.18608/jla.2025.1234',doi:'10.18608/jla.2025.1234',aliases:[],journalId:'jla',title:'Learning analytics for educational feedback',authors:['A. Researcher'],url:article,keywords:['learning analytics'],articleType:'journal-article',abstract:'An original author abstract with explicit source attribution.',abstractSource:article,publicationDate:{value:'2025-02',precision:'month',source:'publisher'},firstSeenAt:now,updatedAt:now,relevance:{topic:'learning-analytics',method:'codex',confidence:'high',reason:'Private reviewed excerpt.',evidence:['Private quoted source text.'],reviewedAt:now,reviewedFingerprint:'private-fingerprint'},oaLocations:[{url:article,hostType:'publisher',isOa:true,license:ccby,version:'publishedVersion',source:'JLA OAI rights'}],pdf:{status:'unavailable'},milestones:[{kind:'online',date:'2025-02',observedAt:now,runId:'private-run-id'}],provenance:[{source:'jla-oai',url:oai,fetchedAt:now}],...overrides};
}
function library(papers:Paper[]=[paper()]):Library {
 return {schemaVersion:1,generatedAt:now,coverageStart:'2025-01-01',lastRunId:'private-run-id',journals:[{id:'jla',name:'Journal of Learning Analytics',shortName:'JLA',issn:'1929-7750',publisher:'jla',url:'https://learning-analytics.info/index.php/JLA',feeds:[oai]}],papers,sources:[{journalId:'jla',status:'partial',checkedAt:now,lastSuccessAt:now,discovered:papers.length,errors:['Private credential and filesystem diagnostic']}]};
}

test('safePublicUrl rejects private, signed, credential-bearing, and non-web URLs',()=>{
 for(const url of ['file:///C:/private/library.json','javascript:alert(1)','data:text/html,bad','http://127.0.0.1:3000/api/papers','https://localhost/a','https://[::1]/a','https://10.0.0.1/a','https://192.0.2.1/a','https://printer.local/a','https://127.0.0.1.nip.io/a','https://user:pass@example.org/a','https://example.org:8443/a','https://example.org/a?token=one','https://example.org/a?X-Amz-Signature=signed','https://example.org/a?AWSAccessKeyId=private','https://example.org/a?unknown=private','https://example.org/a#access_token=private','https://example.org/token/private','https://example.org/a?download=C%3A%2Fprivate%2Ffile','https://example.org/\nscript'])assert.equal(safePublicUrl(url),undefined,url);
 assert.equal(safePublicUrl(article),article);
 assert.equal(safePublicUrl('https://example.org/paper.pdf#page=2'),'https://example.org/paper.pdf#page=2');
 assert.equal(safePublicUrl('https://example.org/article?dgcid=rss_sd_all'),'https://example.org/article');
 assert.equal(safePublicUrl('http://example.org/article'),'http://example.org/article');
 assert.equal(safePublicUrl(oai),oai);
});

test('the public snapshot uses an explicit field allowlist with no private metadata',async()=>{
 const p=paper();
 p.aliases=['PRIVATE_ALIAS'];p.provenance.push({source:'PRIVATE_SOURCE',url:'file:///C:/PRIVATE_PATH/record',fetchedAt:now});
 p.pdf={status:'downloaded',path:'C:\\PRIVATE_PATH\\paper.pdf',sourceUrl:'https://example.org/paper.pdf',sha256:'PRIVATE_HASH',bytes:123456,error:'PRIVATE_ERROR',attemptedAt:now};
 p.publicationDate!.source='C:\\PRIVATE_DATE_SOURCE';
 const input=library([p]) as Library&{credentials:unknown;privateState:unknown};
 input.credentials={apiKey:'PRIVATE_KEY'};input.privateState='PRIVATE_STATE';
 const result=await createPublicLibrary(input,'unused-output');
 const serialized=JSON.stringify(result);
 for(const secret of ['PRIVATE_','private-run-id','private-fingerprint','Private reviewed excerpt','Private quoted source text','Private credential'])assert.ok(!serialized.includes(secret),secret);
 assert.equal(result.lastRunId,undefined);
 assert.deepEqual(result.papers[0].aliases,[]);
 assert.deepEqual(result.papers[0].provenance,[]);
 assert.deepEqual(result.journals[0].feeds,[]);
 assert.deepEqual(result.papers[0].relevance.evidence,[]);
 assert.equal(result.papers[0].publicationDate?.source,'Publication metadata');
 assert.deepEqual(result.papers[0].pdf,{status:'unavailable',sourceUrl:'https://example.org/paper.pdf',license:undefined,version:undefined});
 assert.equal(result.papers[0].milestones[0].runId,undefined);
 assert.deepEqual(result.sources[0].errors,['Some source checks were unavailable.']);
 assert.equal(result.sources[0].lastSuccessAt,now);
 assert.equal(result.papers[0].oaLocations[0].source,'Public OA metadata');
});

test('same-paper official publisher and JLA OAI licences permit attributed author abstracts',async()=>{
 for(const abstractSource of [article,oai]) {
  const result=await createPublicLibrary(library([paper({abstractSource})]),'unused-output');
  const exported=result.papers[0];
  assert.equal(exported.abstract,paper().abstract);
  assert.equal(exported.abstractSource,abstractSource);
  assert.deepEqual(exported.authors,['A. Researcher']);
  assert.deepEqual(exported.publicContent,{abstract:'licensed',license:ccby});
 }
 const p=paper({abstractSource:'https://bera-journals.onlinelibrary.wiley.com/feed/14678535/most-recent',url:'https://bera-journals.onlinelibrary.wiley.com/doi/10.1111/bjet.12345',doi:'10.1111/bjet.12345'});
 p.provenance=[{source:'publisher-rss',url:p.abstractSource!,fetchedAt:now}];p.oaLocations=[{url:p.url,hostType:'publisher',isOa:true,license:'CC BY-SA 4.0',source:'publisher-license'}];
 const input=library([p]);input.journals[0].publisher='wiley';
 assert.equal((await createPublicLibrary(input,'unused-output')).papers[0].publicContent?.abstract,'licensed');
});

test('only exact supported CC licences authorize abstract export',async()=>{
 for(const license of ['cc-by','CC BY-SA','cc0','CC-BY-3.0','CC0-1.0',ccby,'http://creativecommons.org/licenses/by-sa/4.0/','https://creativecommons.org/publicdomain/zero/1.0/']) {
  const p=paper();p.oaLocations[0].license=license;
  assert.equal((await createPublicLibrary(library([p]),'unused-output')).papers[0].publicContent?.abstract,'licensed',license);
 }
 for(const license of [undefined,'','open access','free to read','CC BY-NC','CC BY-ND','CC BY-NC-ND','cc-by-ish','https://creativecommons.org/licenses/by-nc/4.0/','https://creativecommons.org/licenses/by/4.0/extra','https://creativecommons.org.evil.example/licenses/by/4.0/']) {
  const p=paper();p.oaLocations[0].license=license;
  const exported=(await createPublicLibrary(library([p]),'unused-output')).papers[0];
  assert.equal(exported.abstract,undefined,license);
  assert.equal(exported.publicContent?.abstract,'withheld',license);
 }
});

test('unrelated repository licences, different articles, and missing provenance cannot license publisher abstracts',async()=>{
 const repository=paper();repository.oaLocations=[{url:'https://repository.example.org/accepted',pdfUrl:'https://repository.example.org/accepted.pdf',hostType:'repository',isOa:true,license:ccby,source:'repository'}];
 const different=paper();different.oaLocations[0].url=article.replace('1234','9999');
 const provenance=paper({provenance:[]});
 const closed=paper();closed.oaLocations[0].isOa=false;
 const authorless=paper({authors:[]});
 for(const p of [repository,different,provenance,closed,authorless]) {
  const exported=(await createPublicLibrary(library([p]),'unused-output')).papers[0];
  assert.equal(exported.abstract,undefined);
  assert.equal(exported.abstractSource,undefined);
  assert.equal(exported.publicContent?.abstract,'withheld');
 }
 for(const abstractSource of ['https://api.openalex.org/works/W1234','https://api.crossref.org/works/10.18608%2Fjla.2025.1234']) {
  const exported=(await createPublicLibrary(library([paper({abstractSource})]),'unused-output')).papers[0];
  assert.equal(exported.abstract,undefined,'aggregator availability must not imply reuse permission');
 }
});

test('JLA Crossref abstracts require exact DOI provenance and article-specific official OAI CC BY 4.0 rights',async()=>{
 const crossref='https://api.crossref.org/works/10.18608%2Fjla.2025.1234';
 const approved=paper({abstractSource:crossref,provenance:[...paper().provenance,{source:'crossref',url:crossref,fetchedAt:now}]});
 const exported=(await createPublicLibrary(library([approved]),'unused-output')).papers[0];
 assert.equal(exported.abstract,approved.abstract);
 assert.equal(exported.abstractSource,crossref,'keep actual metadata provenance, not an invented publisher source');
 assert.deepEqual(exported.publicContent,{abstract:'licensed',license:ccby});
 assert.deepEqual(exported.authors,approved.authors);
 const noOai=structuredClone(approved);noOai.provenance=noOai.provenance.filter(item=>item.source!=='jla-oai');
 const noCrossref=structuredClone(approved);noCrossref.provenance=noCrossref.provenance.filter(item=>item.source!=='crossref');
 const wrongVersion=structuredClone(approved);wrongVersion.oaLocations[0].version='acceptedVersion';
 const noRights=structuredClone(approved);noRights.oaLocations[0].source='Unverified metadata';
 const wrongLicense=structuredClone(approved);wrongLicense.oaLocations[0].license='cc-by';
 const otherArticle=structuredClone(approved);otherArticle.oaLocations[0].url=article.replace('1234','9999');
 for(const p of [{...approved,doi:'10.18608/jla.2025.9999'},{...approved,abstractSource:crossref+'?id=other'},{...approved,abstractSource:'https://api.openalex.org/works/W1234'},noOai,noCrossref,wrongVersion,noRights,wrongLicense,otherArticle]) {
  const withheld=(await createPublicLibrary(library([p]),'unused-output')).papers[0];
  assert.equal(withheld.abstract,undefined);
  assert.equal(withheld.publicContent?.abstract,'withheld');
 }
});

test('configured credentials and filesystem paths are removed even from bibliographic text',async()=>{
 const oldKey=process.env.ELSEVIER_API_KEY,oldEmail=process.env.CONTACT_EMAIL;
 process.env.ELSEVIER_API_KEY='sensitive/private+key';process.env.CONTACT_EMAIL='private+user@example.org';
 try {
  const p=paper({title:`Title ${process.env.ELSEVIER_API_KEY}`,authors:[`Person ${encodeURIComponent(process.env.CONTACT_EMAIL)}`],keywords:['C:\\PRIVATE_DIRECTORY\\local.env'],url:`https://example.org/paper?api_key=${encodeURIComponent(process.env.ELSEVIER_API_KEY)}`});
  const output=JSON.stringify(await createPublicLibrary(library([p]),'unused-output'));
  assert.ok(!output.includes('sensitive'));
  assert.ok(!output.includes('private%2Buser'));
  assert.ok(!output.includes('PRIVATE_DIRECTORY'));
  assert.ok(!output.includes('local.env'));
  assert.ok(output.includes('[redacted]'));
 }finally{if(oldKey===undefined)delete process.env.ELSEVIER_API_KEY;else process.env.ELSEVIER_API_KEY=oldKey;if(oldEmail===undefined)delete process.env.CONTACT_EMAIL;else process.env.CONTACT_EMAIL=oldEmail;}
});

test('generated summaries require the exact registered source, checksum, extracted text, and separate provenance fields',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'paper-public-summary-'));
 try {
  await mkdir(path.join(root,'pdf'));const bytes=Buffer.from('previously validated downloaded PDF fixture');
  await writeFile(path.join(root,'pdf','paper.pdf'),bytes);await writeFile(path.join(root,'pdf','paper.pdf.txt'),'Verified full text content. '.repeat(30));
  const p=paper({abstract:undefined,abstractSource:undefined,summary:Array.from({length:160},(_,i)=>`summary${i}`).join(' '),summarySource:'https://repository.example.org/paper.pdf',summaryGeneratedAt:now,pdf:{status:'downloaded',path:'pdf/paper.pdf',sourceUrl:'https://repository.example.org/paper.pdf',sha256:createHash('sha256').update(bytes).digest('hex')}});
  let exported=(await createPublicLibrary(library([p]),root)).papers[0];
  assert.equal(exported.summary,p.summary);
  assert.equal(exported.abstract,undefined);
  assert.equal(exported.summarySource,p.summarySource);
  assert.equal(exported.summaryGeneratedAt,now);
  assert.equal(exported.publicContent?.abstract,'unavailable');
  for(const overrides of [{summarySource:'https://repository.example.org/another.pdf'},{summaryGeneratedAt:undefined},{summary:'Too short'},{pdf:{...p.pdf,sha256:'wrong'}}]) {
   exported=(await createPublicLibrary(library([{...p,...overrides}]),root)).papers[0];
   assert.equal(exported.summary,undefined);
  }
  await writeFile(path.join(root,'pdf','paper.pdf.txt'),'');
  assert.equal((await createPublicLibrary(library([p]),root)).papers[0].summary,undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('public export writes only atomic snapshot and overview, and invalid archives preserve previous files',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'paper-public-export-'));
 try {
  await mkdir(path.join(root,'output','reports'),{recursive:true});
  await writeFile(path.join(root,'output','reports','latest.md'),'PRIVATE FULL LOCAL REPORT');
  await writeFile(path.join(root,'output','library.json'),JSON.stringify(library()));
  const result=await exportPublicLibrary(root);
  assert.equal(result.paperCount,1);assert.equal(result.licensedAbstracts,1);
  assert.equal(result.libraryPath,path.join(root,'public-site','data','library.json'));
  assert.deepEqual((await readdir(path.join(root,'public-site','data'))).sort(),['latest.md','library.json']);
  const snapshot=await readFile(result.libraryPath,'utf8'),report=await readFile(result.overviewPath,'utf8');
  assert.equal(result.contents['public-site/data/library.json'],snapshot);
  assert.equal(result.contents['public-site/data/latest.md'],report);
  assert.ok(!report.includes('PRIVATE FULL LOCAL REPORT'));
  assert.match(report,/1 relevant papers/);
  assert.ok(!report.includes(paper().abstract!));
  await writeFile(path.join(root,'output','library.json'),'{broken');
  await assert.rejects(exportPublicLibrary(root));
  assert.equal(await readFile(result.libraryPath,'utf8'),snapshot);
  assert.equal(await readFile(result.overviewPath,'utf8'),report);
  for(const invalid of [{schemaVersion:2},library([paper(),paper()]),{...library(),papers:[{...paper(),publicationDate:{value:'2025-02-31',precision:'day',source:'bad'}}]}])await assert.rejects(createPublicLibrary(invalid,path.join(root,'output')));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('public export refuses destination directory symlinks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'paper-public-symlink-'));
 try {
  await mkdir(path.join(root,'output'));await mkdir(path.join(root,'private'));
  await writeFile(path.join(root,'output','library.json'),JSON.stringify(library()));
  await symlink(path.join(root,'private'),path.join(root,'public-site'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(exportPublicLibrary(root),/symlink/);
  assert.deepEqual(await readdir(path.join(root,'private')),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('generated summaries cannot use a PDF directory symlink into private files',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'paper-public-source-link-'));
 try {
  await mkdir(path.join(root,'output'));await mkdir(path.join(root,'private'));
  const bytes=Buffer.from('Private file that must not be treated as a registered source');
  await writeFile(path.join(root,'private','source.pdf'),bytes);await writeFile(path.join(root,'private','source.pdf.txt'),'Private extracted content. '.repeat(30));
  await symlink(path.join(root,'private'),path.join(root,'output','pdf'),process.platform==='win32'?'junction':'dir');
  const p=paper({abstract:undefined,abstractSource:undefined,summary:'Generated text. '.repeat(80),summarySource:'https://example.org/source.pdf',summaryGeneratedAt:now,pdf:{status:'downloaded',path:'pdf/source.pdf',sourceUrl:'https://example.org/source.pdf',sha256:createHash('sha256').update(bytes).digest('hex')}});
  assert.equal((await createPublicLibrary(library([p]),path.join(root,'output'))).papers[0].summary,undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('unrelated and excluded publications do not enter the public library',async()=>{
 const input=library([paper(),paper({id:'pending',relevance:{topic:'pending',method:'codex',confidence:'low',reason:'Private',evidence:[]}}),paper({id:'editorial',title:'Editorial: Learning analytics'})]);
 assert.deepEqual((await createPublicLibrary(input,'unused-output')).papers.map(p=>p.id),[paper().id]);
});
