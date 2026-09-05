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
 const provenance=new Map<string,Paper['provenance'][number]>();
 for(const item of [...old.provenance,...incoming.provenance]) {
  const key=item.source+':'+item.url,previous=provenance.get(key);
  if(item.source==='crossref'&&previous&&Date.parse(previous.fetchedAt)>Date.parse(item.fetchedAt))continue;
  provenance.set(key,item);
 }
 result.provenance=[...provenance.values()];
 // A fresh Crossref record replaces its licence set, including an explicit empty set.
 // Feed/enrichment updates without licence metadata must not erase existing proofs.
 const resultDoi=result.doi?normalizeDoi(result.doi):undefined;
 if(old.licenses!==undefined||incoming.licenses!==undefined) {
  const sourceUrl=resultDoi?`https://api.crossref.org/works/${encodeURIComponent(resultDoi)}`:undefined;
  const freshness=(paper:Paper)=>Math.max(0,...paper.provenance.filter(item=>item.source==='crossref'&&item.url===sourceUrl).map(item=>Date.parse(item.fetchedAt)||0));
  const useIncoming=incoming.licenses!==undefined&&incoming.doi&&normalizeDoi(incoming.doi)===resultDoi&&freshness(incoming)>=freshness(old);
  const evidence=useIncoming?incoming.licenses!:old.licenses||[];
  result.licenses=evidence.filter(license=>resultDoi&&normalizeDoi(license.doi)===resultDoi);
 }
 if(incoming.abstractRetrieval&&(!old.abstractRetrieval||Date.parse(incoming.abstractRetrieval.checkedAt)>=Date.parse(old.abstractRetrieval.checkedAt)))result.abstractRetrieval=incoming.abstractRetrieval;
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
