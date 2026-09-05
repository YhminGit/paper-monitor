import { createHash } from 'node:crypto';
import type { Paper } from './types.js';
import { isExcluded } from './relevance.js';
export function normalizeDoi(doi: string) { return doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i,'').replace(/^doi:\s*/i,'').toLowerCase(); }
export function paperId(value: string) { return createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0,24); }
export function identityKeys(p: Paper) { return [...new Set([p.doi?`doi:${normalizeDoi(p.doi)}`:'',p.pii?`pii:${p.pii.toUpperCase()}`:'',...p.aliases,p.url?`url:${p.url}`:'',p.title?`title:${p.journalId}:${p.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')}`:''].filter(Boolean))]; }
function webProvenance(value?:string) {try {const url=new URL(value||'');return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}}
export function mergePaper(old: Paper, incoming: Paper): Paper {
 const result: Paper={...old};
 for(const key of ['doi','pii','url','volume','issue','pages'] as const) if(incoming[key]) result[key]=incoming[key];
 // Explicit publisher exclusions outrank subsequent generic bibliographic metadata.
 if(incoming.articleType&&(isExcluded({title:'',articleType:incoming.articleType})||!isExcluded({title:'',articleType:old.articleType})))result.articleType=incoming.articleType;
 const oldTitleExcluded=isExcluded({title:old.title,articleType:''});
 const incomingTitleExcluded=isExcluded({title:incoming.title,articleType:''});
 if(incomingTitleExcluded||(!oldTitleExcluded&&incoming.title.length>=old.title.length)) result.title=incoming.title;
 if(incoming.authors.length) result.authors=incoming.authors;
 result.keywords=[...new Set([...old.keywords,...incoming.keywords])];
 const improvesEqualLengthSource=incoming.abstract&&old.abstract&&incoming.abstract.length===old.abstract.length&&!webProvenance(old.abstractSource)&&webProvenance(incoming.abstractSource);
 if(incoming.abstract && (!old.abstract || incoming.abstract.length>old.abstract.length || improvesEqualLengthSource)) { result.abstract=incoming.abstract; result.abstractSource=incoming.abstractSource; }
 result.publishedOnline=old.publishedOnline&&(!incoming.publishedOnline||old.publishedOnline.value.length>incoming.publishedOnline.value.length)?old.publishedOnline:incoming.publishedOnline;
 result.publishedIssue=old.publishedIssue&&(!incoming.publishedIssue||old.publishedIssue.value.length>incoming.publishedIssue.value.length)?old.publishedIssue:incoming.publishedIssue;
 result.publicationDate=result.publishedOnline||result.publishedIssue||incoming.publicationDate||old.publicationDate;
 result.aliases=[...new Set([...identityKeys(old),...identityKeys(incoming)])];
 result.oaLocations=[...new Map([...old.oaLocations,...incoming.oaLocations].map(x=>[x.pdfUrl||x.url,x])).values()];
 result.provenance=[...new Map([...old.provenance,...incoming.provenance].map(x=>[x.source+':'+x.url,x])).values()];
 result.updatedAt=incoming.updatedAt;
 if(incoming.relevance.method==='codex'&&(old.relevance.method!=='codex'||(incoming.relevance.reviewedAt||'')>(old.relevance.reviewedAt||'')))result.relevance=incoming.relevance;
 if(incoming.pdf.status==='downloaded'&&old.pdf.status!=='downloaded')result.pdf=incoming.pdf;
 if(incoming.summary&&!old.summary){result.summary=incoming.summary;result.summarySource=incoming.summarySource;result.summaryGeneratedAt=incoming.summaryGeneratedAt;}
 result.milestones=[...new Map([...old.milestones,...incoming.milestones].map(x=>[`${x.kind}:${x.runId||x.observedAt}`,x])).values()];
 return result;
}
export function mergePapers(papers: Paper[]): Paper[] {
 const merged:Paper[]=[]; const keys=new Map<string,Paper>();
 for(const paper of papers) {
  const matches=new Set(identityKeys(paper).map(x=>keys.get(x)).filter((x):x is Paper=>!!x));
  const old=[...matches][0];
  if(!old) { merged.push(paper); for(const k of identityKeys(paper)) keys.set(k,paper); continue; }
  Object.assign(old,mergePaper(old,paper));
  for(const duplicate of [...matches].slice(1)) { Object.assign(old,mergePaper(old,duplicate)); merged.splice(merged.indexOf(duplicate),1); for(const [key,value] of keys) if(value===duplicate)keys.set(key,old); }
  for(const k of identityKeys(old)) keys.set(k,old);
 }
 return merged;
}
