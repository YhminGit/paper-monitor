import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCrossrefWork,parseCrossrefLicenses} from '../src/sources.js';
import {mergePaper} from '../src/identity.js';
import {createPublicLibrary} from '../src/public-export.js';
import type {Journal,Library,Paper} from '../src/types.js';

const doi='10.1016/j.compedu.2025.105123';
const source=`https://api.crossref.org/works/${encodeURIComponent(doi)}`;
const openalex=`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`;
const fetchedAt='2026-09-01T00:00:00.000Z',asOf='2026-09-06T00:00:00.000Z';
const ccby='https://creativecommons.org/licenses/by/4.0/';
const journal:Journal={id:'cae',name:'Computers & Education',shortName:'C&E',issn:'0360-1315',publisher:'elsevier',url:'https://www.sciencedirect.com/journal/computers-and-education',feeds:[]};
function work(license:unknown=[{URL:ccby,'content-version':'vor',start:{'date-parts':[[2025,1,1]]}}]):Paper {
 const paper=parseCrossrefWork({DOI:doi,title:['Learning analytics and artificial intelligence'],author:[{given:'A.',family:'Researcher'}],type:'journal-article',URL:`https://doi.org/${doi}`,abstract:'<jats:p>An author abstract concerning learning analytics and artificial intelligence.</jats:p>','published-online':{'date-parts':[[2025,1,1]]},license},journal,fetchedAt)!;
 paper.relevance={topic:'both',method:'codex',confidence:'high',reason:'Reviewed.',evidence:[]};
 return paper;
}
function library(paper:Paper):Library {
 return {schemaVersion:1,generatedAt:fetchedAt,coverageStart:'2025-01-01',journals:[journal],papers:[paper],sources:[{journalId:journal.id,status:'ok',discovered:1,errors:[]}]};
}
async function exported(paper:Paper,at=asOf) {return (await createPublicLibrary(library(paper),'unused-output',at)).papers[0];}
async function withheld(paper:Paper) {const result=await exported(paper);assert.equal(result.abstract,undefined);assert.equal(result.publicContent?.abstract,'withheld');assert.equal(result.publicContent?.licenseSource,undefined);}

test('Crossref captures DOI/version/date-bound licence evidence without turning it into OA locations',()=>{
 const versions=['vor','am','tdm','stm-asf',undefined];
 const paper=work(versions.map(version=>({URL:ccby,'content-version':version,start:{'date-parts':[[2025,3,4]]}})));
 assert.deepEqual(paper.licenses?.map(license=>license.appliesTo),['vor','am','tdm','stm-asf','unknown']);
 assert.deepEqual(paper.licenses?.[0],{doi,url:ccby,appliesTo:'vor',start:{value:'2025-03-04',precision:'day',source:'crossref:license-start'},source:'crossref',sourceUrl:source,fetchedAt});
 assert.deepEqual(paper.oaLocations,[]);
 const free=work([]);assert.deepEqual(free.licenses,[]);
 const freeOnly=parseCrossrefWork({DOI:doi,title:['An AI study'],URL:`https://doi.org/${doi}`,'free-to-read':true},journal,fetchedAt)!;
 assert.deepEqual(freeOnly.licenses,[]);
});

test('malformed licence start dates fail closed while omitted lifetime starts remain distinct',()=>{
 const invalid=[null,{}, {'date-parts':[[2025,2,30]]},{'date-parts':[[2025,2,30]],'date-time':'2025-02-01T00:00:00Z'}];
 for(const start of invalid)assert.deepEqual(parseCrossrefLicenses([{URL:ccby,'content-version':'vor',start}],doi,fetchedAt),[]);
 assert.equal(parseCrossrefLicenses([{URL:ccby,'content-version':'vor'}],doi,fetchedAt)[0].start,undefined);
 assert.equal(parseCrossrefLicenses([{URL:ccby,'content-version':'vor',start:{'date-time':'2025-01-02T00:00:00Z'}}],doi,fetchedAt)[0].start?.value,'2025-01-02');
 assert.deepEqual(parseCrossrefLicenses([{URL:'javascript:alert(1)','content-version':'vor'}],doi,fetchedAt),[]);
});

test('same-DOI Crossref VoR proofs license aggregator abstracts with explicit proof attribution',async()=>{
 for(const url of [ccby,'http://creativecommons.org/licenses/by-sa/4.0/','https://creativecommons.org/publicdomain/zero/1.0/']) {
  const paper=work([{URL:url,'content-version':'vor',start:{'date-parts':[[2025,1,1]]}}]);
  const result=await exported(paper);
  assert.equal(result.abstract,paper.abstract);
  assert.equal(result.abstractSource,source);
  assert.deepEqual(result.publicContent,{abstract:'licensed',license:url.replace(/^http:/,'https:'),licenseSource:source});
  assert.equal(result.licenses,undefined,'private proof history is not exported wholesale');
 }
});

test('OpenAlex exact DOI provenance can use a same-article Crossref VoR proof without unrelated OA heuristics',async()=>{
 const paper=work();paper.abstractSource=openalex;paper.provenance.push({source:'openalex',url:openalex,fetchedAt});
 assert.deepEqual(paper.oaLocations,[],'the Crossref VoR licence itself proves permitted reuse');
 const result=await exported(paper);assert.equal(result.abstract,paper.abstract);assert.equal(result.abstractSource,openalex);assert.equal(result.publicContent?.licenseSource,source);
});

