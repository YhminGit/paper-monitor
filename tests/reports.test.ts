import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReport } from '../src/reports.js';
import type { Journal, Library, Paper, RunReport } from '../src/types.js';

const journal:Journal={id:'bjet',name:'British Journal of Educational Technology',shortName:'BJET',issn:'1467-8535',publisher:'wiley',url:'https://publisher.example/journal',feeds:[]};
function paper(overrides:Partial<Paper>={}):Paper {
 return {id:'doi:10.1234/example',aliases:[],journalId:'bjet',title:'Learning analytics with artificial intelligence',authors:['Ada Lovelace'],url:'https://publisher.example/article',keywords:[],articleType:'journal-article',abstract:'A complete author abstract.',abstractSource:'https://publisher.example/article',publicationDate:{value:'2025-03',precision:'month',source:'crossref'},firstSeenAt:'2026-09-05',updatedAt:'2026-09-05',relevance:{topic:'both',method:'codex',confidence:'high',reason:'Examines both topics.',evidence:[]},oaLocations:[],pdf:{status:'unavailable'},milestones:[],provenance:[],...overrides};
}
function fixture(papers:Paper[]) {
 const library:Library={schemaVersion:1,generatedAt:'2026-09-05T12:00:00Z',coverageStart:'2025-01-01',journals:[{...journal}],sources:[],papers};
 const run:RunReport={schemaVersion:1,id:'test-run',startedAt:'2026-09-05T12:00:00Z',status:'finalized',coverageStart:'2025-01-01',backfill:false,papers,sources:[{journalId:'bjet',status:'partial',discovered:papers.length,errors:[]}],notifications:papers.map(p=>({paperId:p.id,kind:'online'})),warnings:[]};
 return {library,run};
}
function withEnvironment(values:Record<string,string>,fn:()=>void) {
 const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
 Object.assign(process.env,values);
 try{fn();}finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}

test('reports render one entry with both milestones and preserve author abstract provenance',()=>{
 const p=paper({publishedOnline:{value:'2025-01-01',precision:'day',source:'publisher'}});
 const {run,library}=fixture([p]);
 run.notifications.push({paperId:p.id,kind:'issue'});
 const output=renderReport(run,library);
 assert.equal(output.match(/^#### /gm)?.length,1);
 assert.match(output,/1 papers · 2 publication notices/);
 assert.match(output,/online, issue/);
 assert.ok(output.includes('2025\\-01\\-01'));
 assert.ok(output.includes('Author abstract:\n\nA complete author abstract\\.'));
 assert.ok(output.includes('Source: [Source](<https://publisher.example/article>)'));
 assert.ok(!output.includes('AI-generated full-text summary'));
});

test('publisher metadata cannot inject Markdown images, links, headings, or HTML',()=>{
 const payload='![track](https://tracker.example/pixel) [click](javascript:alert(1))\n# forged heading\n<img src="https://tracker.example/pixel"> &lt;script&gt;';
 const p=paper({title:payload,authors:[payload],abstract:payload,doi:payload,pdf:{status:'blocked',license:payload,version:payload},relevance:{topic:'both',method:'codex',confidence:'high',reason:payload,evidence:[]}});
 const {run,library}=fixture([p]);
 library.journals[0].name=payload;
 run.warnings=[payload];
 run.sources[0].errors=[payload];
 const output=renderReport(run,library);
 assert.ok(!output.includes('![track]'));
 assert.ok(!output.includes('[click](javascript:'));
 assert.ok(!output.includes('<img'));
 assert.ok(output.includes('&lt;img'));
 assert.ok(output.includes('&amp;lt;script&amp;gt;'));
 assert.ok(!/^# forged heading/m.test(output));
 assert.ok(output.includes('\\!\\[track\\]\\(https\\://tracker\\.example/pixel\\)'));
 const links=[...output.matchAll(/(?<!\\)\[[^\]\n]+\]\(<([^>]+)>\)/g)].map(match=>match[1]);
 assert.deepEqual(links,['https://publisher.example/article','https://publisher.example/article']);
});

test('reports permit only safe external URLs and encode destination delimiters',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,<script>alert(1)</script>','file:///C:/private/key','https://user:pass@publisher.example/paper','https://127.0.0.1/paper','https://[::1]/paper','https://localhost/paper','https://printer.local/paper','https://192.168.0.1/paper','https://publisher.example:8080/paper','https://publisher.example/\n![image](https://tracker.example/p)']) {
  const {run,library}=fixture([paper({url,abstractSource:url})]);
  const output=renderReport(run,library);
  assert.ok(output.includes('Publisher link unavailable or withheld'),url);
  assert.ok(output.includes('Source link unavailable or withheld'),url);
  assert.ok(!output.includes('[Publisher article]('),url);
 }
 const {run,library}=fixture([paper({url:'https://publisher.example/a(b)[c]?title=hello%20world'})]);
 assert.ok(renderReport(run,library).includes('[Publisher article](<https://publisher.example/a%28b%29%5Bc%5D?title=hello%20world>)'));
});