test('TDM, accepted manuscripts, unknown versions, future and nonpermissive terms cannot license aggregator abstracts',async()=>{
 for(const version of ['tdm','am','stm-asf',undefined])await withheld(work([{URL:ccby,'content-version':version}]));
 for(const URL of ['https://creativecommons.org/licenses/by-nc/4.0/','https://creativecommons.org/licenses/by-nd/4.0/','https://creativecommons.org/licenses/by-nc-nd/4.0/','https://publisher.example.org/terms','https://creativecommons.org.evil.example/licenses/by/4.0/'])await withheld(work([{URL,'content-version':'vor'}]));
 await withheld(work([{URL:ccby,'content-version':'vor',start:{'date-parts':[[2026,9,7]]}}]));
 await withheld(work([]));
});

test('omitted gold-OA start applies for the article lifetime and partial starts are conservative intervals',async()=>{
 assert.ok((await exported(work([{URL:ccby,'content-version':'vor'}]))).abstract);
 assert.ok((await exported(work([{URL:ccby,'content-version':'vor',start:{'date-parts':[[2026,9,6]]}}]))).abstract);
 await withheld(work([{URL:ccby,'content-version':'vor',start:{'date-parts':[[2026,9]]}}]));
 assert.ok((await exported(work([{URL:ccby,'content-version':'vor',start:{'date-parts':[[2026,8]]}}]))).abstract);
});

test('proof and abstract identities require the same exact DOI, provider and fetched provenance',async()=>{
 const mutate:Array<(paper:Paper)=>void>=[
  paper=>{paper.licenses![0].doi='10.1016/other';},
  paper=>{paper.licenses![0].sourceUrl=source.replace('105123','999999');},
  paper=>{paper.licenses![0].sourceUrl=source+'?id=other';},
  paper=>{paper.licenses![0].sourceUrl=source.replace('api.crossref.org','api.crossref.org.evil.example');},
  paper=>{paper.licenses![0].fetchedAt='2026-09-07T00:00:00Z';},
  paper=>{paper.licenses![0].fetchedAt='2026-08-31T00:00:00Z';},
  paper=>{paper.abstractSource=source.replace('105123','999999');},
  paper=>{paper.abstractSource=source+'?id=other';},
  paper=>{paper.abstractSource=source+'#page=1';},
  paper=>{paper.abstractSource='https://api.openalex.org/works/W1234';},
  paper=>{paper.abstractSource=openalex;},
  paper=>{paper.provenance=[];},
  paper=>{paper.authors=[];},
 ];
 for(const change of mutate){const paper=work();change(paper);await withheld(paper);}
 const badOpenalex=work();badOpenalex.abstractSource=openalex.replace('105123','999999');badOpenalex.provenance.push({source:'openalex',url:badOpenalex.abstractSource,fetchedAt});await withheld(badOpenalex);
});

test('newer current VoR terms and conflicting terms prevent fallback to an older permissive licence',async()=>{
 const old={URL:ccby,'content-version':'vor',start:{'date-parts':[[2025,1,1]]}};
 const restricted={URL:'https://publisher.example.org/restricted','content-version':'vor',start:{'date-parts':[[2026,1,1]]}};
 await withheld(work([old,restricted]));
 await withheld(work([old,{...restricted,start:old.start}]));
 assert.ok((await exported(work([restricted,{...old,start:{'date-parts':[[2026,2,1]]}}]))).abstract);
 assert.ok((await exported(work([old,{...restricted,'content-version':'tdm'}]))).abstract,'TDM terms do not override the independently permitted VoR');
});

test('licence merge preserves proofs across non-Crossref updates and replaces refreshed or removed same-DOI terms',()=>{
 const old=work(),feed={...work(),licenses:undefined,provenance:[]};
 assert.deepEqual(mergePaper(old,feed).licenses,old.licenses);
 const refreshed=work([{URL:ccby,'content-version':'tdm'}]);refreshed.provenance[0].fetchedAt=asOf;refreshed.licenses![0].fetchedAt=asOf;
 assert.deepEqual(mergePaper(old,refreshed).licenses,refreshed.licenses);
 const removed={...refreshed,licenses:[]};assert.deepEqual(mergePaper(old,removed).licenses,[]);
 assert.deepEqual(mergePaper(refreshed,old).licenses,refreshed.licenses,'older saved metadata cannot restore stale permissions');
 assert.equal(mergePaper(refreshed,old).provenance.find(item=>item.source==='crossref')?.fetchedAt,asOf);
 const other={...feed,doi:'10.1016/other'};assert.deepEqual(mergePaper(old,other).licenses,[],'a DOI change cannot inherit another article licence');
});

test('newest local abstract-retrieval status survives merging but never appears in the public export',async()=>{
 const old=work();old.abstractRetrieval={checkedAt:fetchedAt,status:'partial',errors:['PRIVATE_DIAGNOSTIC']};
 const incoming=work();incoming.abstractRetrieval={checkedAt:asOf,status:'available',errors:[]};
 assert.deepEqual(mergePaper(old,incoming).abstractRetrieval,incoming.abstractRetrieval);
 assert.deepEqual(mergePaper(incoming,old).abstractRetrieval,incoming.abstractRetrieval);
 assert.deepEqual(mergePaper(old,work()).abstractRetrieval,old.abstractRetrieval);
 const result=await exported(old);assert.equal(result.abstractRetrieval,undefined);assert.ok(!JSON.stringify(result).includes('PRIVATE_DIAGNOSTIC'));
});