test('generated summaries are explicitly labeled and never borrow unverified provenance',()=>{
 const p=paper({abstract:undefined,abstractSource:undefined,summary:'A generated summary, not a publisher abstract.',summarySource:'https://repository.example/accepted.pdf',summaryGeneratedAt:'2026-09-05T12:00:00Z'});
 const {run,library}=fixture([p]);
 let output=renderReport(run,library);
 assert.match(output,/AI-generated full-text summary \(not the author abstract\):/);
 assert.ok(output.includes('Full-text source: [Source](<https://repository.example/accepted.pdf>)'));
 assert.ok(output.includes('Generated: 2026\\-09\\-05T12\\:00\\:00Z'));
 assert.ok(!output.includes('Author abstract:'));
 p.summarySource=undefined;p.summaryGeneratedAt=undefined;
 output=renderReport(run,library);
 assert.match(output,/Full-text source: Provenance unavailable/);
 assert.match(output,/Generation date unavailable/);
 p.abstract='Newly obtained author abstract.';
 output=renderReport(run,library);
 assert.ok(output.includes('Author abstract:'));
 assert.ok(!output.includes('AI-generated full-text summary'));
 assert.match(output,/Source: Provenance unavailable/);
});

test('PDF links use the encoded registered route, never a private filesystem path',()=>{
 withEnvironment({PAPER_MONITOR_PORT:'3123'},()=>{
  const p=paper({id:"doi:10.12/test')![bad]",pdf:{status:'downloaded',path:'C:\\private\\papers\\original.pdf',sourceUrl:'https://repository.example/p.pdf',license:'CC BY 4.0',version:'acceptedVersion'}});
  const {run,library}=fixture([p]);
  let output=renderReport(run,library);
  assert.ok(output.includes('http://127.0.0.1:3123/api/papers/doi%3A10.12%2Ftest%27%29%21%5Bbad%5D/pdf'));
  assert.ok(!output.includes('C:'));
  assert.ok(!output.includes('original.pdf'));
  assert.ok(output.includes('CC BY 4\\.0 · acceptedVersion'));
  p.pdf.status='blocked';
  output=renderReport(run,library);
  assert.ok(!output.includes('Open in library'));
 });
});

test('report notes and all article fields redact configured and query-string secrets',()=>{
 withEnvironment({ELSEVIER_API_KEY:'private/elsevier+key',OPENALEX_API_KEY:'private-openalex',CONTACT_EMAIL:'person+monitor@example.org'},()=>{
  const secret=process.env.ELSEVIER_API_KEY!;
  const encodedEmail=encodeURIComponent(process.env.CONTACT_EMAIL!);
  const p=paper({abstract:`Literal ${secret}; encoded ${encodeURIComponent(secret)}; email ${encodedEmail}`,url:`https://publisher.example/article?api_key=${secret}`,abstractSource:`https://api.example/item?mailto=${encodedEmail}`});
  const {run,library}=fixture([p]);
  run.warnings=[`Authorization: Bearer unknown-token`];
  run.sources[0].errors=[`X-ELS-APIKey: unknown-header-secret`];
  const output=renderReport(run,library);
  for(const value of [secret,encodeURIComponent(secret),encodedEmail,'unknown-token','unknown-header-secret'])assert.ok(!output.includes(value),value);
  assert.ok(output.includes('redacted'));
  assert.ok(output.includes('Publisher link unavailable or withheld'));
 });
});

test('empty runs, missing content, and compact reports remain explicit',()=>{
 const empty=fixture([]);
 const emptyOutput=renderReport(empty.run,empty.library);
 assert.match(emptyOutput,/0 papers · 0 publication notices/);
 assert.match(emptyOutput,/0 paper\(s\) in this digest/);
 const populated=fixture([paper({abstract:undefined,abstractSource:undefined})]);
 assert.match(renderReport(populated.run,populated.library),/Abstract unavailable\. Retrieval will be retried\./);
 populated.library.papers[0].abstract='DO NOT INCLUDE THE ABSTRACT IN A COMPACT REPORT';
 const compact=renderReport(populated.run,populated.library,true);
 assert.ok(compact.includes('Learning analytics with artificial intelligence'));
 assert.ok(!compact.includes('DO NOT INCLUDE'));
});
